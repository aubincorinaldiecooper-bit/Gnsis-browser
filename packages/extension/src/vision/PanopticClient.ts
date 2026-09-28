import type { PanopticTemporalState } from './types'

interface ReadyMessage {
	type: 'ready'
	session_id: string
	tab_id: number
	backend: 'panoptic'
	context_rounds: number
	max_frames: number
	normal_max_pixels: number
	standby_max_pixels: number
}

interface ErrorMessage {
	type: 'error'
	reason: string
}

type ServerMessage =
	| ReadyMessage
	| PanopticTemporalState
	| ErrorMessage
	| { type: 'done'; [key: string]: unknown }

interface PendingFrame {
	resolve: (state: PanopticTemporalState) => void
	reject: (error: Error) => void
}

export interface PanopticSessionConfig {
	url?: string
	token?: string
	sessionId: string
	tabId: number
	task: string
	contextRounds?: number
	maxFrames?: number
	maxTokens?: number
	signal?: AbortSignal
}

export class PanopticClient {
	readonly url: string
	readonly sessionId: string
	readonly tabId: number

	private socket: WebSocket | null = null
	private readyPromise: Promise<ReadyMessage> | null = null
	private readyResolve: ((ready: ReadyMessage) => void) | null = null
	private readyReject: ((error: Error) => void) | null = null
	private pending = new Map<string, PendingFrame>()
	private closed = false
	private config: PanopticSessionConfig

	constructor(config: PanopticSessionConfig) {
		this.config = config
		this.url = config.url ?? 'ws://127.0.0.1:8792/v1/panoptic/stream'
		this.sessionId = config.sessionId
		this.tabId = config.tabId
	}

	async connect(): Promise<ReadyMessage> {
		if (this.readyPromise) return this.readyPromise
		if (this.closed) throw new Error('Panoptic client is closed')

		this.readyPromise = new Promise<ReadyMessage>((resolve, reject) => {
			this.readyResolve = resolve
			this.readyReject = reject
		})

		const socket = new WebSocket(this.url)
		this.socket = socket
		const signal = this.config.signal
		const abort = () =>
			this.close(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))

		if (signal?.aborted) {
			abort()
			throw signal.reason
		}
		signal?.addEventListener('abort', abort, { once: true })

		socket.addEventListener('open', () => {
			socket.send(
				JSON.stringify({
					type: 'start',
					token: this.config.token,
					session_id: this.config.sessionId,
					tab_id: this.config.tabId,
					task: this.config.task,
					context_rounds: this.config.contextRounds ?? 4096,
					max_frames: this.config.maxFrames ?? 4096,
					max_tokens: this.config.maxTokens ?? 192,
				})
			)
		})
		socket.addEventListener('message', (event) => this.handleMessage(event.data))
		socket.addEventListener('error', () => {
			this.failAll(new Error(`Panoptic websocket failed: ${this.url}`))
		})
		socket.addEventListener('close', (event) => {
			signal?.removeEventListener('abort', abort)
			if (!this.closed) {
				this.failAll(
					new Error(
						`Panoptic websocket closed (${event.code}): ${event.reason || 'no reason'}`
					)
				)
			}
		})

		return this.readyPromise
	}

	async pushFrame(input: {
		frameId: string
		epoch: number
		timestampMs: number
		durationMs: number
		imageBase64: string
	}): Promise<PanopticTemporalState> {
		await this.connect()
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error('Panoptic websocket is not open')
		}
		if (this.pending.size > 0) {
			throw new Error('Panoptic backpressure violation: a frame is still in flight')
		}

		return new Promise<PanopticTemporalState>((resolve, reject) => {
			this.pending.set(input.frameId, { resolve, reject })
			this.socket!.send(
				JSON.stringify({
					type: 'frame',
					frame_id: input.frameId,
					epoch: input.epoch,
					timestamp_ms: input.timestampMs,
					duration_ms: input.durationMs,
					image_base64: input.imageBase64,
				})
			)
		})
	}

	async end(): Promise<void> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
		this.socket.send(JSON.stringify({ type: 'end' }))
	}

	close(reason = new Error('Panoptic client closed')): void {
		if (this.closed) return
		this.closed = true
		this.failAll(reason)
		this.socket?.close(1000, 'closed')
		this.socket = null
	}

	private handleMessage(raw: unknown): void {
		try {
			const message = JSON.parse(String(raw)) as ServerMessage
			if (message.type === 'ready') {
				this.readyResolve?.(message)
				this.readyResolve = null
				this.readyReject = null
				return
			}
			if (message.type === 'error') {
				this.failAll(new Error(message.reason || 'Panoptic stream error'))
				return
			}
			if (message.type === 'temporal_state') {
				const pending = this.pending.get(message.frame_id)
				if (!pending) return
				this.pending.delete(message.frame_id)
				pending.resolve(message)
				return
			}
			if (message.type === 'done') {
				this.failPendingFrames(new Error('Panoptic stream ended'))
			}
		} catch (error) {
			this.failAll(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private failPendingFrames(error: Error): void {
		for (const { reject } of this.pending.values()) reject(error)
		this.pending.clear()
	}

	private failAll(error: Error): void {
		this.readyReject?.(error)
		this.readyResolve = null
		this.readyReject = null
		this.failPendingFrames(error)
	}
}
