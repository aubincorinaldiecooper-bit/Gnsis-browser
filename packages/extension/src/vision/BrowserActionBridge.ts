import { RemotePageController } from '@/agent/RemotePageController'
import { TabsController } from '@/agent/TabsController'

export type BrowserDecisionAction =
	| 'click'
	| 'type'
	| 'scroll'
	| 'navigate'
	| 'back'
	| 'wait'
	| 'done'
	| 'recover'

export interface BrowserDecisionRequest {
	call_id: string
	frame_id?: string | number | null
	decision: {
		action: BrowserDecisionAction
		confidence?: number
		target?: { x: number; y: number } | null
		text?: string | null
		url?: string | null
		direction?: 'up' | 'down' | null
		viewport?: { width: number; height: number } | null
		resolve_target?: boolean
		max_radius_px?: number | null
	}
}

export interface BrowserDecisionResult {
	call_id: string
	frame_id?: string | number | null
	success: boolean
	done: boolean
	message: string
}

/**
 * Execution-only browser bridge.
 *
 * GNSIS has already observed the screen and selected one structured action.
 * This class never performs perception, planning or DOM enumeration. DOM is
 * used only after the pixel target already exists, for bounded r24 cleanup.
 */
export class BrowserActionBridge {
	private readonly tabs = new TabsController()
	private readonly page = new RemotePageController(this.tabs)
	async execute(request: BrowserDecisionRequest): Promise<BrowserDecisionResult> {
		if (!request.call_id) throw new Error('browser action requires call_id')
		await this.ensureAttached()

		const decision = request.decision
		let done = false
		let message = ''

		switch (decision.action) {
			case 'click': {
				const point = normalizedPoint(decision)
				const result = await this.page.clickPoint(point, pointActionOptions(decision))
				message = result.message
				if (!result.success) throw new Error(result.message)
				break
			}
			case 'type': {
				if (!decision.text) throw new Error('type requires text')
				const point = normalizedPoint(decision)
				const result = await this.page.inputTextAtPoint(point, decision.text, pointActionOptions(decision))
				message = result.message
				if (!result.success) throw new Error(result.message)
				break
			}
			case 'scroll': {
				if (decision.direction !== 'up' && decision.direction !== 'down') {
					throw new Error('scroll requires direction up|down')
				}
				const result = await this.page.scrollViewport({
					direction: decision.direction,
					amount: 'page',
					fraction: 0.7,
				})
				message = result.message
				if (!result.success) throw new Error(result.message)
				break
			}
			case 'navigate': {
				if (!decision.url?.startsWith('http://') && !decision.url?.startsWith('https://')) {
					throw new Error('navigate requires an http(s) url')
				}
				message = await this.tabs.navigateCurrent(decision.url)
				break
			}
			case 'back':
				message = await this.tabs.goBack()
				break
			case 'wait':
				await new Promise((resolve) => setTimeout(resolve, 600))
				message = 'Waited for more visual evidence.'
				break
			case 'done':
				done = true
				message = 'Task is complete.'
				break
			case 'recover': {
				await this.page.pressEscape()
				if (decision.target) {
					const point = normalizedPoint(decision)
					const result = await this.page.clickPoint(point, {
						resolveTarget: true,
						maxRadiusPx: 24,
					})
					message = `Recovery: ${result.message}`
					if (!result.success) throw new Error(result.message)
				} else {
					message = await this.tabs.reloadCurrent()
				}
				break
			}
		}

		return {
			call_id: request.call_id,
			frame_id: request.frame_id,
			success: true,
			done,
			message,
		}
	}

	dispose(): void {
		this.tabs.dispose()
	}

	private async ensureAttached(): Promise<void> {
		// Re-resolve the active tab for every action. The person may have changed
		// tabs between the frame GNSIS saw and the action arriving.
		await this.tabs.attachToActiveTab({ includeAllTabs: true })
	}
}

export function normalizedPoint(
	decision: BrowserDecisionRequest['decision']
): { x: number; y: number } {
	const target = decision.target
	const viewport = decision.viewport
	if (!target) throw new Error(`${decision.action} requires a target`)
	if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
		throw new Error(`${decision.action} requires the source viewport`)
	}
	if (
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
): { resolveTarget: boolean; maxRadiusPx?: number } {
	if (!decision.resolve_target) return { resolveTarget: false }
	return {
		resolveTarget: true,
		maxRadiusPx: Math.min(24, Math.max(0, decision.max_radius_px ?? 24)),
	}
}
