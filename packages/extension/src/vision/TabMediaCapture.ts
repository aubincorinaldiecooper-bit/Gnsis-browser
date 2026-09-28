export interface CapturedPanopticFrame {
	frameId: string
	timestampMs: number
	durationMs: number
	imageBase64: string
	width: number
	height: number
}

export interface TabMediaCaptureConfig {
	sessionId: string
	tabId: number
	taskStartedAtEpochMs: number
	fps?: number
	maxEdge?: number
	jpegQuality?: number
	maxQueuedFrames?: number
}

interface SampleResponse {
	success: boolean
	error?: string
	imageBase64?: string
	capturedAtEpochMs?: number
	width?: number
	height?: number
}

async function captureMessage(
	action: 'start' | 'sample' | 'stop',
	payload: Record<string, unknown>
): Promise<any> {
	const response = await chrome.runtime.sendMessage({
		type: 'PANOPTIC_CAPTURE',
		action,
		payload,
	})
	if (!response?.success) {
		throw new Error(response?.error || `Panoptic capture ${action} failed`)
	}
	return response
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const timeout = window.setTimeout(resolve, ms)
		signal?.addEventListener(
			'abort',
			() => {
				window.clearTimeout(timeout)
				reject(signal.reason)
			},
			{ once: true }
		)
	})
}

/**
 * Persistent tab video capture with a bounded sampled-frame queue.
 *
 * The browser tab is captured once through chrome.tabCapture and remains a live
 * MediaStream in an offscreen document. This class samples that stream at the
 * Panoptic observation rate; it does not take repeated browser screenshots.
 */
export class TabMediaCapture {
	readonly sessionId: string
	readonly tabId: number
	readonly fps: number

	private taskStartedAtEpochMs: number
	private maxEdge: number
	private jpegQuality: number
	private maxQueuedFrames: number
	private queue: CapturedPanopticFrame[] = []
	private started = false
	private stopping = false
	private pumpAbort = new AbortController()
	private pumpPromise: Promise<void> | null = null
	private lastTimestampMs = -1
	private droppedFrames = 0

	constructor(config: TabMediaCaptureConfig) {
		this.sessionId = config.sessionId
		this.tabId = config.tabId
		this.taskStartedAtEpochMs = config.taskStartedAtEpochMs
		this.fps = Math.min(8, Math.max(0.5, config.fps ?? 4))
		this.maxEdge = Math.min(1536, Math.max(448, config.maxEdge ?? 896))
		this.jpegQuality = Math.min(0.95, Math.max(0.5, config.jpegQuality ?? 0.82))
		this.maxQueuedFrames = Math.max(4, config.maxQueuedFrames ?? 16)
	}

	get queuedFrames(): number {
		return this.queue.length
	}

	get dropped(): number {
		return this.droppedFrames
	}

	async start(): Promise<void> {
		if (this.started) return
		await captureMessage('start', {
			sessionId: this.sessionId,
			tabId: this.tabId,
		})
		this.started = true
		this.stopping = false
		this.pumpAbort = new AbortController()
		this.pumpPromise = this.pump(this.pumpAbort.signal)
	}

	async nextBatch(
		count: number,
		options: { timeoutMs?: number; signal?: AbortSignal } = {}
	): Promise<CapturedPanopticFrame[]> {
		if (!this.started) await this.start()
		const wanted = Math.max(1, Math.floor(count))
		const timeoutMs = Math.max(1, options.timeoutMs ?? 2_000)
		const deadline = performance.now() + timeoutMs

		while (this.queue.length < wanted && performance.now() < deadline) {
			options.signal?.throwIfAborted()
			await sleep(Math.min(20, Math.max(1, deadline - performance.now())), options.signal)
		}

		options.signal?.throwIfAborted()
		if (this.queue.length === 0) return []
		return this.queue.splice(0, Math.min(wanted, this.queue.length))
	}

	discardBefore(timestampMs: number): void {
		this.queue = this.queue.filter((frame) => frame.timestampMs >= timestampMs)
	}

	clearQueue(): void {
		this.queue = []
	}

	async stop(): Promise<void> {
		if (!this.started || this.stopping) return
		this.stopping = true
		this.pumpAbort.abort()
		try {
			await this.pumpPromise
		} catch {
			// pump exits through AbortSignal
		}
		this.pumpPromise = null
		this.started = false
		try {
			await captureMessage('stop', { sessionId: this.sessionId })
		} finally {
			this.stopping = false
			this.queue = []
		}
	}

	private async pump(signal: AbortSignal): Promise<void> {
		const intervalMs = 1000 / this.fps
		let nextAt = performance.now()

		while (!signal.aborted) {
			const waitMs = nextAt - performance.now()
			if (waitMs > 0) await sleep(waitMs, signal)
			signal.throwIfAborted()
			const iterationStarted = performance.now()

			try {
				const response = (await captureMessage('sample', {
					sessionId: this.sessionId,
					maxEdge: this.maxEdge,
					quality: this.jpegQuality,
				})) as SampleResponse
				if (!response.imageBase64 || !response.capturedAtEpochMs) {
					throw new Error('Panoptic capture returned an incomplete frame')
				}

				const rawTimestamp = response.capturedAtEpochMs - this.taskStartedAtEpochMs
				const timestampMs = Math.max(this.lastTimestampMs + 1, rawTimestamp)
				this.lastTimestampMs = timestampMs
				this.queue.push({
					frameId: crypto.randomUUID(),
					timestampMs,
					durationMs: intervalMs,
					imageBase64: response.imageBase64,
					width: Number(response.width || 0),
					height: Number(response.height || 0),
				})

				if (this.queue.length > this.maxQueuedFrames) {
					const dropCount = this.queue.length - this.maxQueuedFrames
					this.queue.splice(0, dropCount)
					this.droppedFrames += dropCount
				}
			} catch (error) {
				if (signal.aborted) return
				console.warn('[TabMediaCapture] sample failed', error)
			}

			nextAt += intervalMs
			// If the sampler was stalled, do not burst-capture old timestamps.
			if (nextAt < performance.now() - intervalMs) {
				nextAt = iterationStarted + intervalMs
			}
		}
	}
}
