import type {
	AgentActivity,
	AgentStatus,
	ExecutionResult,
	HistoricalEvent,
} from '@page-agent/core'

import { RemotePageController } from './RemotePageController'
import { TabsController } from './TabsController'
import { LayaClient, parseVisualState } from '../vision/LayaClient'
import { PanopticClient } from '../vision/PanopticClient'
import { captureViewport } from '../vision/ViewportCapture'
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
	maxPerceptionSecondsPerStep?: number
	layaUrl?: string
}

/**
 * Page Agent fork runtime:
 *
 * Panoptic (causal visual perception) -> Laya (bounded decision) ->
 * Alibaba PageController (Actuator).
 *
 * The DOM tree is not used as perception or Laya context. DOM access is limited
 * to deterministic hit-testing/execution inside the Actuator after a visual
 * target coordinate has already been selected.
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
	private taskStartedAt = 0
	private temporalEpoch = 0
	private lastTimestampByTab = new Map<number, number>()
	private panopticByTab = new Map<number, PanopticClient>()
	private lastVisual: VisualState = {
		summary: '',
		change: '',
		pageStable: false,
		targets: [],
	}

	private tabsController = new TabsController()
	private pageController = new RemotePageController(this.tabsController)
	private laya: LayaClient
	private actuator = new VisualActuator(this.pageController, this.tabsController)

	constructor(config: PanopticPageAgentConfig = {}) {
		super()
		this.config = {
			maxSteps: config.maxSteps ?? 40,
			includeInitialTab: config.includeInitialTab ?? true,
			experimentalIncludeAllTabs: config.experimentalIncludeAllTabs ?? false,
			panopticUrl: config.panopticUrl ?? 'ws://127.0.0.1:8792/v1/panoptic/stream',
			panopticToken: config.panopticToken,
			panopticContextRounds: config.panopticContextRounds ?? 4096,
			panopticMaxFrames: config.panopticMaxFrames ?? 4096,
			panopticFps: Math.min(4, Math.max(0.5, config.panopticFps ?? 2)),
			maxPerceptionSecondsPerStep: Math.max(1, config.maxPerceptionSecondsPerStep ?? 8),
			layaUrl: config.layaUrl ?? 'http://127.0.0.1:8791',
		}
		this.laya = new LayaClient({ baseUrl: this.config.layaUrl })
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
		this.lastTimestampByTab.clear()
		this.closePanopticSessions()
		this.abortController = new AbortController()
		this.taskStartedAt = performance.now()
		const signal = this.abortController.signal

		let resolveRunning!: () => void
		this.running = new Promise<void>((resolve) => (resolveRunning = resolve))

		this.setStatus('running')
		this.emitHistory()
		// Panoptic must see the real page. Explicitly suppress the legacy Page Agent
		// interaction mask, which would otherwise become part of the visual stream.
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

				// Respect the streaming model's "not enough evidence yet" decision.
				// No Laya decision is made from a Silence/Standby-only interval.
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
					await new Promise((resolve) => setTimeout(resolve, 350))
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
			this.closePanopticSessions()
			resolveRunning()
			this.setStatus(finalStatus)
			await chrome.storage.local.set({ isAgentRunning: false }).catch(() => undefined)
		}
	}

	async stop(): Promise<void> {
		if (this.statusValue !== 'running') return
		this.abortController.abort()
		this.closePanopticSessions()
		await this.running
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.abortController.abort()
		this.closePanopticSessions()
		this.tabsController.dispose()
		void chrome.storage.local.set({ isAgentRunning: false })
		this.dispatchEvent(new Event('dispose'))
	}

	private async observeUntilResponse(
		tabId: number,
		signal: AbortSignal
	): Promise<PanopticTemporalState | null> {
		const client = await this.getPanopticSession(tabId, signal)
		const frameIntervalMs = Math.round(1000 / this.config.panopticFps)
		const deadline = performance.now() + this.config.maxPerceptionSecondsPerStep * 1000
		const inFlight = new Set<Promise<PanopticTemporalState>>()
		let latestResponse: PanopticTemporalState | null = null
		let responseSeen = false

		const track = (promise: Promise<PanopticTemporalState>) => {
			inFlight.add(promise)
			promise
				.then((temporal) => {
					if (temporal.state === 'response') {
						latestResponse = temporal
						responseSeen = true
					}
				})
				.finally(() => inFlight.delete(promise))
		}

		while (performance.now() < deadline && !responseSeen) {
			signal.throwIfAborted()
			if (inFlight.size >= 8) {
				await Promise.race(inFlight)
				continue
			}

			const frameStarted = performance.now()
			const imageBase64 = await captureViewport(tabId)
			const elapsed = performance.now() - this.taskStartedAt
			const previous = this.lastTimestampByTab.get(tabId) ?? -1
			const timestampMs = Math.max(previous + 1, elapsed)
			this.lastTimestampByTab.set(tabId, timestampMs)

			track(
				client.pushFrame({
					frameId: crypto.randomUUID(),
					epoch: this.temporalEpoch,
					timestampMs,
					durationMs: frameIntervalMs,
					imageBase64,
				})
			)

			const remaining = frameIntervalMs - (performance.now() - frameStarted)
			if (remaining > 0) {
				await new Promise((resolve) => setTimeout(resolve, remaining))
			}
		}

		// Drain frames captured before the response boundary. This keeps the
		// state used by Laya aligned to the latest pre-action visual evidence
		// instead of acting while older frames are still queued in Panoptic.
		if (inFlight.size) await Promise.all(inFlight)
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
			signal,
		})
		await client.connect()
		this.panopticByTab.set(tabId, client)
		return client
	}

	private closePanopticSessions(): void {
		for (const client of this.panopticByTab.values()) client.close()
		this.panopticByTab.clear()
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
