import { describe, expect, it } from 'vitest'

import { pointActionOptions, type BrowserDecisionRequest } from './BrowserActionBridge'

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

describe('pointActionOptions', () => {
	it('keeps target resolution off by default', () => {
		expect(pointActionOptions(decision())).toEqual({ resolveTarget: false })
	})

	it('enables a bounded radius only when requested', () => {
		expect(pointActionOptions(decision({ resolve_target: true, max_radius_px: 16 }))).toEqual({
			resolveTarget: true,
			maxRadiusPx: 16,
		})
	})

	it('caps the resolver radius at 24 CSS pixels', () => {
		expect(pointActionOptions(decision({ resolve_target: true, max_radius_px: 99 }))).toEqual({
			resolveTarget: true,
			maxRadiusPx: 24,
		})
	})
})
