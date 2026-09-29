import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemotePageController } from '@/agent/RemotePageController'
import { TabsController } from '@/agent/TabsController'

import { BrowserActionBridge } from './BrowserActionBridge'

// The bridge's chrome-backed collaborators are stubbed at their prototypes:
// attaching to a tab, and the content-script click. What is under test is the
// evidence the bridge reports back to GNSIS.
function stubPage(execution: Record<string, unknown>) {
	vi.spyOn(TabsController.prototype, 'attachToActiveTab').mockImplementation(async function (
		this: TabsController
	) {
		this.currentTabId = 17
	})
	vi.spyOn(RemotePageController.prototype, 'clickPoint').mockResolvedValue({
		success: true,
		message: 'Clicked',
		execution,
	} as never)
}

const request = {
	call_id: 'call_1',
	frame_id: null,
	source_tab_id: 17,
	decision: {
		action: 'click' as const,
		target: { x: 320, y: 100 },
		viewport: { width: 640, height: 400 },
	},
}

describe('browser action evidence', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('reports the page viewport so page geometry can be related to frame pixels', async () => {
		stubPage({
			method: 'raw-point',
			resolvedPoint: { x: 640, y: 200 },
			targetBox: { x: 600, y: 180, width: 120, height: 40 },
			viewport: { width: 1280, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 360 },
		})
		const result = await new BrowserActionBridge().execute(request)
		expect(result.evidence).toMatchObject({
			action: 'click',
			executed_tab_id: 17,
			raw_target: { x: 320, y: 100 },
			source_viewport: { width: 640, height: 400 },
			resolution_method: 'raw-point',
			target_box: { x: 600, y: 180, width: 120, height: 40 },
			page_viewport: {
				width: 1280,
				height: 800,
				device_pixel_ratio: 2,
				scroll_x: 0,
				scroll_y: 360,
			},
		})
	})

	it('reports no page viewport when the page did not measure one', async () => {
		stubPage({ method: 'raw-point' })
		const result = await new BrowserActionBridge().execute({ ...request, call_id: 'call_2' })
		expect(result.evidence.page_viewport).toBeNull()
	})

	it('reports the tab it would act on, for capture', async () => {
		stubPage({ method: 'raw-point' })
		await expect(new BrowserActionBridge().eligibleTabId()).resolves.toBe(17)
	})
})
