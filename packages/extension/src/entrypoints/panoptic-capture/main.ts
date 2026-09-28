interface CaptureSession {
	sessionId: string
	tabId: number
	stream: MediaStream
	video: HTMLVideoElement
	canvas: HTMLCanvasElement
	context: CanvasRenderingContext2D
}

const sessions = new Map<string, CaptureSession>()

function mediaConstraints(streamId: string): MediaStreamConstraints {
	return {
		audio: false,
		video: {
			mandatory: {
				chromeMediaSource: 'tab',
				chromeMediaSourceId: streamId,
			},
		} as unknown as MediaTrackConstraints,
	}
}

async function waitForVideo(video: HTMLVideoElement): Promise<void> {
	if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return
	await new Promise<void>((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			reject(new Error('Timed out waiting for tab video stream'))
		}, 5_000)
		const ready = () => {
			if (video.videoWidth <= 0 || video.videoHeight <= 0) return
			window.clearTimeout(timeout)
			video.removeEventListener('loadeddata', ready)
			resolve()
		}
		video.addEventListener('loadeddata', ready)
	})
}

async function startSession(
	sessionId: string,
	tabId: number,
	streamId: string
): Promise<Record<string, unknown>> {
	await stopSession(sessionId)

	const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(streamId))
	const video = document.createElement('video')
	video.muted = true
	video.autoplay = true
	video.playsInline = true
	video.srcObject = stream
	await video.play()
	await waitForVideo(video)

	const canvas = document.createElement('canvas')
	const context = canvas.getContext('2d', { alpha: false })
	if (!context) {
		for (const track of stream.getTracks()) track.stop()
		throw new Error('Could not create Panoptic capture canvas')
	}

	const session: CaptureSession = {
		sessionId,
		tabId,
		stream,
		video,
		canvas,
		context,
	}
	sessions.set(sessionId, session)

	for (const track of stream.getTracks()) {
		track.addEventListener(
			'ended',
			() => {
				void stopSession(sessionId)
			},
			{ once: true }
		)
	}

	return {
		success: true,
		sourceWidth: video.videoWidth,
		sourceHeight: video.videoHeight,
	}
}

async function sampleSession(
	sessionId: string,
	maxEdge = 896,
	quality = 0.82
): Promise<Record<string, unknown>> {
	const session = sessions.get(sessionId)
	if (!session) throw new Error(`Unknown Panoptic capture session: ${sessionId}`)
	await waitForVideo(session.video)

	const sourceWidth = session.video.videoWidth
	const sourceHeight = session.video.videoHeight
	const safeMaxEdge = Math.max(224, Math.min(1536, Number(maxEdge) || 896))
	const scale = Math.min(1, safeMaxEdge / Math.max(sourceWidth, sourceHeight))
	const width = Math.max(1, Math.round(sourceWidth * scale))
	const height = Math.max(1, Math.round(sourceHeight * scale))

	if (session.canvas.width !== width) session.canvas.width = width
	if (session.canvas.height !== height) session.canvas.height = height
	session.context.drawImage(session.video, 0, 0, width, height)

	const safeQuality = Math.max(0.5, Math.min(0.95, Number(quality) || 0.82))
	const dataUrl = session.canvas.toDataURL('image/jpeg', safeQuality)
	const comma = dataUrl.indexOf(',')
	if (comma < 0) throw new Error('Failed to encode Panoptic frame')

	return {
		success: true,
		imageBase64: dataUrl.slice(comma + 1),
		capturedAtEpochMs: Date.now(),
		width,
		height,
		sourceWidth,
		sourceHeight,
	}
}

async function stopSession(sessionId: string): Promise<Record<string, unknown>> {
	const session = sessions.get(sessionId)
	if (!session) return { success: true }

	sessions.delete(sessionId)
	session.video.pause()
	session.video.srcObject = null
	for (const track of session.stream.getTracks()) track.stop()
	session.canvas.width = 1
	session.canvas.height = 1
	return { success: true }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse): true | undefined => {
	if (message?.type !== 'PANOPTIC_OFFSCREEN' || message?.target !== 'panoptic-offscreen') {
		return
	}

	;(async () => {
		switch (message.action) {
			case 'start':
				return startSession(message.sessionId, Number(message.tabId), message.streamId)
			case 'sample':
				return sampleSession(message.sessionId, message.maxEdge, message.quality)
			case 'stop':
				return stopSession(message.sessionId)
			default:
				throw new Error(`Unknown Panoptic offscreen action: ${message.action}`)
		}
	})()
		.then(sendResponse)
		.catch((error) => {
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			})
		})

	return true
})
