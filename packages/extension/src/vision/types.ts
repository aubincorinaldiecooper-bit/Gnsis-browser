export interface VisualTarget {
	id: string
	label: string
	role: string
	point: { x: number; y: number }
	affordances: string[]
}

export interface VisualState {
	summary: string
	change: string
	pageStable: boolean
	targets: VisualTarget[]
}

export interface PanopticTemporalState {
	type: 'temporal_state'
	session_id: string
	tab_id: number
	frame_id: string
	epoch: number
	round_idx: number
	state: 'silence' | 'standby' | 'response'
	content: string
	time_start: number
	time_end: number
	frames_in_round: number
	high_res_flags: boolean[]
	high_res_frames_remaining: number
}

export type VisualAction =
	| { kind: 'CLICK'; target: VisualTarget; confidence: number }
	| { kind: 'TYPE_TEXT'; target: VisualTarget; text: string; confidence: number }
	| { kind: 'SELECT'; target: VisualTarget; optionText: string; confidence: number }
	| { kind: 'SCROLL'; direction: 'up' | 'down'; amount: 'small' | 'page'; confidence: number }
	| { kind: 'SCROLL_HORIZONTAL'; direction: 'left' | 'right'; pixels: number; confidence: number }
	| { kind: 'OPEN_URL'; url: string; confidence: number }
	| { kind: 'SWITCH_TAB'; tabId: number; confidence: number }
	| { kind: 'CLOSE_TAB'; tabId: number; confidence: number }
	| { kind: 'WAIT'; confidence: number }
	| { kind: 'DONE'; confidence: number }

export interface BrowserTabState {
	id: number
	current: boolean
	title: string
	url: string
}

export interface DecisionContext {
	task: string
	visual: VisualState
	tabs: BrowserTabState[]
}
