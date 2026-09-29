import type { PointActionOptions } from '@page-agent/page-controller'

import { RemotePageController } from '@/agent/RemotePageController'
import { TabsController } from '@/agent/TabsController'

import { frameSourceTab } from './FrameProvenance'

export type BrowserDecisionAction =
	| 'click'
	| 'type'
	| 'select'
	| 'scroll'
	| 'navigate'
	| 'open_url'
	| 'back'
	| 'reload'
	| 'wait'
	| 'done'
	| 'recover'
	| 'switch_tab'
	| 'close_tab'

export interface BrowserActionAuthority {
	turn_id: string
	provenance: 'direct_user' | 'mixed' | 'observed_untrusted' | 'delegated_result' | 'unknown'
	policy_decision: 'allow' | 'confirm' | 'deny'
	policy_reason: string
	capability_manifest_id: string
	allowed_actions: BrowserDecisionAction[]
	confirmation: 'not_required' | 'approved' | 'denied' | 'missing'
}

export interface BrowserDecisionRequest {
	call_id: string
	frame_id?: string | number | null
	source_tab_id?: number | null
	authority: BrowserActionAuthority
	decision: {
		action: BrowserDecisionAction
		confidence?: number
		target?: { x: number; y: number } | null
		text?: string | null
		option?: string | null
		url?: string | null
		direction?: 'up' | 'down' | 'left' | 'right' | null
		viewport?: { width: number; height: number } | null
		tab_id?: number | null
		wait_ms?: number | null
		resolve_target?: boolean
		max_radius_px?: number | null
	}
}

export interface BrowserActionEvidence {
	context: 'browser'
	action: BrowserDecisionAction
	source_tab_id: number | null
	executed_tab_id: number | null
	started_at_ms: number
	completed_at_ms: number
	latency_ms: number
	source_viewport?: { width: number; height: number } | null
	raw_target?: { x: number; y: number } | null
	resolve_target: boolean
	resolution_method?: string | null
	resolved_target?: { x: number; y: number } | null
	target_box?: { x: number; y: number; width: number; height: number } | null
	/**
	 * The page's layout viewport (CSS pixels) when the point was mapped.
	 * `resolved_target` and `target_box` are in these pixels; `raw_target` and
	 * `source_viewport` are in the source frame's pixels. The two sizes relate
	 * them.
	 */
	page_viewport?: {
		width: number
		height: number
		device_pixel_ratio: number
		scroll_x: number
		scroll_y: number
	} | null
}

export interface BrowserDecisionResult {
	call_id: string
	frame_id?: string | number | null
	success: boolean
	done: boolean
	message: string
	evidence: BrowserActionEvidence
	replayed?: boolean
}

interface PageActionResult {
	success: boolean
	message: string
	error?: string
	execution?: {
		method: string
		resolvedPoint?: { x: number; y: number }
		targetBox?: { x: number; y: number; width: number; height: number }
		viewport?: {
			width: number
			height: number
			devicePixelRatio: number
			scrollX: number
			scrollY: number
		}
	}
}

const ACTIONS = new Set<BrowserDecisionAction>([
	'click',
	'type',
	'select',
	'scroll',
	'navigate',
	'open_url',
	'back',
	'reload',
	'wait',
	'done',
	'recover',
	'switch_tab',
	'close_tab',
])

const COMPLETED_CACHE_LIMIT = 256

/**
 * Execution-only browser bridge.
 *
 * GNSIS has already observed the rendered screen and selected one structured
 * action. DOM is never used for perception. PageController may use local DOM
 * geometry only after the pixel target exists, for optional bounded actuator
 * cleanup and executor-side evidence.
 */
export class BrowserActionBridge {
	private readonly tabs = new TabsController()
	private readonly page = new RemotePageController(this.tabs)
	private readonly completed = new Map<string, BrowserDecisionResult>()
	private readonly inFlight = new Map<
		string,
		{ promise: Promise<BrowserDecisionResult>; abort: AbortController }
	>()
	private sessionNonce = ''

	resetSession(sessionNonce: string): void {
		if (sessionNonce === this.sessionNonce) return
		this.cancelAll()
		this.completed.clear()
		this.sessionNonce = sessionNonce
	}

	async execute(request: BrowserDecisionRequest): Promise<BrowserDecisionResult> {
		validateRequest(request)

		const completed = this.completed.get(request.call_id)
		if (completed) return { ...completed, replayed: true }

		const active = this.inFlight.get(request.call_id)
		if (active) return active.promise

		const abort = new AbortController()
		const promise = this.executeOnce(request, abort.signal)
			.then((result) => {
				this.completed.set(request.call_id, result)
				while (this.completed.size > COMPLETED_CACHE_LIMIT) {
					const oldest = this.completed.keys().next().value
					if (oldest === undefined) break
					this.completed.delete(oldest)
				}
				return result
			})
			.finally(() => this.inFlight.delete(request.call_id))

		this.inFlight.set(request.call_id, { promise, abort })
		return promise
	}

	cancel(callId: string): boolean {
		const active = this.inFlight.get(callId)
		if (!active) return false
		active.abort.abort(new DOMException('Browser action cancelled', 'AbortError'))
		return true
	}

	cancelAll(): void {
		for (const active of this.inFlight.values()) {
			active.abort.abort(new DOMException('Browser actions cancelled', 'AbortError'))
		}
	}

	dispose(): void {
		this.cancelAll()
		this.tabs.dispose()
	}

	/** The tab actions would run on now: the one to capture for GNSIS. */
	async eligibleTabId(): Promise<number> {
		await this.tabs.attachToActiveTab({ includeAllTabs: true })
		const tabId = this.tabs.currentTabId
		if (tabId == null) throw new Error('no eligible browser tab to capture')
		return tabId
	}

	private async executeOnce(
		request: BrowserDecisionRequest,
		signal: AbortSignal
	): Promise<BrowserDecisionResult> {
		signal.throwIfAborted()
		const startedAt = Date.now()
		const decision = request.decision
		let done = false
		let message = ''
		let pageResult: PageActionResult | null = null

		if (decision.action !== 'done' && decision.action !== 'wait') {
			await this.tabs.attachToActiveTab({ includeAllTabs: true })
			this.assertSourceStillCurrent(request)
		}

		switch (decision.action) {
			case 'click':
				pageResult = await this.page.clickPoint(
					normalizedPoint(decision),
					pointActionOptions(decision)
				)
				message = requirePageSuccess(pageResult)
				break
			case 'type':
				if (decision.text == null) throw new Error('type requires text')
				pageResult = await this.page.inputTextAtPoint(
					normalizedPoint(decision),
					decision.text,
					pointActionOptions(decision)
				)
				message = requirePageSuccess(pageResult)
				break
			case 'select': {
				const option = decision.option ?? decision.text
				if (option == null) throw new Error('select requires option')
				pageResult = await this.page.selectOptionAtPoint(
					normalizedPoint(decision),
					option,
					pointActionOptions(decision)
				)
				message = requirePageSuccess(pageResult)
				break
			}
			case 'scroll':
				if (!decision.direction) throw new Error('scroll requires direction')
				pageResult = await this.page.scrollViewport({
					direction: decision.direction,
					amount: 'page',
					fraction: 0.7,
				})
				message = requirePageSuccess(pageResult)
				break
			case 'navigate':
				message = await this.tabs.navigateCurrent(requireHttpUrl(decision.url, 'navigate'), {
					signal,
				})
				break
			case 'open_url':
				message = await this.tabs.openNewTab(requireHttpUrl(decision.url, 'open_url'), { signal })
				break
			case 'back':
				message = await this.tabs.goBack({ signal })
				break
			case 'reload':
				message = await this.tabs.reloadCurrent({ signal })
				break
			case 'switch_tab':
				if (!Number.isInteger(decision.tab_id)) throw new Error('switch_tab requires tab_id')
				message = await this.tabs.switchToTab(decision.tab_id!)
				break
			case 'close_tab':
				if (!Number.isInteger(decision.tab_id)) throw new Error('close_tab requires tab_id')
				message = await this.tabs.closeTab(decision.tab_id!)
				break
			case 'wait': {
				const waitMs = Math.min(10_000, Math.max(0, decision.wait_ms ?? 600))
				await abortableDelay(waitMs, signal)
				message = `Waited ${waitMs}ms for more visual evidence.`
				break
			}
			case 'done':
				done = true
				message = 'Task is complete.'
				break
			case 'recover':
				if (!decision.target) {
					throw new Error(
						'recover without a visual target requires trusted key input; route Escape to the desktop actuator'
					)
				}
				pageResult = await this.page.clickPoint(
					normalizedPoint(decision),
					pointActionOptions(decision)
				)
				message = `Recovery: ${requirePageSuccess(pageResult)}`
				break
			default:
				throw new Error(`unsupported browser action: ${String(decision.action)}`)
		}

		signal.throwIfAborted()
		const completedAt = Date.now()
		const pageViewport = pageResult?.execution?.viewport
		return {
			call_id: request.call_id,
			frame_id: request.frame_id,
			success: true,
			done,
			message,
			evidence: {
				context: 'browser',
				action: decision.action,
				source_tab_id: request.source_tab_id ?? null,
				executed_tab_id: this.tabs.currentTabId,
				started_at_ms: startedAt,
				completed_at_ms: completedAt,
				latency_ms: completedAt - startedAt,
				source_viewport: decision.viewport,
				raw_target: decision.target,
				resolve_target: Boolean(decision.resolve_target),
				resolution_method: pageResult?.execution?.method ?? null,
				resolved_target: pageResult?.execution?.resolvedPoint ?? null,
				target_box: pageResult?.execution?.targetBox ?? null,
				page_viewport: pageViewport
					? {
							width: pageViewport.width,
							height: pageViewport.height,
							device_pixel_ratio: pageViewport.devicePixelRatio,
							scroll_x: pageViewport.scrollX,
							scroll_y: pageViewport.scrollY,
						}
					: null,
			},
		}
	}

	private assertSourceStillCurrent(request: BrowserDecisionRequest): void {
		const registered = frameSourceTab(request.frame_id)
		const sourceTabId = registered ?? request.source_tab_id
		if (
			registered != null &&
			request.source_tab_id != null &&
			registered !== request.source_tab_id
		) {
			throw new Error(
				`frame provenance mismatch: registry says tab ${registered}, request says ${request.source_tab_id}`
			)
		}
		assertFrameSource(request.frame_id, sourceTabId, this.tabs.currentTabId)
	}
}

export function parseBrowserDecisionRequest(value: unknown): BrowserDecisionRequest {
	if (!isRecord(value)) throw new Error('browser.action must be an object')
	const decision = value.decision
	if (!isRecord(decision)) throw new Error('browser.action decision must be an object')
	const action = decision.action
	if (typeof action !== 'string' || !ACTIONS.has(action as BrowserDecisionAction)) {
		throw new Error(`unsupported browser action: ${String(action)}`)
	}
	if (typeof value.call_id !== 'string' || !value.call_id.trim()) {
		throw new Error('browser.action requires non-empty call_id')
	}

	const request = value as unknown as BrowserDecisionRequest
	validateRequest(request)
	return request
}

export function normalizedPoint(decision: BrowserDecisionRequest['decision']): {
	x: number
	y: number
} {
	const target = decision.target
	const viewport = decision.viewport
	if (!target) throw new Error(`${decision.action} requires a target`)
	if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
		throw new Error(`${decision.action} requires the source viewport`)
	}
	if (
		!Number.isFinite(target.x) ||
		!Number.isFinite(target.y) ||
		target.x < 0 ||
		target.y < 0 ||
		target.x >= viewport.width ||
		target.y >= viewport.height
	) {
		throw new Error('target is outside the source viewport')
	}
	return {
		x: target.x / viewport.width,
		y: target.y / viewport.height,
	}
}

export function pointActionOptions(
	decision: BrowserDecisionRequest['decision']
): PointActionOptions {
	if (!decision.resolve_target) return { resolveTarget: false }
	return {
		resolveTarget: true,
		maxRadiusPx: Math.min(24, Math.max(0, decision.max_radius_px ?? 24)),
	}
}

function validateRequest(request: BrowserDecisionRequest): void {
	if (!request.call_id?.trim()) throw new Error('browser action requires call_id')
	validateAuthority(request.authority)
	if (!ACTIONS.has(request.decision.action)) {
		throw new Error(`unsupported browser action: ${String(request.decision.action)}`)
	}
	assertAuthorizedAction(request)
	if (
		request.source_tab_id != null &&
		(!Number.isInteger(request.source_tab_id) || request.source_tab_id <= 0)
	) {
		throw new Error('source_tab_id must be a positive integer')
	}
}

function validateAuthority(authority: BrowserActionAuthority | null | undefined): void {
	if (!authority || typeof authority !== 'object') {
		throw new Error('browser action requires trusted user-intent authority')
	}
	for (const [name, value] of [
		['turn_id', authority.turn_id],
		['policy_reason', authority.policy_reason],
		['capability_manifest_id', authority.capability_manifest_id],
	] as const) {
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(`browser action authority requires ${name}`)
		}
	}
	if (!['direct_user', 'mixed', 'observed_untrusted', 'delegated_result', 'unknown'].includes(authority.provenance)) {
		throw new Error('browser action authority has invalid provenance')
	}
	if (!['allow', 'confirm', 'deny'].includes(authority.policy_decision)) {
		throw new Error('browser action authority has invalid policy_decision')
	}
	if (!['not_required', 'approved', 'denied', 'missing'].includes(authority.confirmation)) {
		throw new Error('browser action authority has invalid confirmation state')
	}
	if (!Array.isArray(authority.allowed_actions) || authority.allowed_actions.length === 0) {
		throw new Error('browser action authority requires allowed_actions')
	}
	if (!authority.allowed_actions.every((action) => ACTIONS.has(action))) {
		throw new Error('browser action authority has an invalid allowed action')
	}
	if (authority.policy_decision === 'deny') {
		throw new Error(`browser action blocked by policy: ${authority.policy_reason}`)
	}
	if (authority.policy_decision === 'confirm' && authority.confirmation !== 'approved') {
		throw new Error('browser action requires an approved confirmation')
	}
	if (authority.policy_decision === 'allow' && !['not_required', 'approved'].includes(authority.confirmation)) {
		throw new Error('browser action authority does not permit execution')
	}
}

function assertAuthorizedAction(request: BrowserDecisionRequest): void {
	if (!request.authority.allowed_actions.includes(request.decision.action)) {
		throw new Error(
			`browser action ${request.decision.action} is not allowed by capability manifest ${request.authority.capability_manifest_id}`
		)
	}
}

function requirePageSuccess(result: PageActionResult): string {
	if (!result?.success) {
		throw new Error(result?.message || result?.error || 'browser page action failed')
	}
	return result.message
}

function requireHttpUrl(value: string | null | undefined, action: string): string {
	if (!value?.startsWith('http://') && !value?.startsWith('https://')) {
		throw new Error(`${action} requires an http(s) url`)
	}
	return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(resolve, ms)
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(signal.reason)
			},
			{ once: true }
		)
	})
}

export function assertFrameSource(
	frameId: string | number | null | undefined,
	sourceTabId: number | null | undefined,
	currentTabId: number | null
): void {
	if (frameId == null) return
	if (!Number.isInteger(sourceTabId)) {
		throw new Error('frame-bound browser action requires source_tab_id')
	}
	if (currentTabId !== sourceTabId) {
		throw new Error(
			`stale browser frame: frame came from tab ${sourceTabId}, current eligible tab is ${currentTabId}; reobserve before acting`
		)
	}
}
