import { TabMediaCapture } from './TabMediaCapture'

export interface CaptureStartOptions {
	fps?: number
	max_edge?: number
	quality?: number
}

/** One sampled tab frame, as it enters GNSIS's canonical screen.frame path. */
export interface CapturedBrowserFrame {
	frame_id: string
	captured_at_ms: number
	encoding: 'jpeg'
	image_base64: string
	source: {
		kind: 'browser_tab'
		tab_id: number
		capture_session_id: string
		width: number
		height: number
	}
}

/**
 * Streams the tab GNSIS is steering into GNSIS's own visual timeline.
 *
 * The browser keeps the capture mechanics (tabCapture, the offscreen sampler);
 * it keeps no perception history. Each frame is registered with its source tab
 * (FrameProvenance) before it leaves, so an action later bound to that frame is
 * refused if the tab it came from is no longer the one it would act on.
 * `captured_at_ms` is the browser's wall clock, the same clock the action
 * evidence uses.
 */
export class BrowserFrameStream {
	#capture: TabMediaCapture | null = null
	#abort: AbortController | null = null
	#loop: Promise<void> | null = null
	#sessionId: string | null = null

	get sessionId(): string | null {
		return this.#sessionId
	}

	async start(
		tabId: number,
		options: CaptureStartOptions,
		emit: (frame: CapturedBrowserFrame) => void
	): Promise<string> {
		await this.stop()
		const sessionId = `gnsis-${crypto.randomUUID()}`
		const capture = new TabMediaCapture({
			sessionId,
			tabId,
			taskStartedAtEpochMs: 0,
			fps: options.fps ?? 2,
			maxEdge: options.max_edge ?? 1280,
			jpegQuality: options.quality ?? 0.82,
		})
		await capture.start()
		const abort = new AbortController()
		this.#capture = capture
		this.#abort = abort
		this.#sessionId = sessionId
		this.#loop = (async () => {
			while (!abort.signal.aborted) {
				let frames: Awaited<ReturnType<TabMediaCapture['nextBatch']>> = []
				try {
					frames = await capture.nextBatch(1, { timeoutMs: 2_000, signal: abort.signal })
				} catch {
					if (abort.signal.aborted) return
				}
				for (const frame of frames) {
					emit({
						frame_id: frame.frameId,
						captured_at_ms: frame.timestampMs,
						encoding: 'jpeg',
						image_base64: frame.imageBase64,
						source: {
							kind: 'browser_tab',
							tab_id: tabId,
							capture_session_id: sessionId,
							width: frame.width,
							height: frame.height,
						},
					})
				}
			}
		})()
		return sessionId
	}

	async stop(): Promise<void> {
		const capture = this.#capture
		this.#abort?.abort(new DOMException('Capture stopped', 'AbortError'))
		this.#capture = null
		this.#abort = null
		this.#sessionId = null
		await this.#loop?.catch(() => undefined)
		this.#loop = null
		await capture?.stop().catch(() => undefined)
	}
}
