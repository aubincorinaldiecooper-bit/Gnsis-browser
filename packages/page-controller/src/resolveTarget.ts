export type PointActionKind = 'click' | 'type' | 'select'

export interface PointActionOptions {
	/**
	 * Resolve a visually selected point to a local actionable control before
	 * executing it. This is actuator-only DOM use and must never be surfaced to
	 * perception or policy.
	 */
	resolveTarget?: boolean
	/** Maximum bounded recovery radius in CSS pixels. Defaults to 24. */
	maxRadiusPx?: number
}

export type ResolutionMethod =
	| 'exact-hit'
	| 'actionable-ancestor'
	| 'label-control'
	| 'wrapped-label-control'
	| 'nearby'
	| 'raw-point'

export interface ResolvedTarget {
	element?: HTMLElement
	method: ResolutionMethod
	originalPoint: { x: number; y: number }
	resolvedPoint?: { x: number; y: number }
	confidence: number
	abstained: boolean
	ambiguous?: boolean
	radius?: number
}

const CLICK_SELECTOR = [
	'button',
	'a[href]',
	'input:not([type="hidden"])',
	'select',
	'textarea',
	'summary',
	'[role="button"]',
	'[role="link"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="tab"]',
	'[role="combobox"]',
].join(',')

const NON_TYPABLE_INPUT_TYPES = new Set([
	'button',
	'checkbox',
	'color',
	'file',
	'hidden',
	'image',
	'radio',
	'range',
	'reset',
	'submit',
])

function isDisabled(element: HTMLElement): boolean {
	if (element.getAttribute('aria-disabled') === 'true') return true
	return 'disabled' in element && Boolean((element as HTMLButtonElement).disabled)
}

function isVisibleAndUsable(element: HTMLElement): boolean {
	if (isDisabled(element)) return false
	const style = getComputedStyle(element)
	if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
		return false
	}
	const rect = element.getBoundingClientRect()
	return rect.width > 0 && rect.height > 0
}

function isTypableInput(element: HTMLElement): boolean {
	if (element instanceof HTMLTextAreaElement) return isVisibleAndUsable(element)
	if (element instanceof HTMLInputElement) {
		return !NON_TYPABLE_INPUT_TYPES.has(element.type.toLowerCase()) && isVisibleAndUsable(element)
	}
	return false
}

function findEditableHost(start: Element): HTMLElement | null {
	let current: Element | null = start
	while (current) {
		if (current instanceof HTMLElement) {
			const attr = current.getAttribute('contenteditable')
			if (attr?.toLowerCase() === 'false') return null
			if (attr === '' || attr?.toLowerCase() === 'true') {
				return isVisibleAndUsable(current) ? current : null
			}
		}
		current = current.parentElement
	}
	return null
}

function isClickTarget(element: HTMLElement): boolean {
	return element.matches(CLICK_SELECTOR) && isVisibleAndUsable(element)
}

function getCompatibleAncestor(
	action: PointActionKind,
	start: Element
): { element: HTMLElement; exact: boolean } | null {
	let current: Element | null = start

	while (current) {
		if (current instanceof HTMLElement) {
			if (action === 'click' && isClickTarget(current)) {
				return { element: current, exact: current === start }
			}
			if (action === 'type' && isTypableInput(current)) {
				return { element: current, exact: current === start }
			}
			if (action === 'select' && current instanceof HTMLSelectElement && isVisibleAndUsable(current)) {
				return { element: current, exact: current === start }
			}
		}
		current = current.parentElement
	}

	if (action === 'type') {
		const host = findEditableHost(start)
		if (host) return { element: host, exact: host === start }
	}

	return null
}

function getLabel(start: Element): HTMLLabelElement | null {
	if (start instanceof HTMLLabelElement) return start
	const closest = start.closest('label')
	return closest instanceof HTMLLabelElement ? closest : null
}

function getAssociatedControl(
	action: PointActionKind,
	start: Element
): { element: HTMLElement; method: 'label-control' | 'wrapped-label-control' } | null {
	if (action !== 'type' && action !== 'select') return null

	const label = getLabel(start)
	if (!label) return null

	const direct = label.control
	if (direct instanceof HTMLElement) {
		if (action === 'type' && (isTypableInput(direct) || findEditableHost(direct) === direct)) {
			return { element: direct, method: 'label-control' }
		}
		if (action === 'select' && direct instanceof HTMLSelectElement && isVisibleAndUsable(direct)) {
			return { element: direct, method: 'label-control' }
		}
	}

	if (label.htmlFor) {
		const byId = label.ownerDocument.getElementById(label.htmlFor)
		if (byId instanceof HTMLElement) {
			if (action === 'type' && (isTypableInput(byId) || findEditableHost(byId) === byId)) {
				return { element: byId, method: 'label-control' }
			}
			if (action === 'select' && byId instanceof HTMLSelectElement && isVisibleAndUsable(byId)) {
				return { element: byId, method: 'label-control' }
			}
		}
	}

	const wrapped =
		action === 'type'
			? label.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]')
			: label.querySelector<HTMLElement>('select')

	if (!wrapped) return null
	if (action === 'type' && !(isTypableInput(wrapped) || findEditableHost(wrapped) === wrapped)) {
		return null
	}
	if (action === 'select' && !(wrapped instanceof HTMLSelectElement && isVisibleAndUsable(wrapped))) {
		return null
	}
	return { element: wrapped, method: 'wrapped-label-control' }
}

function topHitAt(x: number, y: number): Element | null {
	if (typeof document.elementsFromPoint === 'function') {
		return document.elementsFromPoint(x, y)[0] ?? null
	}
	return document.elementFromPoint(x, y)
}

function resolveFromHit(
	action: PointActionKind,
	hit: Element
):
	| { element: HTMLElement; method: Exclude<ResolutionMethod, 'nearby' | 'raw-point'> }
	| null {
	const compatible = getCompatibleAncestor(action, hit)
	if (compatible) {
		return {
			element: compatible.element,
			method: compatible.exact ? 'exact-hit' : 'actionable-ancestor',
		}
	}

	const associated = getAssociatedControl(action, hit)
	if (associated) return associated

	return null
}

function rectDistance(point: { x: number; y: number }, element: HTMLElement): number {
	const rect = element.getBoundingClientRect()
	const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
	const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
	return Math.hypot(dx, dy)
}

function elementCenter(element: HTMLElement): { x: number; y: number } {
	const rect = element.getBoundingClientRect()
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function sampleOffsets(radius: number): Array<{ x: number; y: number }> {
	const diagonal = radius / Math.SQRT2
	return [
		{ x: radius, y: 0 },
		{ x: -radius, y: 0 },
		{ x: 0, y: radius },
		{ x: 0, y: -radius },
		{ x: diagonal, y: diagonal },
		{ x: diagonal, y: -diagonal },
		{ x: -diagonal, y: diagonal },
		{ x: -diagonal, y: -diagonal },
	]
}

function candidateAt(action: PointActionKind, x: number, y: number): HTMLElement | null {
	const hit = topHitAt(x, y)
	if (!hit) return null
	return resolveFromHit(action, hit)?.element ?? null
}

export function resolveActionTarget(
	action: PointActionKind,
	point: { x: number; y: number },
	options: { maxRadiusPx?: number } = {}
): ResolvedTarget {
	const originalPoint = { ...point }
	const hit = topHitAt(point.x, point.y)

	if (hit) {
		const direct = resolveFromHit(action, hit)
		if (direct) {
			return {
				element: direct.element,
				method: direct.method,
				originalPoint,
				resolvedPoint: elementCenter(direct.element),
				confidence: direct.method === 'exact-hit' ? 1 : 0.98,
				abstained: false,
			}
		}
	}

	const maxRadiusPx = Math.max(0, Math.min(24, options.maxRadiusPx ?? 24))
	const radii = [8, 16, 24].filter((radius) => radius <= maxRadiusPx)

	for (const radius of radii) {
		const candidates = new Map<HTMLElement, number>()
		for (const offset of sampleOffsets(radius)) {
			const candidate = candidateAt(action, point.x + offset.x, point.y + offset.y)
			if (!candidate) continue
			candidates.set(candidate, rectDistance(point, candidate))
		}

		if (candidates.size === 0) continue

		const ranked = [...candidates.entries()].sort((a, b) => a[1] - b[1])
		const [best, bestDistance] = ranked[0]!
		const secondDistance = ranked[1]?.[1]

		// Adjacent controls at effectively the same distance are ambiguous. Do not
		// turn a harmless near miss into a click on an arbitrary neighbor.
		if (secondDistance !== undefined && Math.abs(secondDistance - bestDistance) < 2) {
			return {
				method: 'raw-point',
				originalPoint,
				confidence: 0,
				abstained: true,
				ambiguous: true,
				radius,
			}
		}

		return {
			element: best,
			method: 'nearby',
			originalPoint,
			resolvedPoint: elementCenter(best),
			confidence: radius === 8 ? 0.9 : radius === 16 ? 0.8 : 0.7,
			abstained: false,
			radius,
		}
	}

	return {
		method: 'raw-point',
		originalPoint,
		confidence: 0,
		abstained: true,
	}
}
