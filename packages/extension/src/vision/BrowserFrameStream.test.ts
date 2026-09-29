import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	BrowserFrameStream,
	type CaptureFailure,
	type CapturedBrowserFrame,
	type FrameSource,
} from './BrowserFrameStream'
import { frameSourceTab } from './FrameProvenance'

interface SamplerMessage {
	action: 'start' | 'sample' | 'stop'
	payload: { sessionId: string }
}

/**
 * The offscreen sampler TabMediaCapture talks to through chrome.runtime,
 * scripted. The first `hold` starts stay pending until released, to catch a
 * stop or a newer start that arrives while a capture is still starting.
 */
function stubSampler({ hold = 0 } = {}) {
	const log: { action: string; sessionId: string }[] = []
	const held: (() => void)[] = []
	let starts = 0
	let sample = 0
	vi.stubGlobal('chrome', {
		runtime: {
			sendMessage: vi.fn(async ({ action, payload }: SamplerMessage) => {
				log.push({ action, sessionId: payload.sessionId })
				if (action === 'start' && ++starts <= hold) {
					await new Promise<void>((resolve) => held.push(resolve))
				}
				if (action !== 'sample') return { success: true }
				sample += 1
				return {
					success: true,
					imageBase64: `frame-${sample}`,
					capturedAtEpochMs: 1_790_000_000_000 + sample * 100,
					width: 640,
					height: 400,
				}
			}),
		},
	})
	// TabMediaCapture paces its sampler with window.setTimeout; Node has no window.
	vi.stubGlobal('window', globalThis)
	return {
		log,
		actions: () => log.map((entry) => entry.action),
		held: () => held.length,
		releaseStart: () => held.shift()?.(),
	}
}

/** A tab capture whose every read fails, as a lost capture's would. */
function failingSource() {
	let reads = 0
	const source = {
		start: vi.fn(async () => undefined),
		nextBatch: vi.fn(async () => {
			reads += 1
			throw new Error('tab capture lost')
		}),
		stop: vi.fn(async () => undefined),
	} satisfies FrameSource
	return { source, reads: () => reads }
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('BrowserFrameStream', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('streams frames on the browser clock with their tab provenance, and stops cleanly', async () => {
		const sampler = stubSampler()
		const frames: CapturedBrowserFrame[] = []
		const stream = new BrowserFrameStream()
		const sessionId = await stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 })
		await stream.stop()

		const [first, second] = frames
		expect(first.source).toEqual({
			kind: 'browser_tab',
			tab_id: 17,
			capture_session_id: sessionId,
			width: 640,
			height: 400,
		})
		expect(first.captured_at_ms).toBe(1_790_000_000_100)
		expect(second.captured_at_ms).toBeGreaterThan(first.captured_at_ms)
		expect(first.encoding).toBe('jpeg')
		// Registered before it left, so an action bound to it is checked against its tab.
		expect(frameSourceTab(first.frame_id)).toBe(17)
		expect(sampler.actions()[0]).toBe('start')
		expect(sampler.actions().at(-1)).toBe('stop')
		expect(stream.sessionId).toBeNull()
	})

	it('a stop that arrives while the capture is starting cancels it, and nothing keeps running', async () => {
		const sampler = stubSampler({ hold: 1 })
		const frames: CapturedBrowserFrame[] = []
		const stream = new BrowserFrameStream()
		const starting = stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		await vi.waitFor(() => expect(sampler.held()).toBe(1))

		const stopping = stream.stop()
		sampler.releaseStart()
		await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
		await stopping

		expect(sampler.actions().at(-1)).toBe('stop')
		const messages = sampler.log.length
		await later(300) // over two sampler ticks at 8 fps
		expect(sampler.log).toHaveLength(messages)
		expect(frames).toEqual([])
		expect(stream.sessionId).toBeNull()
	})

	it('a stop that arrives while the tab is being looked up cancels the capture before it starts', async () => {
		const sampler = stubSampler()
		let resolveTab: (tabId: number) => void = () => undefined
		const tab = new Promise<number>((resolve) => (resolveTab = resolve))
		const stream = new BrowserFrameStream()
		const starting = stream.start(tab, {}, () => undefined)

		await stream.stop()
		resolveTab(17)
		await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
		expect(sampler.log).toEqual([])
	})

	it('a newer start releases the capture still starting before its own begins', async () => {
		const sampler = stubSampler({ hold: 1 })
		const frames: CapturedBrowserFrame[] = []
		const stream = new BrowserFrameStream()
		const first = stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		await vi.waitFor(() => expect(sampler.held()).toBe(1))

		const second = stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		sampler.releaseStart()
		await expect(first).rejects.toMatchObject({ name: 'AbortError' })
		const secondId = await second
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), { timeout: 3_000 })
		await stream.stop()

		const firstId = sampler.log[0].sessionId
		const at = (action: string, sessionId: string) =>
			sampler.log.findIndex((entry) => entry.action === action && entry.sessionId === sessionId)
		// One capture at a time: the first is released before the second starts.
		expect(at('stop', firstId)).toBeGreaterThan(-1)
		expect(at('start', secondId)).toBeGreaterThan(at('stop', firstId))
		expect(at('stop', secondId)).toBeGreaterThan(at('start', secondId))
		expect(frames.every((frame) => frame.source.capture_session_id === secondId)).toBe(true)
	})

	it('a start right after a stop waits until the earlier capture is released', async () => {
		const sampler = stubSampler()
		const frames: CapturedBrowserFrame[] = []
		const stream = new BrowserFrameStream()
		const firstId = await stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), { timeout: 3_000 })

		const stopping = stream.stop()
		const secondId = await stream.start(17, { fps: 8 }, (frame) => frames.push(frame))
		await stopping
		await stream.stop()

		const at = (action: string, sessionId: string) =>
			sampler.log.findIndex((entry) => entry.action === action && entry.sessionId === sessionId)
		expect(at('start', secondId)).toBeGreaterThan(at('stop', firstId))
	})

	it('a capture whose reads keep failing backs off, gives up, and says why', async () => {
		const { source, reads } = failingSource()
		const failures: CaptureFailure[] = []
		const stream = new BrowserFrameStream({
			createSource: () => source,
			limits: { maxFailures: 4, backoffMs: 50, maxBackoffMs: 100 },
		})
		const sessionId = await stream.start(
			17,
			{},
			() => undefined,
			(failure) => failures.push(failure)
		)

		// It pauses after a failed read instead of retrying at once, so other work runs.
		await later(0)
		expect(reads()).toBe(1)

		await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_000 })
		expect(reads()).toBe(4)
		expect(failures[0]).toEqual({
			reason: 'failed',
			message: 'Reading frames from the tab failed 4 times in a row: tab capture lost',
			capture_session_id: sessionId,
		})
		expect(source.stop).toHaveBeenCalledTimes(1)
		expect(stream.sessionId).toBeNull()
	})

	it('a capture that delivers no frames is given up after the stall limit, and says why', async () => {
		const source = {
			start: vi.fn(async () => undefined),
			nextBatch: vi.fn(async (_count: number, options?: { timeoutMs?: number }) => {
				await later(options?.timeoutMs ?? 0)
				return []
			}),
			stop: vi.fn(async () => undefined),
		} satisfies FrameSource
		const failures: CaptureFailure[] = []
		const stream = new BrowserFrameStream({
			createSource: () => source,
			limits: { readTimeoutMs: 10, stallMs: 60 },
		})
		const sessionId = await stream.start(
			17,
			{},
			() => undefined,
			(failure) => failures.push(failure)
		)

		await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_000 })
		expect(failures[0]).toEqual({
			reason: 'failed',
			message: 'No frame arrived from the tab for 0.06 s.',
			capture_session_id: sessionId,
		})
		expect(source.stop).toHaveBeenCalledTimes(1)
	})

	it('a stop during a backoff pause ends the capture at once, without reporting a failure', async () => {
		const { source } = failingSource()
		const failures: CaptureFailure[] = []
		const stream = new BrowserFrameStream({
			createSource: () => source,
			limits: { backoffMs: 5_000 },
		})
		await stream.start(
			17,
			{},
			() => undefined,
			(failure) => failures.push(failure)
		)

		const stopping = performance.now()
		await stream.stop()
		expect(performance.now() - stopping).toBeLessThan(1_000)
		await later(20)
		expect(failures).toEqual([])
		expect(source.stop).toHaveBeenCalledTimes(1)
	})
})
