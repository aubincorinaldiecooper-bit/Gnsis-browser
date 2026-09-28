"""Persistent rendered-browser stream.

Frames come from Chromium's compositor via CDP `Page.startScreencast`; the
stream runs for the lifetime of the session and keeps a bounded history. This
is the only visual source of the engine; there is no screenshot path.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import itertools
import time
from collections import deque
from dataclasses import dataclass

import numpy as np
from PIL import Image
from playwright.async_api import CDPSession, Page

HISTORY_FRAMES = 64
MOTION_WINDOW_S = 0.8
_SIG = (48, 30)


@dataclass
class Frame:
    frame_id: int
    ts: float  # monotonic seconds
    jpeg: bytes
    signature: np.ndarray  # tiny grayscale thumbnail for change detection
    size: tuple[int, int]

    def image(self) -> Image.Image:
        return Image.open(io.BytesIO(self.jpeg)).convert("RGB")


def signature(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L").resize(_SIG, Image.BILINEAR), dtype=np.float32) / 255.0


def frame_distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a - b).mean())


class ScreencastStream:
    def __init__(self, page: Page, viewport: tuple[int, int], quality: int = 80):
        self.page = page
        self.viewport = viewport
        self.quality = quality
        self.frames: deque[Frame] = deque(maxlen=HISTORY_FRAMES)
        self._cdp: CDPSession | None = None
        self._next_id = 0
        self._new_frame = asyncio.Event()
        self._ingesting: set[asyncio.Task] = set()
        self.received = 0

    async def start(self) -> None:
        self._cdp = await self.page.context.new_cdp_session(self.page)
        self._cdp.on("Page.screencastFrame", self._on_frame)
        await self._cdp.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": self.quality, "maxWidth": self.viewport[0], "maxHeight": self.viewport[1]},
        )

    async def stop(self) -> None:
        if self._cdp is not None:
            with contextlib.suppress(Exception):
                await self._cdp.send("Page.stopScreencast")
                await self._cdp.detach()
            self._cdp = None

    def _on_frame(self, params: dict) -> None:
        task = asyncio.ensure_future(self._ingest(params))
        self._ingesting.add(task)
        task.add_done_callback(self._ingesting.discard)

    async def _ingest(self, params: dict) -> None:
        cdp = self._cdp
        if cdp is None:
            return
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            return
        data = base64.b64decode(params["data"])
        img = Image.open(io.BytesIO(data))
        self._next_id += 1
        self.received += 1
        self.frames.append(Frame(self._next_id, time.monotonic(), data, signature(img), img.size))
        self._new_frame.set()

    @property
    def latest(self) -> Frame | None:
        return self.frames[-1] if self.frames else None

    async def wait_frame(self, after_id: int = 0, timeout: float = 5.0) -> Frame:
        deadline = time.monotonic() + timeout
        while True:
            frame = self.latest
            if frame is not None and frame.frame_id > after_id:
                return frame
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if frame is None:
                    raise TimeoutError("no frame received from screencast")
                return frame
            self._new_frame.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._new_frame.wait(), remaining)

    async def settle(self, quiet_s: float = 0.35, timeout: float = 4.0) -> Frame:
        """Wait until the rendered stream is visually quiet (or timeout)."""
        start = time.monotonic()
        await self.wait_frame(timeout=timeout)
        while time.monotonic() - start < timeout:
            last = self.latest
            if last is not None and time.monotonic() - last.ts >= quiet_s:
                return last
            await asyncio.sleep(0.05)
        return self.latest  # type: ignore[return-value]

    def motion(self, now: float | None = None) -> float:
        """Mean visual change rate over the recent window (0 = static page)."""
        now = time.monotonic() if now is None else now
        recent = [f for f in self.frames if now - f.ts <= MOTION_WINDOW_S]
        if len(recent) < 2:
            return 0.0
        diffs = [frame_distance(a.signature, b.signature) for a, b in itertools.pairwise(recent)]
        return float(min(1.0, sum(diffs) * 10))
