import { afterEach, describe, expect, it, vi } from 'vitest'

import { TabsController } from './TabsController'

// waitUntilTabLoaded asks the background for the tab's live status
// (TAB_CONTROL get_tab_info) instead of trusting the synced tab list. The
// chrome.runtime message channel is the only chrome dependency it touches, so
// it is stubbed here with a scripted sequence of answers.
function stubTabInfo(answers: Record<string, unknown>[]): { calls: () => number } {
	let calls = 0
	vi.stubGlobal('chrome', {
		runtime: {
			sendMessage: vi.fn(async (message: { action: string }) => {
				expect(message.action).toBe('get_tab_info')
				const answer = answers[Math.min(calls, answers.length - 1)]
				calls += 1
				return answer
			}),
		},
	})
	return { calls: () => calls }
}

describe('TabsController.waitUntilTabLoaded', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('throws for an unknown tab id', async () => {
		stubTabInfo([{ error: 'Tab 999 not found' }])
		await expect(new TabsController().waitUntilTabLoaded(999)).rejects.toThrow('not found')
	})

	it('resolves once a loading tab transitions to complete during the wait', async () => {
		const tab = { title: 'Shop', url: 'https://shop.example/' }
		const { calls } = stubTabInfo([
			{ ...tab, status: 'loading' },
			{ ...tab, status: 'loading' },
			{ ...tab, status: 'complete' },
		])
		await expect(new TabsController().waitUntilTabLoaded(1)).resolves.toBeUndefined()
		expect(calls()).toBe(3)
	})

	it('does not keep waiting on a tab that is not loading, such as an unloaded one', async () => {
		const { calls } = stubTabInfo([{ title: '', url: 'https://shop.example/', status: 'unloaded' }])
		await expect(new TabsController().waitUntilTabLoaded(1)).resolves.toBeUndefined()
		expect(calls()).toBe(1)
	})

	it('rejects with an AbortError when aborted while the tab is still loading', async () => {
		stubTabInfo([{ title: '', url: 'https://shop.example/', status: 'loading' }])
		const ac = new AbortController()
		const promise = new TabsController().waitUntilTabLoaded(1, { signal: ac.signal })
		setTimeout(() => ac.abort(), 20)
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
	})

	it('rejects immediately without polling when the signal is already aborted', async () => {
		const { calls } = stubTabInfo([{ title: '', url: 'https://shop.example/', status: 'loading' }])
		const ac = new AbortController()
		ac.abort()
		await expect(
			new TabsController().waitUntilTabLoaded(1, { signal: ac.signal })
		).rejects.toMatchObject({ name: 'AbortError' })
		expect(calls()).toBe(0)
	})
})
