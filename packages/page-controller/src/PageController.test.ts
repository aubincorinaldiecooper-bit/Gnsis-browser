import { afterEach, describe, expect, it, vi } from 'vitest'

import { PageController } from './PageController'

describe('PageController', () => {
	it('constructs and exposes the current url', async () => {
		const controller = new PageController()
		expect(controller).toBeInstanceOf(PageController)
		expect(await controller.getCurrentUrl()).toBe(window.location.href)
	})


	afterEach(() => {
		vi.restoreAllMocks()
		document.body.innerHTML = ''
	})

	describe('visual point resolution', () => {
		function installHitTest(boxes: Array<{ element: HTMLElement; x: number; y: number; width: number; height: number }>) {
			vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
				this: Element
			) {
				const box = boxes.find((candidate) => candidate.element === this)
				?? { x: 0, y: 0, width: 0, height: 0 }
				return {
					x: box.x,
					y: box.y,
					width: box.width,
					height: box.height,
					left: box.x,
					top: box.y,
					right: box.x + box.width,
					bottom: box.y + box.height,
					toJSON: () => ({}),
				}
			})

			const hitsAt = (x: number, y: number): Element[] =>
				boxes
					.filter((box) =>
						x >= box.x &&
						x < box.x + box.width &&
						y >= box.y &&
						y < box.y + box.height
					)
					.map((box) => box.element)
					.reverse()

			document.elementFromPoint = (x: number, y: number) => hitsAt(x, y)[0] ?? null
			document.elementsFromPoint = (x: number, y: number) => hitsAt(x, y)
		}

		it('does not fall back to a raw click when resolver abstains', async () => {
			document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>'
			const a = document.getElementById('a') as HTMLButtonElement
			const b = document.getElementById('b') as HTMLButtonElement
			const clicked = vi.fn()
			a.addEventListener('click', clicked)
			b.addEventListener('click', clicked)

			installHitTest([
				{ element: a, x: 100, y: 100, width: 30, height: 20 },
				{ element: b, x: 140, y: 100, width: 30, height: 20 },
			])

			const controller = new PageController()
			const point = {
				x: 135 / window.innerWidth,
				y: 110 / window.innerHeight,
			}
			const result = await controller.clickPoint(point, {
				resolveTarget: true,
				maxRadiusPx: 24,
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain('abstained')
			expect(clicked).not.toHaveBeenCalled()
		})

		it('preserves raw-point execution when resolver is disabled', async () => {
			document.body.innerHTML = '<button id="a">A</button>'
			const a = document.getElementById('a') as HTMLButtonElement
			const clicked = vi.fn()
			a.addEventListener('click', clicked)

			installHitTest([{ element: a, x: 100, y: 100, width: 30, height: 20 }])

			const controller = new PageController()
			const point = {
				x: 110 / window.innerWidth,
				y: 110 / window.innerHeight,
			}
			const result = await controller.clickPoint(point, { resolveTarget: false })

			expect(result.success).toBe(true)
			expect(clicked).toHaveBeenCalledTimes(1)
		})
	})

	describe('executeJavascript', () => {
		it('runs a script and returns its result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return 1 + 2')
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('3')
		})

		it('exposes the abort signal to the script scope', async () => {
			const controller = new PageController()
			const controllerSignal = new AbortController()
			controllerSignal.abort()

			const result = await controller.executeJavascript(
				'return signal.aborted',
				controllerSignal.signal
			)
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('true')
		})

		it('reports a syntax error as a failed result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return (')
			expect(result.success).toBe(false)
			expect(result.message).toContain('❌')
		})
	})
})
