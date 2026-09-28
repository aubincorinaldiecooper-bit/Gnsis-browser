import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveActionTarget } from './resolveTarget'

type Box = [number, number, number, number]

/**
 * happy-dom has no layout engine, so each fixture element declares its box via
 * `data-box="x y w h"`. Hit-testing returns last-painted elements first.
 */
function mount(html: string) {
	document.body.innerHTML = html
	const boxes = new Map<Element, Box>()

	for (const element of document.querySelectorAll('[data-box]')) {
		const [x, y, width, height] = element.getAttribute('data-box')!.split(' ').map(Number)
		boxes.set(element, [x, y, width, height])
	}

	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: Element
	) {
		const [x, y, width, height] = boxes.get(this) ?? [0, 0, 0, 0]
		return {
			x,
			y,
			width,
			height,
			left: x,
			top: y,
			right: x + width,
			bottom: y + height,
			toJSON: () => ({}),
		}
	})

	const hitsAt = (px: number, py: number): Element[] =>
		[...boxes.entries()]
			.filter(([element, [x, y, width, height]]) => {
				const style = getComputedStyle(element)
				if (
					style.display === 'none' ||
					style.visibility === 'hidden' ||
					style.pointerEvents === 'none'
				) {
					return false
				}
				return px >= x && px < x + width && py >= y && py < y + height
			})
			.map(([element]) => element)
			.reverse()

	document.elementFromPoint = (px: number, py: number) => hitsAt(px, py)[0] ?? null
	document.elementsFromPoint = (px: number, py: number) => hitsAt(px, py)

	return (id: string) => document.getElementById(id)!
}

beforeEach(() => {
	vi.restoreAllMocks()
})

afterEach(() => {
	document.body.innerHTML = ''
})

describe('resolveActionTarget', () => {
	it('resolves a span inside a button to the button', () => {
		const $ = mount(
			'<button id="b" data-box="0 0 100 40"><span id="s" data-box="10 10 50 20">Save</span></button>'
		)
		const result = resolveActionTarget('click', { x: 20, y: 20 })

		expect(result.element).toBe($('b'))
		expect(result.method).toBe('actionable-ancestor')
	})

	it('resolves an svg path inside a close button to the button', () => {
		const $ = mount(
			'<button id="x" aria-label="Close" data-box="0 0 24 24"><svg data-box="4 4 16 16"><path data-box="6 6 12 12"></path></svg></button>'
		)
		const result = resolveActionTarget('click', { x: 10, y: 10 })

		expect(result.element).toBe($('x'))
		expect(result.method).toBe('actionable-ancestor')
	})

	it('associates label[for] with its input for typing', () => {
		const $ = mount(
			'<label for="email" data-box="0 0 80 20">Email</label><input id="email" data-box="0 30 200 30">'
		)
		const result = resolveActionTarget('type', { x: 10, y: 10 })

		expect(result.element).toBe($('email'))
		expect(result.method).toBe('label-control')
	})

	it('associates a wrapping label with its input', () => {
		const $ = mount(
			'<label data-box="0 0 300 40">Name <input id="n" data-box="60 5 200 30"></label>'
		)
		const result = resolveActionTarget('type', { x: 10, y: 10 })

		expect(result.element).toBe($('n'))
		expect(['label-control', 'wrapped-label-control']).toContain(result.method)
	})

	it('does not associate an unlinked label with a nearby input', () => {
		mount('<label data-box="0 0 80 20">Email</label><input id="i" data-box="0 60 200 30">')
		const result = resolveActionTarget('type', { x: 10, y: 10 })

		expect(result.abstained).toBe(true)
	})

	it('recovers a near miss beside a small control', () => {
		const $ = mount(
			'<div data-box="0 0 400 200"><button id="b" data-box="100 100 30 20">Go</button></div>'
		)
		const result = resolveActionTarget('click', { x: 95, y: 110 })

		expect(result.element).toBe($('b'))
		expect(result.method).toBe('nearby')
		expect(result.radius).toBe(8)
	})

	it('abstains between two adjacent buttons', () => {
		mount(
			'<div data-box="0 0 400 200"><button data-box="100 100 30 20">A</button><button data-box="140 100 30 20">B</button></div>'
		)
		const result = resolveActionTarget('click', { x: 135, y: 110 })

		expect(result.abstained).toBe(true)
		expect(result.ambiguous).toBe(true)
	})

	it('abstains between two adjacent inputs', () => {
		mount(
			'<div data-box="0 0 400 200"><input data-box="0 100 200 30"><input data-box="0 140 200 30"></div>'
		)
		const result = resolveActionTarget('type', { x: 50, y: 135 })

		expect(result.abstained).toBe(true)
	})

	it('skips disabled and hidden controls', () => {
		mount(
			'<div data-box="0 0 400 200"><button disabled data-box="100 100 30 20">A</button><button style="visibility:hidden" data-box="100 130 30 20">B</button></div>'
		)

		expect(resolveActionTarget('click', { x: 110, y: 110 }).abstained).toBe(true)
		expect(resolveActionTarget('click', { x: 110, y: 138 }).abstained).toBe(true)
	})

	it('does not look through an overlay covering a control', () => {
		mount(
			'<button data-box="100 100 30 20">Under</button><div id="ov" data-box="0 0 400 400"><p data-box="10 10 100 20">Promo</p></div>'
		)
		const result = resolveActionTarget('click', { x: 110, y: 110 })

		expect(result.abstained).toBe(true)
	})

	it('does not reinterpret a button as a text field', () => {
		mount('<div data-box="0 0 400 200"><button data-box="0 0 100 30">Send</button></div>')

		expect(resolveActionTarget('type', { x: 10, y: 10 }).abstained).toBe(true)
	})

	it('resolves a select via its label but not via an unrelated click target', () => {
		const $ = mount(
			'<label for="c" data-box="0 0 80 20">Country</label><select id="c" data-box="0 30 200 30"></select><button data-box="0 80 80 20">Go</button>'
		)

		expect(resolveActionTarget('select', { x: 10, y: 10 }).element).toBe($('c'))
		expect(resolveActionTarget('select', { x: 10, y: 90 }).abstained).toBe(true)
	})

	it('resolves a contenteditable child to the editing host', () => {
		const $ = mount(
			'<div id="ed" contenteditable="true" data-box="0 0 300 100"><p id="p" data-box="0 0 300 20">x</p></div>'
		)
		const result = resolveActionTarget('type', { x: 10, y: 10 })

		expect(result.element).toBe($('ed'))
		expect(result.method).toBe('actionable-ancestor')
	})

	it('abstains when no actionable element is nearby', () => {
		mount('<main data-box="0 0 800 600"><p data-box="10 10 300 20">Just text</p></main>')
		const result = resolveActionTarget('click', { x: 400, y: 400 })

		expect(result.abstained).toBe(true)
		expect(result.method).toBe('raw-point')
	})
})
