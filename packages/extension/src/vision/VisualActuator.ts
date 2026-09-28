import type { PointActionOptions } from '@page-agent/page-controller'

import type { RemotePageController } from '@/agent/RemotePageController'
import type { TabsController } from '@/agent/TabsController'

import type { VisualAction } from './types'

export interface ActuatorResult {
	done: boolean
	message: string
}

export interface VisualActuatorConfig {
	/** Resolve visual points to local actionable controls before acting. */
	targetResolution?: boolean
	/** Maximum bounded local recovery radius in CSS pixels. */
	targetResolutionRadiusPx?: number
}

export class VisualActuator {
	private pointOptions: PointActionOptions

	constructor(
		private pageController: RemotePageController,
		private tabsController: TabsController,
		config: VisualActuatorConfig = {}
	) {
		this.pointOptions = {
			resolveTarget: config.targetResolution ?? false,
			maxRadiusPx: config.targetResolutionRadiusPx ?? 24,
		}
	}

	async execute(action: VisualAction): Promise<ActuatorResult> {
		switch (action.kind) {
			case 'CLICK': {
				const result = await this.pageController.clickPoint(action.target.point, this.pointOptions)
				return { done: false, message: result.message }
			}
			case 'TYPE_TEXT': {
				const result = await this.pageController.inputTextAtPoint(
					action.target.point,
					action.text,
					this.pointOptions
				)
				return { done: false, message: result.message }
			}
			case 'SELECT': {
				const result = await this.pageController.selectOptionAtPoint(
					action.target.point,
					action.optionText,
					this.pointOptions
				)
				return { done: false, message: result.message }
			}
			case 'SCROLL': {
				const result = await this.pageController.scrollViewport({
					direction: action.direction,
					amount: action.amount,
				})
				return { done: false, message: result.message }
			}
			case 'SCROLL_HORIZONTAL': {
				const result = await this.pageController.scrollHorizontally({
					right: action.direction === 'right',
					pixels: action.pixels,
				})
				return { done: false, message: result.message }
			}
			case 'OPEN_URL':
				return { done: false, message: await this.tabsController.openNewTab(action.url) }
			case 'SWITCH_TAB':
				return { done: false, message: await this.tabsController.switchToTab(action.tabId) }
			case 'CLOSE_TAB':
				return { done: false, message: await this.tabsController.closeTab(action.tabId) }
			case 'WAIT':
				await new Promise((resolve) => setTimeout(resolve, 500))
				return { done: false, message: 'Waited for Panoptic to accumulate more evidence.' }
			case 'DONE':
				return { done: true, message: 'Task is complete.' }
		}
	}
}
