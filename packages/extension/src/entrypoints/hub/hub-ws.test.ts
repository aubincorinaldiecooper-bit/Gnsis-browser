import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureFailure } from '@/vision/BrowserFrameStream'

import { HubWs, type HubWsHandlers } from './hub-ws'

/** The GNSIS end of the hub's socket. */
class FakeSocket {
	static readonly OPEN = 1
	static last: FakeSocket | null = null
	readyState = FakeSocket.OPEN
	sent: Record<string, unknown>[] = []
	#listeners = new Map<string, ((event: { data?: string }) => void)[]>()

	constructor(readonly url: string) {
		FakeSocket.last = this
	}

	addEventListener(type: string, listener: (event: { data?: string }) => void) {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
	}

	send(data: string) {
		this.sent.push(JSON.parse(data) as Record<string, unknown>)
	}

	close() {
		this.fire('close')
	}

	fire(type: string, event: { data?: string } = {}) {
		for (const listener of this.#listeners.get(type) ?? []) listener(event)
	}

	receive(message: Record<string, unknown>) {
		this.fire('message', { data: JSON.stringify(message) })
	}

	ofType(type: string) {
		return this.sent.filter((message) => message.type === type)
	}
}

function connect(handlers: Partial<HubWsHandlers>): FakeSocket {
	vi.stubGlobal('WebSocket', FakeSocket)
	vi.stubGlobal('chrome', {
		storage: { local: { get: vi.fn(async () => ({ allowAllHubConnection: true })) } },
	})
	const hub = new HubWs(
		9000,
		{
			onExecute: vi.fn(async () => ({ success: true, data: '' })),
			onBrowserAction: vi.fn(),
			onBrowserCancel: vi.fn(),
			onSessionReset: vi.fn(),
			onStop: vi.fn(),
			onCaptureStart: vi.fn(async () => ({ captureSessionId: 'gnsis-1', tabId: 17 })),
			onCaptureStop: vi.fn(async () => undefined),
			...handlers,
		},
		() => undefined
	)
	hub.connect()
	const socket = FakeSocket.last!
	socket.fire('open')
	return socket
}

describe('HubWs capture messages', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('a capture that ends on its own reaches GNSIS as capture.stopped, with why and which capture', async () => {
		let stopped: (failure: CaptureFailure) => void = () => undefined
		const socket = connect({
			onCaptureStart: async (_options, _emit, onStopped) => {
				stopped = onStopped
				return { captureSessionId: 'gnsis-1', tabId: 17 }
			},
		})
		socket.receive({ type: 'capture.start', fps: 2 })
		await vi.waitFor(() => expect(socket.ofType('capture.started')).toHaveLength(1))

		stopped({
			reason: 'failed',
			message: 'No frame arrived from the tab for 10 s.',
			capture_session_id: 'gnsis-1',
		})
		expect(socket.ofType('capture.stopped')).toEqual([
			{
				type: 'capture.stopped',
				reason: 'failed',
				message: 'No frame arrived from the tab for 10 s.',
				capture_session_id: 'gnsis-1',
			},
		])
	})

	it('a start cancelled by a stop is answered once, by the stop', async () => {
		let cancel: (error: unknown) => void = () => undefined
		const onCaptureStart = vi.fn(
			() =>
				new Promise<{ captureSessionId: string; tabId: number }>((_resolve, reject) => {
					cancel = reject
				})
		)
		const socket = connect({
			onCaptureStart,
			onCaptureStop: async () =>
				cancel(new DOMException('The capture was stopped before it started', 'AbortError')),
		})
		socket.receive({ type: 'capture.start' })
		await vi.waitFor(() => expect(onCaptureStart).toHaveBeenCalled())

		socket.receive({ type: 'capture.stop' })
		await vi.waitFor(() => expect(socket.ofType('capture.stopped')).toHaveLength(1))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(socket.ofType('capture.stopped')).toEqual([
			{ type: 'capture.stopped', reason: 'requested' },
		])
		expect(socket.ofType('capture.started')).toEqual([])
	})

	it('a start that fails is reported as failed, with the reason', async () => {
		const socket = connect({
			onCaptureStart: async () => {
				throw new Error('no eligible browser tab to capture')
			},
		})
		socket.receive({ type: 'capture.start' })
		await vi.waitFor(() => expect(socket.ofType('capture.stopped')).toHaveLength(1))
		expect(socket.ofType('capture.stopped')).toEqual([
			{ type: 'capture.stopped', reason: 'failed', message: 'no eligible browser tab to capture' },
		])
	})
})
