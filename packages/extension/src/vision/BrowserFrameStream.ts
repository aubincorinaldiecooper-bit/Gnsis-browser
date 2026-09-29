import {
	type CapturedPanopticFrame,
	TabMediaCapture,
	type TabMediaCaptureConfig,
} from './TabMediaCapture'

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

/** A capture that ended on its own. The hub sends it to GNSIS as `capture.stopped`. */
export interface CaptureFailure {
	reason: 'failed'
	message: string
	capture_session_id: string
}

/** What the stream needs from a tab capture: TabMediaCapture in the extension. */
export type FrameSource = Pick<TabMediaCapture, 'start' | 'nextBatch' | 'stop'>

export interface FrameStreamLimits {
	/** How long one read waits for a frame. */
	readTimeoutMs: number
	/** Reads that fail in a row before the capture is given up. */
	maxFailures: number
	/** Pause after the first failed read; it doubles with each further failure, up to maxBackoffMs. */
	backoffMs: number
	maxBackoffMs: number
	/** A capture that delivers no frame for this long is not working, and is given up. */
	stallMs: number
}

export const DEFAULT_FRAME_STREAM_LIMITS: FrameStreamLimits = {
	readTimeoutMs: 2_000,
	maxFailures: 5,
	backoffMs: 250,
	maxBackoffMs: 4_000,
	stallMs: 10_000,
}

export interface BrowserFrameStreamOptions {
	limits?: Partial<FrameStreamLimits>
	createSource?: (config: TabMediaCaptureConfig) => FrameSource
}

/**
 * One capture, from the moment it is asked for until its tab capture is released.
 *
 * It is registered before anything is awaited, so a stop, a socket close or a
 * newer start always reaches it: while the tab is being looked up, while the
 * offscreen sampler starts, and while frames are read.
 */
class CaptureSession {
	readonly abort = new AbortController()
	source: FrameSource | null = null
	opening: Promise<void> | null = null
	reading: Promise<CaptureFailure | null> | null = null
	#released: Promise<void> | null = null

	constructor(
		readonly id: string,
		/** Resolves once every capture registered before this one is released. */
		readonly after: Promise<void>
	) {}

	get cancelled(): boolean {
		return this.abort.signal.aborted
	}

	/** Stop reading, let a pending start settle, then release the tab capture. Safe to call again. */
	release(): Promise<void> {
		this.#released ??= this.#release()
		return this.#released
	}

	async #release(): Promise<void> {
		this.abort.abort(new DOMException('Capture stopped', 'AbortError'))
		await this.after
		await this.opening?.catch(() => undefined)
		await this.reading
		await this.source?.stop().catch(() => undefined)
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
 *
 * One capture runs at a time. A capture that keeps failing is not retried
 * without end: failed reads back off, and after repeated failures, or a long
 * stretch with no frame at all, the capture is released and reported through
 * `onFailure` so GNSIS hears why frames stopped.
 */
export class BrowserFrameStream {
	#session: CaptureSession | null = null
	/** Resolves once every capture set aside so far is released. */
	#lastRelease: Promise<void> = Promise.resolve()
	readonly #limits: FrameStreamLimits
	readonly #createSource: (config: TabMediaCaptureConfig) => FrameSource

	constructor(options: BrowserFrameStreamOptions = {}) {
		this.#limits = { ...DEFAULT_FRAME_STREAM_LIMITS, ...options.limits }
		this.#createSource = options.createSource ?? ((config) => new TabMediaCapture(config))
	}

	/** The capture that is starting or running, if any. */
	get sessionId(): string | null {
		return this.#session?.id ?? null
	}

	/**
	 * Start streaming a tab, releasing any earlier capture first.
	 *
	 * `tabId` may still be being looked up: the capture is registered before it
	 * resolves, so a stop that arrives meanwhile cancels it. A start cancelled by
	 * a stop or by a newer start rejects with an AbortError. `onFailure` is called
	 * if the capture later ends on its own.
	 */
	async start(
		tabId: number | Promise<number>,
		options: CaptureStartOptions,
		emit: (frame: CapturedBrowserFrame) => void,
		onFailure?: (failure: CaptureFailure) => void
	): Promise<string> {
		const previous = this.#session
		const session = new CaptureSession(
			`gnsis-${crypto.randomUUID()}`,
			previous ? previous.release() : this.#lastRelease
		)
		this.#session = session
		try {
			const tab = await tabId
			await session.after
			if (session.cancelled) throw cancelledBeforeStart()
			const source = this.#createSource({
				sessionId: session.id,
				tabId: tab,
				taskStartedAtEpochMs: 0,
				fps: options.fps ?? 2,
				maxEdge: options.max_edge ?? 1280,
				jpegQuality: options.quality ?? 0.82,
			})
			session.source = source
			session.opening = source.start()
			await session.opening
			if (session.cancelled) throw cancelledBeforeStart()
			session.reading = this.#read(session, source, tab, emit).catch((error: unknown) =>
				session.cancelled ? null : failure(session, `Frame streaming broke: ${describe(error)}`)
			)
			void session.reading.then((failed) => {
				if (!failed || this.#session !== session) return
				void this.#setAside(session).then(() => onFailure?.(failed))
			})
		} catch (error) {
			if (this.#session === session) void this.#setAside(session)
			await session.release()
			throw error
		}
		return session.id
	}

	/** Stop streaming. Resolves once the tab capture is released, including one still starting. */
	async stop(): Promise<void> {
		const session = this.#session
		if (session) await this.#setAside(session)
	}

	/** Take the current capture out of service; a later start waits until it is released. */
	#setAside(session: CaptureSession): Promise<void> {
		this.#session = null
		this.#lastRelease = session.release()
		return this.#lastRelease
	}

	async #read(
		session: CaptureSession,
		source: FrameSource,
		tabId: number,
		emit: (frame: CapturedBrowserFrame) => void
	): Promise<CaptureFailure | null> {
		const { readTimeoutMs, maxFailures, backoffMs, maxBackoffMs, stallMs } = this.#limits
		const signal = session.abort.signal
		let failures = 0
		let lastFrameAt = performance.now()
		while (!signal.aborted) {
			let frames: CapturedPanopticFrame[]
			try {
				frames = await source.nextBatch(1, { timeoutMs: readTimeoutMs, signal })
			} catch (error) {
				if (signal.aborted) return null
				failures += 1
				if (failures >= maxFailures) {
					return failure(
						session,
						`Reading frames from the tab failed ${failures} times in a row: ${describe(error)}`
					)
				}
				// Back off rather than retry at once: a read that keeps failing must not spin.
				const backoff = Math.min(maxBackoffMs, backoffMs * 2 ** (failures - 1))
				if (!(await pause(backoff, signal))) return null
				continue
			}
			if (signal.aborted) return null
			failures = 0
			if (frames.length === 0) {
				if (performance.now() - lastFrameAt >= stallMs) {
					return failure(session, `No frame arrived from the tab for ${stallMs / 1000} s.`)
				}
				continue
			}
			lastFrameAt = performance.now()
			for (const frame of frames) {
				emit({
					frame_id: frame.frameId,
					captured_at_ms: frame.timestampMs,
					encoding: 'jpeg',
					image_base64: frame.imageBase64,
					source: {
						kind: 'browser_tab',
						tab_id: tabId,
						capture_session_id: session.id,
						width: frame.width,
						height: frame.height,
					},
				})
			}
		}
		return null
	}
}

function cancelledBeforeStart(): DOMException {
	return new DOMException('The capture was stopped before it started', 'AbortError')
}

function failure(session: CaptureSession, message: string): CaptureFailure {
	return { reason: 'failed', message, capture_session_id: session.id }
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Wait `ms`, or less if the capture is stopped. Resolves true only if the whole wait passed. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false)
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer)
			resolve(false)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve(true)
		}, ms)
		signal.addEventListener('abort', onAbort, { once: true })
	})
}
