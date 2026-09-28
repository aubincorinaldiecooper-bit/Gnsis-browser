import type {
	AgentActivity,
	AgentStatus,
	ExecutionResult,
	HistoricalEvent,
} from '@page-agent/core'

import { RemotePageController } from './RemotePageController'
import { TabsController } from './TabsController'
import { LayaClient, parseVisualState } from '../vision/LayaClient'
import {
	PanopticClient,
	type PanopticTimelineEvent,
} from '../vision/PanopticClient'
import { TabMediaCapture } from '../vision/TabMediaCapture'
import { VisualActuator } from '../vision/VisualActuator'
import type { PanopticTemporalState, VisualAction, VisualState } from '../vision/types'

export interface PanopticPageAgentConfig {
	maxSteps?: number
	includeInitialTab?: boolean
	experimentalIncludeAllTabs?: boolean
	panopticUrl?: string
	panopticToken?: string
	panopticContextRounds?: number
	panopticMaxFrames?: number
	panopticFps?: number
	panopticInferFps?: number
	panopticStandbyHighResFrames?: number
	maxPerceptionSecondsPerStep?: number
	layaUrl?: string
	/**
	 * Browser-only execution cleanup. DOM stays out of Panoptic/Laya context.
	 * Disabled by default until live end-to-end validation is complete.
	 */
	actuatorTargetResolution?: boolean
	actuatorTargetResolutionRadiusPx?: number
}

/**
 * Page Agent fork runtime:
 *
 * persistent tab MediaStream -> Panoptic causal perception -> Laya bounded
 * decision -> Alibaba PageController Actuator -> timestamped action event back
 * into the same Panoptic timeline.
 */
export class PanopticPageAgent extends EventTarget {
	readonly id = crypto.randomUUID()
	readonly config: Required<Omit<PanopticPageAgentConfig, 'panopticToken'>> &
		Pick<PanopticPageAgentConfig, 'panopticToken'>

	task = ''
	taskId = ''
	history: HistoricalEvent[] = []
	disposed = false

	private statusValue: AgentStatus = 'idle'
	private abortController = new AbortController()
	private running: Promise<void> = Promise.resolve()
	private lastResultValue: ExecutionResult | null = null
	private taskStartedAtEpochMs = 0
	private temporalEpoch = 0
	private panopticByTab = new Map<number, PanopticClient>()
	private captureByTab = new Map<number, TabMediaCapture>()
	private timelineEventsByTab = new Map<number, PanopticTimelineEvent[]>()
	private lastVisual: VisualState = {
		summary: '',
		change: '',
		pageStable: false,
		targets: [],
	}

	private tabsController = new TabsController()
	private pageController = new RemotePageController(this.tabsController)
	private laya: LayaClient
	private actuator: VisualActuator

	constructor(config: PanopticPageAgentConfig = {}) {
		super()
		const sampleFps = Math.min(8, Math.max(1, config.panopticFps ?? 4))
		const inferFps = Math.min(sampleFps, Math.max(0.5, config.panopticInferFps ?? 1))
		const ratio = sampleFps / inferFps
		if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
			throw new Error('panopticFps / panopticInferFps must be a positive integer')
		}

		this.config = {
			maxSteps: config.maxSteps ?? 40,
			includeInitialTab: config.includeInitialTab ?? true,
			experimentalIncludeAllTabs: config.experimentalIncludeAllTabs ?? false,
			panopticUrl: config.panopticUrl ?? 'ws://127.0.0.1:8792/v1/panoptic/stream',
			panopticToken: config.panopticToken,
			panopticContextRounds: config.panopticContextRounds ?? 32,
			panopticMaxFrames: config.panopticMaxFrames ?? 4096,
			panopticFps: sampleFps,
			panopticInferFps: inferFps,
			panopticStandbyHighResFrames: config.panopticStandbyHighResFrames ?? 3,
			maxPerceptionSecondsPerStep: Math.max(1, config.maxPerceptionSecondsPerStep ?? 8),
			layaUrl: config.layaUrl ?? 'http://127.0.0.1:8791',
			actuatorTargetResolution: config.actuatorTargetResolution ?? false,
			actuatorTargetResolutionRadiusPx: Math.min(
				24,
				Math.max(0, config.actuatorTargetResolutionRadiusPx ?? 24)
			),
		}
		this.laya = new LayaClient({ baseUrl: this.config.layaUrl })
		this.actuator = new VisualActuator(this.pageController, this.tabsController, {
			targetResolution: this.config.actuatorTargetResolution,
			targetResolutionRadiusPx: this.config.actuatorTargetResolutionRadiusPx,
		})
	}

	get status(): AgentStatus {
		return this.statusValue
	}

	get lastResult(): ExecutionResult | null {
		return this.lastResultValue
	}

	async execute(task: string): Promise<ExecutionResult> {
		if (this.disposed) throw new Error('PageAgent has been disposed. Create a new instance.')
		if (this.statusValue === 'running') throw new Error('A task is already running.')
		if (!task.trim()) throw new Error('Task is required')

		this.task = task.trim()
		this.taskId = crypto.randomUUID()
		this.history = []
		this.lastVisual = { summary: '', change: '', pageStable: false, targets: [] }
		this.temporalEpoch = 0
		this.timelineEventsByTab.clear()
		await this.closeTemporalSessions()
		this.abortController = new AbortController()
		this.taskStartedAtEpochMs = Date.now()
		const signal = this.abortController.signal

		let resolveRunning!: () => void
		this.running = new Promise<void>((resolve) => (resolveRunning = resolve))

		this.setStatus('running')
		this.emitHistory()
		await chrome.storage.local.set({ isAgentRunning: false })

		let finalStatus: AgentStatus = 'error'
		let result: ExecutionResult = {
			success: false,
			data: 'Task stopped',
			history: this.history,
		}

		try {
			await this.tabsController.init(this.task, {
				includeInitialTab: this.config.includeInitialTab,
				experimentalIncludeAllTabs: this.config.experimentalIncludeAllTabs,
			})

			for (let step = 0; step < this.config.maxSteps; step++) {
				signal.throwIfAborted()
				await this.tabsController.syncTabs()

				const tabId = this.tabsController.currentTabId
				if (!tabId) throw new Error('No browser tab is available for Panoptic perception')
				await this.tabsController.waitUntilTabLoaded(tabId, { signal })

				this.emitActivity({ type: 'thinking' })
				const temporal = await this.observeUntilResponse(tabId, signal)

				let action: VisualAction
				if (!temporal) {
					action = { kind: 'WAIT', confidence: 1 }
				} else {
					this.lastVisual = parseVisualState(temporal.content)
					this.emitHistory({
						type: 'observation',
						content: `Panoptic: ${this.lastVisual.summary || temporal.content}`,
					})
					const tabs = await this.tabsController.snapshotTabs()
					action = await this.laya.decide(
						{ task: this.task, visual: this.lastVisual, tabs },
						signal
					)
				}

				const started = performance.now()
				const toolName = `actuator.${action.kind.toLowerCase()}`
				this.emitActivity({ type: 'executing', tool: toolName, input: action })
				const executed = await this.actuator.execute(action)
				this.emitActivity({
					type: 'executed',
					tool: toolName,
					input: action,
					output: executed.message,
					duration: performance.now() - started,
				})
				this.pushStep(step, action, executed.message)

				if (executed.done) {
					result = {
						success: true,
						data: this.lastVisual.summary || 'Task completed.',
						history: this.history,
					}
					this.lastResultValue = result
					finalStatus = 'completed'
					return result
				}

				if (action.kind !== 'WAIT') {
					this.temporalEpoch++
					const eventTimeMs = this.elapsedMs()
					this.enqueueTimelineEvent(tabId, {
						timeMs: eventTimeMs,
						content: `Actuator executed ${action.kind}: ${executed.message}`,
					})
					// Do not let already-captured pre-action frames masquerade as
					// post-action evidence.
					this.captureByTab.get(tabId)?.discardBefore(eventTimeMs)
				}
			}

			result = {
				success: false,
				data: 'Step count exceeded maximum limit',
				history: this.history,
			}
			this.lastResultValue = result
			finalStatus = 'error'
			return result
		} catch (error) {
			const aborted = signal.aborted || (error as { name?: string })?.name === 'AbortError'
			const message = aborted ? 'Task aborted' : String(error)
			this.emitActivity({ type: 'error', message })
			this.emitHistory({ type: 'error', message, rawResponse: error })
			result = { success: false, data: message, history: this.history }
			this.lastResultValue = result
			finalStatus = aborted ? 'stopped' : 'error'
			return result
		} finally {
			await this.closeTemporalSessions()
			resolveRunning()
			this.setStatus(finalStatus)
			await chrome.storage.local.set({ isAgentRunning: false }).catch(() => undefined)
		}
	}

	async stop(): Promise<void> {
		if (this.statusValue !== 'running') return
		this.abortController.abort()
		await this.closeTemporalSessions()
		await this.running
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.abortController.abort()
		void this.closeTemporalSessions()
		this.tabsController.dispose()
		void chrome.storage.local.set({ isAgentRunning: false })
		this.dispatchEvent(new Event('dispose'))
	}

	private elapsedMs(): number {
		return Math.max(0, Date.now() - this.taskStartedAtEpochMs)
	}

	private enqueueTimelineEvent(tabId: number, event: PanopticTimelineEvent): void {
		const events = this.timelineEventsByTab.get(tabId) ?? []
		events.push(event)
		this.timelineEventsByTab.set(tabId, events)
	}

	private takeEventsThrough(tabId: number, throughMs: number): PanopticTimelineEvent[] {
		const events = this.timelineEventsByTab.get(tabId) ?? []
		const ready = events.filter((event) => event.timeMs <= throughMs)
		this.timelineEventsByTab.set(
			tabId,
			events.filter((event) => event.timeMs > throughMs)
		)
		return ready
	}

	private async observeUntilResponse(
		tabId: number,
		signal: AbortSignal
	): Promise<PanopticTemporalState | null> {
		const client = await this.getPanopticSession(tabId, signal)
		const capture = await this.getCaptureSession(tabId)
		const framesPerRound = Math.round(this.config.panopticFps / this.config.panopticInferFps)
		const roundTimeoutMs = Math.ceil((framesPerRound / this.config.panopticFps) * 1500)
		const deadline = performance.now() + this.config.maxPerceptionSecondsPerStep * 1000
		let latestResponse: PanopticTemporalState | null = null

		while (performance.now() < deadline) {
			signal.throwIfAborted()
			const frames = await capture.nextBatch(framesPerRound, {
				timeoutMs: roundTimeoutMs,
				signal,
			})
			if (!frames.length) continue

			const lastFrame = frames[frames.length - 1]!
			const temporal = await client.pushBatch({
				epoch: this.temporalEpoch,
				frames: frames.map((frame) => ({
					frameId: frame.frameId,
					timestampMs: frame.timestampMs,
					durationMs: frame.durationMs,
					imageBase64: frame.imageBase64,
				})),
				events: this.takeEventsThrough(
					tabId,
					lastFrame.timestampMs + lastFrame.durationMs
				),
			})
			if (temporal.state === 'response') {
				latestResponse = temporal
				break
			}
		}

		return latestResponse
	}

	private async getPanopticSession(tabId: number, signal: AbortSignal): Promise<PanopticClient> {
		const existing = this.panopticByTab.get(tabId)
		if (existing) return existing

		const client = new PanopticClient({
			url: this.config.panopticUrl,
			token: this.config.panopticToken,
			sessionId: `${this.taskId}:${tabId}`,
			tabId,
			task: this.task,
			contextRounds: this.config.panopticContextRounds,
			maxFrames: this.config.panopticMaxFrames,
			standbyHighResFrames: this.config.panopticStandbyHighResFrames,
			signal,
		})
		await client.connect()
		this.panopticByTab.set(tabId, client)
		return client
	}

	private async getCaptureSession(tabId: number): Promise<TabMediaCapture> {
		const existing = this.captureByTab.get(tabId)
		if (existing) return existing

		const capture = new TabMediaCapture({
			sessionId: `${this.taskId}:${tabId}`,
			tabId,
			taskStartedAtEpochMs: this.taskStartedAtEpochMs,
			fps: this.config.panopticFps,
			// Keep enough source detail for the backend's Standby escalation.
			// Normal rounds are down-budgeted server-side.
			maxEdge: 896,
			maxQueuedFrames: Math.max(16, Math.round(this.config.panopticFps * 4)),
		})
		await capture.start()
		this.captureByTab.set(tabId, capture)
		return capture
	}

	private async closeTemporalSessions(): Promise<void> {
		for (const client of this.panopticByTab.values()) client.close()
		this.panopticByTab.clear()

		const captures = [...this.captureByTab.values()]
		this.captureByTab.clear()
		await Promise.allSettled(captures.map((capture) => capture.stop()))
	}

	private pushStep(step: number, action: VisualAction, output: string): void {
		this.emitHistory({
			type: 'step',
			stepIndex: step,
			reflection: {
				evaluation_previous_goal: this.lastVisual.change || undefined,
				memory: this.lastVisual.summary || undefined,
				next_goal: `Execute bounded ${action.kind} through the Actuator`,
			},
			action: {
				name: `actuator_${action.kind.toLowerCase()}`,
				input: action,
				output,
			},
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			},
		})
	}

	private setStatus(status: AgentStatus): void {
		if (this.statusValue === status) return
		this.statusValue = status
		this.dispatchEvent(new Event('statuschange'))
	}

	private emitHistory(event?: HistoricalEvent): void {
		if (event) this.history.push(event)
		this.dispatchEvent(new Event('historychange'))
	}

	private emitActivity(activity: AgentActivity): void {
		this.dispatchEvent(new CustomEvent('activity', { detail: activity }))
	}
}
