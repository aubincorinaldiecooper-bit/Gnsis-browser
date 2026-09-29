import { describe, expect, it } from 'vitest'

import {
	assertFrameSource,
	parseBrowserDecisionRequest,
	pointActionOptions,
} from './BrowserActionBridge'

const authority = {
	turn_id: 'turn-1',
	provenance: 'direct_user' as const,
	policy_decision: 'allow' as const,
	policy_reason: 'asked for directly',
	capability_manifest_id: 'browser-v1',
	allowed_actions: ['click', 'wait'] as const,
	confirmation: 'not_required' as const,
}

describe('browser action runtime contract', () => {
	it('rejects unsupported runtime actions instead of reporting success', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: 'c-1',
				authority,
				decision: { action: 'clik' },
			})
		).toThrow('unsupported browser action')
	})

	it('requires non-empty call ids', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: '',
				authority,
				decision: { action: 'wait' },
			})
		).toThrow('call_id')
	})

	it('fails closed without trusted execution authority', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: 'c-2',
				decision: { action: 'wait' },
			})
		).toThrow('trusted user-intent authority')
	})

	it('requires approval when policy says confirm', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: 'c-3',
				authority: { ...authority, policy_decision: 'confirm', confirmation: 'missing' },
				decision: { action: 'wait' },
			})
		).toThrow('approved confirmation')
	})

	it('does not run on a generic allow when the intent cannot be traced to the person', () => {
		for (const provenance of ['unknown', 'observed_untrusted'] as const) {
			expect(() =>
				parseBrowserDecisionRequest({
					call_id: `c-${provenance}`,
					authority: { ...authority, provenance },
					decision: { action: 'wait' },
				})
			).toThrow(`${provenance} provenance requires an approved confirmation`)
			expect(() =>
				parseBrowserDecisionRequest({
					call_id: `c-${provenance}-approved`,
					authority: { ...authority, provenance, confirmation: 'approved' },
					decision: { action: 'wait' },
				})
			).not.toThrow()
		}
	})

	it('rejects actions outside the capability manifest', () => {
		expect(() =>
			parseBrowserDecisionRequest({
				call_id: 'c-4',
				authority: { ...authority, allowed_actions: ['wait'] },
				decision: { action: 'click' },
			})
		).toThrow('not allowed by capability manifest')
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
