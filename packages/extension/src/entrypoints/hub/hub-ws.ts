/**
 * Hub WebSocket Protocol
 *
 * Hub connects as WS client to `ws://localhost:{port}`.
 * All messages are JSON. One task or browser action at a time.
 *
 * Inbound (Caller → Hub):
 *   { type: "execute", task: string, config?: object }
 *   { type: "stop", call_id?: string }
 *   { type: "browser.action", call_id, frame_id?, source_tab_id?, decision }   (GNSIS)
 *   { type: "capture.start", fps?, max_edge?, quality? }                       (GNSIS)
 *   { type: "capture.stop" }                                                  (GNSIS)
 *
 * Outbound (Hub → Caller):
 *   { type: "ready", session_id: string }
 *   { type: "result", success: boolean, data: string }
 *   { type: "error", message: string, call_id?: string }
 *   { type: "browser.action.result", call_id, frame_id, success, done, message, evidence }
 *   { type: "capture.started", capture_session_id, tab_id }
 *   { type: "capture.frame", frame_id, captured_at_ms, encoding, image_base64, source }
 *   { type: "capture.stopped", reason }
 *
 * GNSIS drives browser.action and capture: frames go into GNSIS's screen
 * history; actions come back as one structured decision each.
 */
import type { ExecutionResult } from '@page-agent/core'
import { useEffect, useRef, useState } from 'react'

import type { ExtConfig } from '@/agent/useAgent'
import {
	type BrowserDecisionRequest,
	type BrowserDecisionResult,
	parseBrowserDecisionRequest,
} from '@/vision/BrowserActionBridge'
import type { CaptureStartOptions, CapturedBrowserFrame } from '@/vision/BrowserFrameStream'

// --- Protocol types ---

interface ExecuteMessage {
	type: 'execute'
	task: string
	config?: Record<string, unknown>
}

interface StopMessage {
	type: 'stop'
	call_id?: string
}

interface BrowserActionMessage extends BrowserDecisionRequest {
	type: 'browser.action'
}

interface CaptureStartMessage extends CaptureStartOptions {
	type: 'capture.start'
}

interface CaptureStopMessage {
	type: 'capture.stop'
}

type InboundMessage =
	ExecuteMessage | StopMessage | BrowserActionMessage | CaptureStartMessage | CaptureStopMessage

interface ReadyMessage {
	type: 'ready'
	session_id: string
}

interface ResultMessage {
	type: 'result'
	success: boolean
	data: string
}

interface ErrorMessage {
	type: 'error'
	message: string
	call_id?: string
}

interface BrowserActionResultMessage extends BrowserDecisionResult {
	type: 'browser.action.result'
}

interface CaptureStartedMessage {
	type: 'capture.started'
	capture_session_id: string
	tab_id: number
}

interface CaptureFrameMessage extends CapturedBrowserFrame {
	type: 'capture.frame'
}

interface CaptureStoppedMessage {
	type: 'capture.stopped'
	reason: string
}

type OutboundMessage =
	| ReadyMessage
	| ResultMessage
	| ErrorMessage
	| BrowserActionResultMessage
	| CaptureStartedMessage
	| CaptureFrameMessage
	| CaptureStoppedMessage

export type HubWsState = 'connecting' | 'connected' | 'disconnected'

// --- HubWs class ---

export interface HubWsHandlers {
	onExecute: (
		task: string,
		config?: Record<string, unknown>
	) => Promise<{ success: boolean; data: string }>
	onBrowserAction: (request: BrowserDecisionRequest) => Promise<BrowserDecisionResult>
	onBrowserCancel: (callId?: string) => void
	onSessionReset: (sessionId: string) => void
	onStop: () => void
	onCaptureStart: (
		options: CaptureStartOptions,
		emit: (frame: CapturedBrowserFrame) => void
	) => Promise<{ captureSessionId: string; tabId: number }>
	onCaptureStop: () => Promise<void>
}

/**
 * Framework-agnostic WebSocket client for Hub.
 * Connects to an external WS server, receives tasks, dispatches to handlers,
 * and sends results back. No React, no DOM.
 */
export class HubWs {
	#ws: WebSocket | null = null
	#state: HubWsState = 'disconnected'
	#busy = false
	#approved = false
	#handlers: HubWsHandlers
	#port: number
	#onStateChange: (state: HubWsState) => void

	constructor(port: number, handlers: HubWsHandlers, onStateChange: (state: HubWsState) => void) {
		this.#port = port
		this.#handlers = handlers
		this.#onStateChange = onStateChange
	}

	get state() {
		return this.#state
	}

	get busy() {
		return this.#busy
	}

	connect() {
		if (this.#ws) return
		this.#setState('connecting')

		const ws = new WebSocket(`ws://localhost:${this.#port}`)
		this.#ws = ws

		ws.addEventListener('open', () => {
			const sessionId = crypto.randomUUID()
			this.#handlers.onSessionReset(sessionId)
			this.#setState('connected')
			this.#send({ type: 'ready', session_id: sessionId })
		})

		ws.addEventListener('close', () => {
			this.#ws = null
			this.#busy = false
			this.#approved = false
			void this.#handlers.onCaptureStop()
			this.#setState('disconnected')
		})

		ws.addEventListener('message', (event) => {
			this.#handleMessage(event.data as string)
		})
	}

	disconnect() {
		this.#ws?.close()
		this.#ws = null
		this.#busy = false
		this.#approved = false
		this.#setState('disconnected')
	}

	#setState(state: HubWsState) {
		if (this.#state === state) return
		this.#state = state
		this.#onStateChange(state)
	}

	#send(msg: OutboundMessage) {
		if (this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg))
		}
	}

	async #handleMessage(raw: string) {
		let msg: InboundMessage
		try {
			msg = JSON.parse(raw)
		} catch {
			return
		}

		if (!(await this.#checkApproval())) {
			this.#send({ type: 'error', message: 'User denied the connection request.' })
			return
		}

		switch (msg.type) {
			case 'execute':
				this.#handleExecute(msg)
				break
			case 'browser.action':
				this.#handleBrowserAction(msg)
				break
			case 'stop':
				this.#handlers.onBrowserCancel(msg.call_id)
				this.#handlers.onStop()
				break
			case 'capture.start':
				void this.#handleCaptureStart(msg)
				break
			case 'capture.stop':
				await this.#handlers.onCaptureStop()
				this.#send({ type: 'capture.stopped', reason: 'requested' })
				break
		}
	}

	async #handleCaptureStart(msg: CaptureStartMessage) {
		try {
			const { captureSessionId, tabId } = await this.#handlers.onCaptureStart(msg, (frame) =>
				this.#send({ type: 'capture.frame', ...frame })
			)
			this.#send({ type: 'capture.started', capture_session_id: captureSessionId, tab_id: tabId })
		} catch (err) {
			this.#send({
				type: 'capture.stopped',
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async #checkApproval(): Promise<boolean> {
		if (this.#approved) return true

		const { allowAllHubConnection } = await chrome.storage.local.get('allowAllHubConnection')
		if (allowAllHubConnection === true) {
			this.#approved = true
			return true
		}

		const ok = window.confirm(
			'An external application is requesting to control your browser via Page Agent Ext.\nAllow this session?'
		)
		if (ok) this.#approved = true
		return ok
	}

	async #handleBrowserAction(msg: BrowserActionMessage) {
		if (this.#busy) {
			this.#send({
				type: 'error',
				call_id: msg.call_id,
				message: 'Hub is busy with another action',
			})
			return
		}

		this.#busy = true
		try {
			const { type: _type, ...payload } = msg
			const request = parseBrowserDecisionRequest(payload)
			const result = await this.#handlers.onBrowserAction(request)
			this.#send({ type: 'browser.action.result', ...result })
		} catch (err) {
			this.#send({
				type: 'error',
				call_id: msg.call_id,
				message: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.#busy = false
		}
	}

	async #handleExecute(msg: ExecuteMessage) {
		if (this.#busy) {
			this.#send({ type: 'error', message: 'Hub is busy with another task' })
			return
		}

		this.#busy = true
		try {
			const result = await this.#handlers.onExecute(msg.task, msg.config)
			this.#send({ type: 'result', success: result.success, data: result.data })
		} catch (err) {
			this.#send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
		} finally {
			this.#busy = false
		}
	}
}

// --- React hook ---

/**
 * React hook that bridges HubWs to the agent's execute/stop/configure.
 * Handles the config-before-execute dance internally.
 */
export function useHubWs(
	execute: (task: string) => Promise<ExecutionResult>,
	stop: () => void,
	configure: (config: ExtConfig) => Promise<void>,
	config: ExtConfig | null,
	executeBrowserAction: (request: BrowserDecisionRequest) => Promise<BrowserDecisionResult>,
	cancelBrowserAction: (callId?: string) => void,
	resetBrowserSession: (sessionId: string) => void,
	startCapture: HubWsHandlers['onCaptureStart'],
	stopCapture: HubWsHandlers['onCaptureStop']
): { wsState: HubWsState } {
	const wsPort = new URLSearchParams(location.search).get('ws')
	const [wsState, setWsState] = useState<HubWsState>(() => (wsPort ? 'connecting' : 'disconnected'))
	const hubWsRef = useRef<HubWs | null>(null)

	const latestRef = useRef({
		execute,
		stop,
		configure,
		config,
		executeBrowserAction,
		cancelBrowserAction,
		resetBrowserSession,
		startCapture,
		stopCapture,
	})
	useEffect(() => {
		latestRef.current = {
			execute,
			stop,
			configure,
			config,
			executeBrowserAction,
			cancelBrowserAction,
			resetBrowserSession,
			startCapture,
			stopCapture,
		}
	})

	useEffect(() => {
		if (!wsPort) return

		const hubWs = new HubWs(
			Number(wsPort),
			{
				onExecute: async (task, incomingConfig) => {
					const { execute, configure, config } = latestRef.current
					if (incomingConfig) {
						await configure({ ...config, ...incomingConfig } as ExtConfig)
					}
					const result = await execute(task)
					return { success: result.success, data: result.data }
				},
				onBrowserAction: (request) => latestRef.current.executeBrowserAction(request),
				onBrowserCancel: (callId) => latestRef.current.cancelBrowserAction(callId),
				onSessionReset: (sessionId) => latestRef.current.resetBrowserSession(sessionId),
				onStop: () => latestRef.current.stop(),
				onCaptureStart: (options, emit) => latestRef.current.startCapture(options, emit),
				onCaptureStop: () => latestRef.current.stopCapture(),
			},
			setWsState
		)

		hubWs.connect()
		hubWsRef.current = hubWs

		return () => {
			hubWs.disconnect()
			hubWsRef.current = null
		}
	}, [wsPort])

	return { wsState }
}
