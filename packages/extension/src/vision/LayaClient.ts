import type { DecisionContext, VisualAction, VisualState, VisualTarget } from './types'

interface LayaChoiceAnswer {
	choice?: string
	confidence?: number
	probabilities?: Record<string, number>
}

interface LayaResponse {
	answers?: { action?: LayaChoiceAnswer }
	error?: string
}

export interface LayaClientConfig {
	baseUrl?: string
	fetchImpl?: typeof fetch
	minConfidence?: number
}

interface ActionCandidate {
	key: string
	label: string
	action: Omit<VisualAction, 'confidence'>
}

function jsonObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim()
	const start = trimmed.indexOf('{')
	const end = trimmed.lastIndexOf('}')
	if (start < 0 || end <= start) return null
	try {
		const value = JSON.parse(trimmed.slice(start, end + 1))
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
	} catch {
		return null
	}
}

export function parseVisualState(content: string): VisualState {
	const value = jsonObject(content)
	if (!value) {
		return {
			summary: content.trim().slice(0, 2000),
			change: '',
			pageStable: false,
			targets: [],
		}
	}

	const targets: VisualTarget[] = []
	for (const row of Array.isArray(value.targets) ? value.targets : []) {
		if (!row || typeof row !== 'object') continue
		const target = row as Record<string, unknown>
		const point = target.point as Record<string, unknown> | undefined
		const x = Number(point?.x)
		const y = Number(point?.y)
		const id = typeof target.id === 'string' ? target.id.trim() : ''
		if (!id || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
			continue
		}
		targets.push({
			id,
			label: typeof target.label === 'string' ? target.label.trim().slice(0, 300) : '',
			role: typeof target.role === 'string' ? target.role.trim().slice(0, 80) : 'other',
			point: { x, y },
			affordances: Array.isArray(target.affordances)
				? target.affordances
						.filter((item): item is string => typeof item === 'string')
						.map((item) => item.toUpperCase())
						.slice(0, 8)
				: [],
		})
		if (targets.length >= 12) break
	}

	return {
		summary: typeof value.summary === 'string' ? value.summary.trim().slice(0, 2000) : '',
		change: typeof value.change === 'string' ? value.change.trim().slice(0, 1000) : '',
		pageStable: value.page_stable === true,
		targets,
	}
}

export function extractTextCandidates(task: string): string[] {
	const found: string[] = []
	const add = (value: string | undefined) => {
		const normalized = value?.trim().replace(/[.,;:]$/, '')
		if (normalized && normalized.length <= 500 && !found.includes(normalized)) found.push(normalized)
	}

	for (const match of task.matchAll(/["“](.+?)["”]/g)) add(match[1])
	for (const match of task.matchAll(/'(.*?)'/g)) add(match[1])
	for (const match of task.matchAll(
		/\b(?:type|enter|input|search(?:\s+for)?)\s+(.+?)(?:\s+(?:into|in|and|then)\b|$)/gi
	)) {
		add(match[1])
	}
	return found.slice(0, 4)
}

function extractUrl(task: string): string | null {
	return task.match(/https?:\/\/[^\s)"']+/i)?.[0] ?? null
}

function actionCandidates(context: DecisionContext): ActionCandidate[] {
	const result: ActionCandidate[] = []
	const texts = extractTextCandidates(context.task)

	for (const target of context.visual.targets) {
		const affordances = new Set(target.affordances)
		if (affordances.has('CLICK') || target.role !== 'input') {
			result.push({
				key: `click:${target.id}`,
				label: `Click "${target.label || target.id}" (${target.role})`,
				action: { kind: 'CLICK', target },
			})
		}
		if (affordances.has('TYPE_TEXT') || target.role === 'input') {
			for (let index = 0; index < texts.length; index++) {
				result.push({
					key: `type:${target.id}:${index}`,
					label: `Type "${texts[index]}" into "${target.label || target.id}"`,
					action: { kind: 'TYPE_TEXT', target, text: texts[index] },
				})
			}
		}
	}

	result.push(
		{
			key: 'scroll:down:small',
			label: 'Scroll down a small amount to reveal more of the current page',
			action: { kind: 'SCROLL', direction: 'down', amount: 'small' },
		},
		{
			key: 'scroll:down:page',
			label: 'Scroll down about one viewport',
			action: { kind: 'SCROLL', direction: 'down', amount: 'page' },
		},
		{
			key: 'scroll:up:small',
			label: 'Scroll up a small amount',
			action: { kind: 'SCROLL', direction: 'up', amount: 'small' },
		}
	)

	const explicitUrl = extractUrl(context.task)
	if (explicitUrl) {
		result.push({
			key: 'open:explicit-url',
			label: `Open the URL explicitly requested by the user: ${explicitUrl}`,
			action: { kind: 'OPEN_URL', url: explicitUrl },
		})
	}
	result.push({
		key: 'open:web-search',
		label: `Open a web search for the user's task: ${context.task.slice(0, 300)}`,
		action: {
			kind: 'OPEN_URL',
			url: `https://www.google.com/search?q=${encodeURIComponent(context.task)}`,
		},
	})

	for (const tab of context.tabs) {
		if (!tab.current) {
			result.push({
				key: `switch:${tab.id}`,
				label: `Switch to tab ${tab.id}: ${tab.title || tab.url}`,
				action: { kind: 'SWITCH_TAB', tabId: tab.id },
			})
		}
	}

	result.push(
		{ key: 'wait', label: 'Wait for the visible browser state to change', action: { kind: 'WAIT' } },
		{
			key: 'done',
			label: 'The user task is visibly complete; stop without another browser action',
			action: { kind: 'DONE' },
		}
	)

	// Laya's bounded-choice head is most reliable with <=20 flat options.
	return result.slice(0, 20)
}

export function buildActionQuestion(context: DecisionContext): {
	state: Record<string, unknown>
	criteria: Record<string, string>
	byKey: Map<string, ActionCandidate>
} {
	const options = actionCandidates(context)
	return {
		state: {
			task: context.task,
			visual_summary: context.visual.summary,
			visual_change: context.visual.change,
			page_stable: context.visual.pageStable,
			tabs: context.tabs,
		},
		criteria: Object.fromEntries(options.map((option) => [option.key, option.label])),
		byKey: new Map(options.map((option) => [option.key, option])),
	}
}

export class LayaClient {
	private baseUrl: string
	private fetchImpl: typeof fetch
	private minConfidence: number

	constructor(config: LayaClientConfig = {}) {
		this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:8791').replace(/\/$/, '')
		this.fetchImpl = config.fetchImpl ?? fetch
		this.minConfidence = config.minConfidence ?? 0.5
	}

	async decide(context: DecisionContext, signal?: AbortSignal): Promise<VisualAction> {
		const built = buildActionQuestion(context)
		const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				state: built.state,
				questions: {
					action: {
						type: 'choice',
						instructions:
							'Choose exactly one bounded browser action that best advances the user task from the current Panoptic state. Never invent a target, value, URL, tab, or action.',
						criteria: built.criteria,
					},
				},
				model: 'laya',
			}),
			signal,
		})

		const body = (await response.json().catch(() => ({}))) as LayaResponse
		if (!response.ok) throw new Error(body.error || `Laya returned HTTP ${response.status}`)

		const answer = body.answers?.action
		const choice = answer?.choice
		const confidence = Number(answer?.confidence ?? answer?.probabilities?.[choice ?? ''] ?? 0)
		if (!choice || !built.byKey.has(choice) || !Number.isFinite(confidence)) {
			throw new Error('Laya returned an invalid bounded action')
		}
		if (confidence < this.minConfidence) return { kind: 'WAIT', confidence }

		return { ...built.byKey.get(choice)!.action, confidence } as VisualAction
	}
}
