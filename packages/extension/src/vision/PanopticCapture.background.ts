const OFFSCREEN_PATH = 'panoptic-capture.html'
let creatingOffscreen: Promise<void> | null = null

async function ensureOffscreenDocument(): Promise<void> {
	const url = chrome.runtime.getURL(OFFSCREEN_PATH)
	const contexts = await chrome.runtime.getContexts({
		contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
		documentUrls: [url],
	})
	if (contexts.length > 0) return

	if (!creatingOffscreen) {
		creatingOffscreen = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_PATH,
				reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
				justification:
					'Keep a persistent tab video stream alive for Panoptic temporal perception.',
			})
			.finally(() => {
				creatingOffscreen = null
			})
	}
	await creatingOffscreen
}

async function offscreenRequest(payload: Record<string, unknown>): Promise<any> {
	await ensureOffscreenDocument()
	return chrome.runtime.sendMessage({
		type: 'PANOPTIC_OFFSCREEN',
		target: 'panoptic-offscreen',
		...payload,
	})
}

export function handlePanopticCaptureMessage(
	message: {
		type: 'PANOPTIC_CAPTURE'
		action: 'start' | 'sample' | 'stop'
		payload: any
	},
	_sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true {
	const { action, payload } = message

	;(async () => {
		switch (action) {
			case 'start': {
				await ensureOffscreenDocument()
				const streamId = await chrome.tabCapture.getMediaStreamId({
					targetTabId: payload.tabId,
				})
				const result = await offscreenRequest({
					action: 'start',
					sessionId: payload.sessionId,
					tabId: payload.tabId,
					streamId,
				})
				sendResponse(result)
				return
			}
			case 'sample': {
				const result = await offscreenRequest({
					action: 'sample',
					sessionId: payload.sessionId,
					maxEdge: payload.maxEdge,
					quality: payload.quality,
				})
				sendResponse(result)
				return
			}
			case 'stop': {
				const result = await offscreenRequest({
					action: 'stop',
					sessionId: payload.sessionId,
				})
				sendResponse(result)
				return
			}
		}
	})().catch((error) => {
		sendResponse({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	})

	return true
}
