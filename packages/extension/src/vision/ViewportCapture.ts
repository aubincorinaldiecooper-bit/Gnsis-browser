const MAX_EDGE = 448
const JPEG_QUALITY = 0.78

interface CaptureResponse {
	success: boolean
	dataUrl?: string
	error?: string
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image()
		image.onload = () => resolve(image)
		image.onerror = () => reject(new Error('Failed to decode captured viewport'))
		image.src = dataUrl
	})
}

async function normalizeCapture(dataUrl: string): Promise<string> {
	const image = await loadImage(dataUrl)
	const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
	const width = Math.max(1, Math.round(image.naturalWidth * scale))
	const height = Math.max(1, Math.round(image.naturalHeight * scale))
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	const context = canvas.getContext('2d', { alpha: false })
	if (!context) throw new Error('Could not create Panoptic capture canvas')
	context.drawImage(image, 0, 0, width, height)
	return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',', 2)[1]
}

export async function captureViewport(tabId: number): Promise<string> {
	const response = (await chrome.runtime.sendMessage({
		type: 'TAB_CONTROL',
		action: 'capture_tab',
		payload: { tabId },
	})) as CaptureResponse

	if (!response?.success || !response.dataUrl) {
		throw new Error(response?.error || `Failed to capture tab ${tabId}`)
	}
	return normalizeCapture(response.dataUrl)
}
