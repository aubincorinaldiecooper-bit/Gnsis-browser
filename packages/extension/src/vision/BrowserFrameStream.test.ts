import { afterEach, describe, expect, it, vi } from 'vitest'

import { frameSourceTab } from './FrameProvenance'
import { BrowserFrameStream, type CapturedBrowserFrame } from './BrowserFrameStream'

// TabMediaCapture talks to the offscreen sampler through chrome.runtime; a
// scripted sampler stands in for it.
function stubSampler(): { actions: string[] } {
	const actions: string[] = []
	let sample = 0
	vi.stubGlobal('chrome', {
		runtime: {
			sendMessage: vi.fn(async (message: { action: string }) => {
				actions.push(message.action)
				if (message.action !== 'sample') return { success: true }
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
	return { actions }
}

describe('BrowserFrameStream', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('streams frames on the browser clock with their tab provenance, and stops cleanly', async () => {
		const { actions } = stubSampler()
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
		expect(actions[0]).toBe('start')
		expect(actions.at(-1)).toBe('stop')
		expect(stream.sessionId).toBeNull()
	})
})
