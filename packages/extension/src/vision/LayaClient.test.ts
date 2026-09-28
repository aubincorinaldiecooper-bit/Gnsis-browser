import { describe, expect, it, vi } from 'vitest'

import { LayaClient, buildActionQuestion, parseVisualState } from './LayaClient'
import type { DecisionContext } from './types'

function context(): DecisionContext {
	return {
		task: 'type "aubin" into the search field and continue',
		visual: {
			summary: 'Search page is visible',
			change: 'Search field appeared',
			pageStable: true,
			targets: [
				{
					id: 'search',
					label: 'Search',
					role: 'input',
					point: { x: 0.5, y: 0.2 },
					affordances: ['TYPE_TEXT', 'CLICK'],
				},
				{
					id: 'continue',
					label: 'Continue',
					role: 'button',
					point: { x: 0.75, y: 0.8 },
					affordances: ['CLICK'],
				},
			],
		},
		tabs: [{ id: 7, current: true, title: 'Example', url: 'https://example.com' }],
	}
}

describe('Panoptic -> Laya contract', () => {
	it('parses only bounded visual targets with normalized coordinates', () => {
		const state = parseVisualState(
			JSON.stringify({
				summary: 'Ready',
				change: 'Button appeared',
				page_stable: true,
				targets: [
					{
						id: 'ok',
						label: 'OK',
						role: 'button',
						point: { x: 0.5, y: 0.5 },
						affordances: ['CLICK'],
					},
					{
						id: 'bad',
						label: 'Offscreen',
						role: 'button',
						point: { x: 4, y: -1 },
						affordances: ['CLICK'],
					},
				],
			})
		)

		expect(state.targets).toHaveLength(1)
		expect(state.targets[0]?.id).toBe('ok')
		expect(state.pageStable).toBe(true)
	})

	it('never offers Laya free-form coordinates, selectors, or javascript', () => {
		const built = buildActionQuestion(context())
		expect(Object.keys(built.criteria).length).toBeLessThanOrEqual(20)
		for (const option of Object.values(built.criteria)) {
			expect(option).not.toMatch(/selector|javascript|document\.querySelector/i)
		}
		expect(Object.keys(built.criteria)).toContain('click:continue')
		expect(Object.keys(built.criteria).some((key) => key.startsWith('type:search:'))).toBe(true)
	})

	it('rejects a Laya choice that was not offered by code', async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					answers: {
						action: {
							choice: 'javascript:steal',
							confidence: 0.99,
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		})

		const client = new LayaClient({ fetchImpl: fetchImpl as typeof fetch })
		await expect(client.decide(context())).rejects.toThrow('invalid bounded action')
	})

	it('maps a valid Laya choice back to the exact Panoptic target', async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					answers: {
						action: {
							choice: 'click:continue',
							confidence: 0.91,
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		})

		const client = new LayaClient({ fetchImpl: fetchImpl as typeof fetch })
		const action = await client.decide(context())
		expect(action.kind).toBe('CLICK')
		if (action.kind === 'CLICK') {
			expect(action.target.id).toBe('continue')
			expect(action.target.point).toEqual({ x: 0.75, y: 0.8 })
		}
	})
})
