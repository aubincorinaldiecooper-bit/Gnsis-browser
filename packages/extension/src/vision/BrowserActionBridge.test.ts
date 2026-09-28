import { describe, expect, it } from 'vitest'

import { normalizedPoint, type BrowserDecisionRequest } from './BrowserActionBridge'

function decision(
	overrides: Partial<BrowserDecisionRequest['decision']> = {}
): BrowserDecisionRequest['decision'] {
	return {
		action: 'click',
		target: { x: 640, y: 400 },
		viewport: { width: 1280, height: 800 },
		...overrides,
	}
}

describe('normalizedPoint', () => {
	it('maps backend viewport pixels to the PageController normalized point', () => {
		expect(normalizedPoint(decision())).toEqual({ x: 0.5, y: 0.5 })
	})

	it('requires the viewport that produced the visual decision', () => {
		expect(() => normalizedPoint(decision({ viewport: null }))).toThrow('source viewport')
	})

	it('rejects stale or malformed targets outside that viewport', () => {
		expect(() =>
			normalizedPoint(decision({ target: { x: 1280, y: 10 } }))
		).toThrow('outside the source viewport')
	})
})
