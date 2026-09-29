/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * PageController - Manages DOM operations and element interactions.
 * Designed to be independent of LLM and can be tested in unit tests.
 * All public methods are async for potential remote calling support.
 */
import {
	clickElement,
	getElementByIndex,
	inputTextElement,
	scrollHorizontally,
	scrollVertically,
	selectOptionElement,
} from './actions'
import * as dom from './dom'
import type { FlatDomTree, InteractiveElementDomNode } from './dom/dom_tree/type'
import { getPageInfo } from './dom/getPageInfo'
import { patchReact } from './patches/react'
import { type PointActionKind, type PointActionOptions, resolveActionTarget } from './resolveTarget'
import { isAnchorElement } from './utils'

/**
 * Configuration for PageController
 */
export interface PageControllerConfig extends dom.DomConfig {
	/** Enable visual mask overlay during operations (default: false) */
	enableMask?: boolean
}

/**
 * Structured browser state for LLM consumption
 */
export interface BrowserState {
	url: string
	title: string
	/** Page info + scroll position hint (e.g. "Page info: 1920x1080px...\n[Start of page]") */
	header: string
	/** Simplified HTML of interactive elements */
	content: string
	/** Page footer hint (e.g. "... 300 pixels below ..." or "[End of page]") */
	footer: string
}

/**
 * The page's layout viewport when a visual point was mapped onto it.
 *
 * `resolvedPoint` and `targetBox` are in these CSS pixels. Reporting the size
 * lets GNSIS relate them to the pixels of the frame the point came from.
 */
export interface PageViewportSnapshot {
	width: number
	height: number
	devicePixelRatio: number
	scrollX: number
	scrollY: number
}

export interface ActionExecutionMetadata {
	method: string
	resolvedPoint?: { x: number; y: number }
	targetBox?: { x: number; y: number; width: number; height: number }
	viewport?: PageViewportSnapshot
}

interface ActionResult {
	success: boolean
	message: string
	execution?: ActionExecutionMetadata
}

/**
 * PageController manages DOM state and element interactions.
 * It provides async methods for all DOM operations, keeping state isolated.
 *
 * @lifecycle
 * - beforeUpdate: Emitted before the DOM tree is updated.
 * - afterUpdate: Emitted after the DOM tree is updated.
 */
export class PageController extends EventTarget {
	private config: PageControllerConfig

	/** Corresponds to eval_page in browser-use */
	private flatTree: FlatDomTree | null = null

	/**
	 * All highlighted index-mapped interactive elements
	 * Corresponds to DOMState.selector_map in browser-use
	 */
	private selectorMap = new Map<number, InteractiveElementDomNode>()

	/** Index -> element text description mapping */
	private elementTextMap = new Map<number, string>()

	/**
	 * Simplified HTML for LLM consumption.
	 * Corresponds to clickable_elements_to_string in browser-use
	 */
	private simplifiedHTML = '<EMPTY>'

	/** last time the tree was updated */
	private lastTimeUpdate = 0

	/** Whether the tree has been indexed at least once */
	private isIndexed = false

	/** Visual mask overlay for blocking user interaction during automation */
	private mask: InstanceType<typeof import('./mask/SimulatorMask').SimulatorMask> | null = null
	private maskReady: Promise<void> | null = null

	constructor(config: PageControllerConfig = {}) {
		super()

		this.config = config

		patchReact(this)

		if (config.enableMask) this.initMask()
	}

	/**
	 * Initialize mask asynchronously (dynamic import to avoid CSS loading in Node)
	 */
	initMask() {
		if (this.maskReady !== null) return
		this.maskReady = (async () => {
			const { SimulatorMask } = await import('./mask/SimulatorMask')
			this.mask = new SimulatorMask()
		})()
	}
	// ======= State Queries =======

	/**
	 * Get current page URL
	 */
	async getCurrentUrl(): Promise<string> {
		return window.location.href
	}

	/**
	 * Get last tree update timestamp
	 */
	async getLastUpdateTime(): Promise<number> {
		return this.lastTimeUpdate
	}

	/**
	 * Get structured browser state for LLM consumption.
	 * Automatically calls updateTree() to refresh the DOM state.
	 */
	async getBrowserState(): Promise<BrowserState> {
		const url = window.location.href
		const title = document.title
		const pi = getPageInfo()
		const viewportExpansion = dom.resolveViewportExpansion(this.config.viewportExpansion)

		await this.updateTree()

		const content = this.simplifiedHTML

		// Build header: page info + scroll position hint
		const titleLine = `Current Page: [${title}](${url})`

		const pageInfoLine = `Page info: ${pi.viewport_width}x${pi.viewport_height}px viewport, ${pi.page_width}x${pi.page_height}px total page size, ${pi.pages_above.toFixed(1)} pages above, ${pi.pages_below.toFixed(1)} pages below, ${pi.total_pages.toFixed(1)} total pages, at ${(pi.current_page_position * 100).toFixed(0)}% of page`

		const elementsLabel =
			viewportExpansion === -1
				? 'Interactive elements from top layer of the current page (full page):'
				: 'Interactive elements from top layer of the current page inside the viewport:'

		const hasContentAbove = pi.pixels_above > 4
		const scrollHintAbove =
			hasContentAbove && viewportExpansion !== -1
				? `... ${pi.pixels_above} pixels above (${pi.pages_above.toFixed(1)} pages) - scroll to see more ...`
				: '[Start of page]'

		const header = `${titleLine}\n${pageInfoLine}\n\n${elementsLabel}\n\n${scrollHintAbove}`

		// Build footer: scroll position hint
		const hasContentBelow = pi.pixels_below > 4
		const footer =
			hasContentBelow && viewportExpansion !== -1
				? `... ${pi.pixels_below} pixels below (${pi.pages_below.toFixed(1)} pages) - scroll to see more ...`
				: '[End of page]'

		return { url, title, header, content, footer }
	}

	// ======= DOM Tree Operations =======

	/**
	 * Update DOM tree, returns simplified HTML for LLM.
	 * This is the main method to refresh the page state.
	 * Automatically bypasses mask during DOM extraction if enabled.
	 */
	async updateTree(): Promise<string> {
		this.dispatchEvent(new Event('beforeUpdate'))

		this.lastTimeUpdate = Date.now()

		// Temporarily bypass mask to allow DOM extraction
		if (this.mask) {
			this.mask.wrapper.style.pointerEvents = 'none'
		}

		dom.cleanUpHighlights()

		const blacklist = [
			...(this.config.interactiveBlacklist || []),
			...Array.from(document.querySelectorAll('[data-page-agent-not-interactive]')),
		]

		this.flatTree = dom.getFlatTree({
			...this.config,
			interactiveBlacklist: blacklist,
		})

		this.simplifiedHTML = dom.flatTreeToString(
			this.flatTree,
			this.config.includeAttributes,
			this.config.keepSemanticTags
		)

		this.selectorMap.clear()
		this.selectorMap = dom.getSelectorMap(this.flatTree)

		this.elementTextMap.clear()
		this.elementTextMap = dom.getElementTextMap(this.simplifiedHTML)

		// Mark as indexed - now element actions are allowed
		this.isIndexed = true

		// Restore mask blocking
		if (this.mask) {
			this.mask.wrapper.style.pointerEvents = 'auto'
		}

		this.dispatchEvent(new Event('afterUpdate'))

		return this.simplifiedHTML
	}

	/**
	 * Clean up all element highlights
	 */
	async cleanUpHighlights(): Promise<void> {
		console.log('[PageController] cleanUpHighlights')
		dom.cleanUpHighlights()
	}

	// ======= Element Actions =======

	/**
	 * Ensure the tree has been indexed before any index-based operation.
	 * Throws if updateTree() hasn't been called yet.
	 */
	private assertIndexed(): void {
		if (!this.isIndexed) {
			throw new Error('DOM tree not indexed yet. Can not perform actions on elements.')
		}
	}

	/**
	 * Convert the normalized visual point emitted by Panoptic/Laya to CSS
	 * viewport pixels. Resolution happens only after the visual target and
	 * bounded action are already selected.
	 */
	private getViewportPoint(point: { x: number; y: number }): {
		normalized: { x: number; y: number }
		css: { x: number; y: number }
	} {
		const normalized = {
			x: Math.min(1, Math.max(0, point.x)),
			y: Math.min(1, Math.max(0, point.y)),
		}
		const css = {
			x: Math.min(window.innerWidth - 1, Math.max(0, normalized.x * window.innerWidth)),
			y: Math.min(window.innerHeight - 1, Math.max(0, normalized.y * window.innerHeight)),
		}
		return { normalized, css }
	}

	private viewportSnapshot(): PageViewportSnapshot {
		return {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
			scrollX: window.scrollX,
			scrollY: window.scrollY,
		}
	}

	private getElementAtPoint(point: { x: number; y: number }): HTMLElement {
		const { normalized, css } = this.getViewportPoint(point)
		const hit = document.elementFromPoint(css.x, css.y)
		if (!(hit instanceof HTMLElement)) {
			throw new Error(
				`No HTMLElement found at visual point (${normalized.x.toFixed(3)}, ${normalized.y.toFixed(3)})`
			)
		}
		return hit
	}

	private resolveElementAtPoint(
		action: PointActionKind,
		point: { x: number; y: number },
		options: PointActionOptions
	): { element: HTMLElement; method: string; resolvedPoint: { x: number; y: number } } {
		if (options.resolveTarget) {
			const { css } = this.getViewportPoint(point)
			const resolved = resolveActionTarget(action, css, {
				maxRadiusPx: options.maxRadiusPx,
			})
			if (resolved.element) {
				return {
					element: resolved.element,
					method: resolved.method,
					resolvedPoint: resolved.resolvedPoint ?? css,
				}
			}

			const reason = resolved.ambiguous ? 'ambiguous nearby controls' : 'no safe actionable target'
			throw new Error(`Actuator target resolution abstained: ${reason}`)
		}

		const { css } = this.getViewportPoint(point)
		return { element: this.getElementAtPoint(point), method: 'raw-point', resolvedPoint: css }
	}

	async clickPoint(
		point: { x: number; y: number },
		options: PointActionOptions = {}
	): Promise<ActionResult> {
		try {
			const { element, method, resolvedPoint } = this.resolveElementAtPoint('click', point, options)
			const viewport = this.viewportSnapshot()
			const rect = element.getBoundingClientRect()
			await clickElement(element)
			return {
				success: true,
				message: `✅ Clicked visual target at (${point.x.toFixed(3)}, ${point.y.toFixed(3)}) via ${method}.`,
				execution: {
					method,
					resolvedPoint,
					targetBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					viewport,
				},
			}
		} catch (error) {
			return { success: false, message: `❌ Failed to click visual target: ${error}` }
		}
	}

	async inputTextAtPoint(
		point: { x: number; y: number },
		text: string,
		options: PointActionOptions = {}
	): Promise<ActionResult> {
		try {
			let { element, method, resolvedPoint } = this.resolveElementAtPoint('type', point, options)
			const viewport = this.viewportSnapshot()
			if (
				!(element instanceof HTMLInputElement) &&
				!(element instanceof HTMLTextAreaElement) &&
				!element.isContentEditable
			) {
				const candidate = element.closest<HTMLElement>('input, textarea, [contenteditable="true"]')
				if (candidate) {
					element = candidate
					method = 'actionable-ancestor'
				}
			}
			const rect = element.getBoundingClientRect()
			await inputTextElement(element, text)
			return {
				success: true,
				message: `✅ Typed into visual target at (${point.x.toFixed(3)}, ${point.y.toFixed(3)}) via ${method}.`,
				execution: {
					method,
					resolvedPoint,
					targetBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					viewport,
				},
			}
		} catch (error) {
			return { success: false, message: `❌ Failed to type into visual target: ${error}` }
		}
	}

	async selectOptionAtPoint(
		point: { x: number; y: number },
		optionText: string,
		options: PointActionOptions = {}
	): Promise<ActionResult> {
		try {
			let { element, method, resolvedPoint } = this.resolveElementAtPoint('select', point, options)
			const viewport = this.viewportSnapshot()
			if (!(element instanceof HTMLSelectElement)) {
				const candidate = element.closest('select')
				if (candidate instanceof HTMLSelectElement) {
					element = candidate
					method = 'actionable-ancestor'
				}
			}
			if (!(element instanceof HTMLSelectElement)) {
				throw new Error('Visual target is not a select element')
			}
			const rect = element.getBoundingClientRect()
			await selectOptionElement(element, optionText)
			return {
				success: true,
				message: `✅ Selected option (${optionText}) at visual target via ${method}.`,
				execution: {
					method,
					resolvedPoint,
					targetBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					viewport,
				},
			}
		} catch (error) {
			return { success: false, message: `❌ Failed to select visual target: ${error}` }
		}
	}

	async scrollViewport(options: {
		direction: 'up' | 'down' | 'left' | 'right'
		amount: 'small' | 'page'
		/** Optional exact viewport fraction for adapter parity. */
		fraction?: number
	}): Promise<ActionResult> {
		try {
			const horizontal = options.direction === 'left' || options.direction === 'right'
			const extent = horizontal ? window.innerWidth : window.innerHeight
			const fraction =
				options.fraction == null
					? options.amount === 'page'
						? 0.9
						: 0.35
					: Math.min(1, Math.max(0, options.fraction))
			const positive = options.direction === 'down' || options.direction === 'right'
			const pixels = extent * fraction * (positive ? 1 : -1)
			const message = horizontal ? await scrollHorizontally(pixels) : await scrollVertically(pixels)
			return { success: true, message }
		} catch (error) {
			return { success: false, message: `❌ Failed to scroll viewport: ${error}` }
		}
	}

	/**
	 * Click element by index
	 */
	async clickElement(index: number): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			const elemText = this.elementTextMap.get(index)
			await clickElement(element)

			// Handle links that open in new tabs
			if (isAnchorElement(element) && element.target === '_blank') {
				return {
					success: true,
					message: `✅ Clicked element (${elemText ?? index}). ⚠️ Link opened in a new tab.`,
				}
			}

			return {
				success: true,
				message: `✅ Clicked element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to click element: ${error}`,
			}
		}
	}

	/**
	 * Input text into element by index
	 */
	async inputText(index: number, text: string): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			const elemText = this.elementTextMap.get(index)
			await inputTextElement(element, text)

			return {
				success: true,
				message: `✅ Input text (${text}) into element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to input text: ${error}`,
			}
		}
	}

	/**
	 * Select dropdown option by index and option text
	 */
	async selectOption(index: number, optionText: string): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			const elemText = this.elementTextMap.get(index)
			await selectOptionElement(element as HTMLSelectElement, optionText)

			return {
				success: true,
				message: `✅ Selected option (${optionText}) in element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to select option: ${error}`,
			}
		}
	}

	/**
	 * Scroll vertically
	 */
	async scroll(options: {
		down: boolean
		numPages: number
		pixels?: number
		index?: number
	}): Promise<ActionResult> {
		try {
			const { down, numPages, pixels, index } = options

			this.assertIndexed()

			const scrollAmount = (pixels ?? numPages * window.innerHeight) * (down ? 1 : -1)

			const element = index !== undefined ? getElementByIndex(this.selectorMap, index) : null

			const message = await scrollVertically(scrollAmount, element)

			return {
				success: true,
				message,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to scroll: ${error}`,
			}
		}
	}

	/**
	 * Scroll horizontally
	 */
	async scrollHorizontally(options: {
		right: boolean
		pixels: number
		index?: number
	}): Promise<ActionResult> {
		try {
			const { right, pixels, index } = options

			this.assertIndexed()

			const scrollAmount = pixels * (right ? 1 : -1)

			const element = index !== undefined ? getElementByIndex(this.selectorMap, index) : null

			const message = await scrollHorizontally(scrollAmount, element)

			return {
				success: true,
				message,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to scroll horizontally: ${error}`,
			}
		}
	}

	/**
	 * Execute arbitrary JavaScript on the page.
	 * The optional `signal` is exposed to the script scope so cooperative code
	 * can abort promptly when the task is stopped.
	 */
	async executeJavascript(script: string, signal?: AbortSignal): Promise<ActionResult> {
		try {
			// Wrap script in async function to support await, exposing `signal`.
			const asyncFunction = eval(`(async (signal) => { ${script} })`)
			const result = await asyncFunction(signal)
			return {
				success: true,
				message: `✅ Executed JavaScript. Result: ${result}`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Error executing JavaScript: ${error}`,
			}
		}
	}

	// ======= Mask Operations =======

	/**
	 * Show the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async showMask(): Promise<void> {
		await this.maskReady
		this.mask?.show()
	}

	/**
	 * Hide the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async hideMask(): Promise<void> {
		await this.maskReady
		this.mask?.hide()
	}

	/**
	 * Dispose and clean up resources
	 */
	dispose(): void {
		dom.cleanUpHighlights()
		this.flatTree = null
		this.selectorMap.clear()
		this.elementTextMap.clear()
		this.simplifiedHTML = '<EMPTY>'
		this.isIndexed = false
		this.mask?.dispose()
		this.mask = null
	}
}

export * from './actions'
export * from './resolveTarget'
