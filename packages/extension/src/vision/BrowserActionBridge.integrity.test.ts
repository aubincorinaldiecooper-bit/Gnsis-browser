import { describe, expect, it } from 'vitest'

import {
	assertFrameSource,
	parseBrowserDecisionRequest,
	pointActionOptions,
} from './BrowserActionBridge'

describe('browser action runtime contract', () => {
	it('rejects unsupported runtime actions instead of reporting success', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: 'c-1',
				decision: { action: 'clik' },
			})
		).toThrow('unsupported browser action')
	})

	it('requires non-empty call ids', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: '',
				decision: { action: 'wait' },
			})
		).toThrow('call_id')
	})

	it('keeps target resolution off unless explicitly requested', () => {
		expect(pointActionOptions({ action: 'click' })).toEqual({ resolveTarget: false })
	})

	it('bounds requested target resolution to 24 CSS pixels', () => {
		expect(
			pointActionOptions({
				action: 'click',
				resolve_target: true,
				max_radius_px: 400,
			})
		).toEqual({ resolveTarget: true, maxRadiusPx: 24 })
	})
})

describe('frame execution provenance', () => {
	it('allows the same tab that produced the frame', () => {
		expect(() => assertFrameSource('frame-1', 17, 17)).not.toThrow()
	})

	it('rejects a frame-bound action without source tab provenance', () => {
		expect(() => assertFrameSource('frame-1', null, 17)).toThrow('source_tab_id')
	})

	it('rejects acting on a different tab than the frame source', () => {
		expect(() => assertFrameSource('frame-1', 17, 21)).toThrow('reobserve')
	})

	it('does not require tab provenance for non-frame actions', () => {
		expect(() => assertFrameSource(null, null, 21)).not.toThrow()
	})
})
