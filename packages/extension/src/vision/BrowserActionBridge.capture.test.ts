import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserActionBridge } from './BrowserActionBridge'
import { clearFrameProvenance, registerFrameSource } from './FrameProvenance'

interface ChromeMessage {
	type: 'TAB_CONTROL' | 'PAGE_CONTROL'
	action: string
	targetTabId?: number
	payload?: { tabId?: number }
}

/**
 * The service worker the bridge talks to through chrome.runtime, scripted: two
 * webpage tabs in one window. Tab titles are left out, so the page controller
 * asks for the tab's URL before it acts; that answer can be held to pause an
 * action after it has checked its tab and before it reaches the page.
 */
function stubBrowser() {
	const tabs = [
		{ id: 17, windowId: 1, url: 'https://a.example/', lastAccessed: 2 },
		{ id: 18, windowId: 1, url: 'https://b.example/', lastAccessed: 1 },
	]
	let activeTabId = 17
	let holdTabInfo = false
	const held: (() => void)[] = []
	const pageCalls: { action: string; targetTabId: number | undefined }[] = []
	vi.stubGlobal('chrome', {
		windows: { getCurrent: async () => ({ id: 1 }) },
		storage: { local: { set: async () => undefined } },
		runtime: {
			sendMessage: vi.fn(async (message: ChromeMessage) => {
				if (message.type === 'PAGE_CONTROL') {
					pageCalls.push({ action: message.action, targetTabId: message.targetTabId })
					return { success: true, message: 'Clicked', execution: { method: 'raw-point' } }
				}
				switch (message.action) {
					case 'get_active_tab':
						return { tab: { ...tabs.find((tab) => tab.id === activeTabId), active: true } }
					case 'get_window_tabs':
						return { tabs: tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId })) }
					case 'get_tab_info': {
						if (holdTabInfo) await new Promise<void>((resolve) => held.push(resolve))
						const tab = tabs.find((candidate) => candidate.id === message.payload?.tabId)
						return { url: tab?.url, title: 'Page' }
					}
				}
				return null
			}),
		},
	})
	return {
		pageCalls,
		activate: (tabId: number) => (activeTabId = tabId),
		holdTabInfo: () => (holdTabInfo = true),
		held: () => held.length,
		release: () => held.shift()?.(),
	}
}

const request = {
	call_id: 'call_1',
	frame_id: 'frame-17',
	source_tab_id: 17,
	authority: {
		turn_id: 'turn-1',
		provenance: 'direct_user' as const,
		policy_decision: 'allow' as const,
		policy_reason: 'asked for directly',
		capability_manifest_id: 'browser-v1',
		allowed_actions: ['click'] as const,
		confirmation: 'not_required' as const,
	},
	decision: {
		action: 'click' as const,
		target: { x: 320, y: 100 },
		viewport: { width: 640, height: 400 },
	},
}

describe('the tab GNSIS captures', () => {
	afterEach(() => {
		clearFrameProvenance()
		vi.unstubAllGlobals()
	})

	it('is the tab actions would run on now', async () => {
		stubBrowser()
		await expect(new BrowserActionBridge().eligibleTabId()).resolves.toBe(17)
	})

	it('is looked up without moving an action that is under way', async () => {
		const browser = stubBrowser()
		registerFrameSource('frame-17', 17)
		const bridge = new BrowserActionBridge()
		browser.holdTabInfo()
		const acting = bridge.execute(request)
		// The click has been checked against the tab its frame came from.
		await vi.waitFor(() => expect(browser.held()).toBe(1))

		// Meanwhile the person switches tabs, and GNSIS starts a capture.
		browser.activate(18)
		await expect(bridge.eligibleTabId()).resolves.toBe(18)

		browser.release()
		const result = await acting
		expect(result.success).toBe(true)
		expect(browser.pageCalls).toEqual([{ action: 'click_point', targetTabId: 17 }])
		expect(result.evidence.executed_tab_id).toBe(17)
	})
})
