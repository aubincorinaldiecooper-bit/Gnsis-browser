const MAX_FRAME_PROVENANCE = 4096

const frameToTab = new Map<string, number>()

/**
 * Execution provenance only. This registry never enters perception/model input.
 * It lets the actuator prove which browser tab produced a visual frame.
 */
export function registerFrameSource(frameId: string, tabId: number): void {
	if (!frameId || !Number.isInteger(tabId) || tabId <= 0) {
		throw new Error('invalid frame provenance')
	}
	frameToTab.set(frameId, tabId)
	while (frameToTab.size > MAX_FRAME_PROVENANCE) {
		const oldest = frameToTab.keys().next().value
		if (oldest === undefined) break
		frameToTab.delete(oldest)
	}
}

export function frameSourceTab(frameId: string | number | null | undefined): number | null {
	if (frameId == null) return null
	return frameToTab.get(String(frameId)) ?? null
}

export function clearFrameProvenance(): void {
	frameToTab.clear()
}
