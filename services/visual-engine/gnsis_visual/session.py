"""Persistent visual sessions: one browser tab, one screencast stream, one bounded history."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from playwright.async_api import Browser, BrowserContext, Page

from .actuator import ActuatorResult, CoordinateActuator
from .engine import DecisionPolicy, VisualCache
from .prompt import MAX_HISTORY
from .schema import Decision
from .stream import ScreencastStream

WAIT_S = 0.6
POST_ACTION_S = 0.15
PREFETCH_QUIET_S = 0.2
MAX_LOG = 200


@dataclass
class StepRecord:
    decision: dict
    executed: bool
    detail: str
    ts: float = field(default_factory=time.time)


class VisualSession:
    def __init__(self, policy: DecisionPolicy, page: Page, context: BrowserContext, viewport: tuple[int, int]):
        self.id = uuid.uuid4().hex[:12]
        self.policy = policy
        self.page = page
        self.context = context
        self.viewport = viewport
        self.stream = ScreencastStream(page, viewport)
        self.actuator = CoordinateActuator(page, viewport)
        self.cache = VisualCache()
        self.goal: str | None = None
        self.history: list[dict] = []
        self.log: list[StepRecord] = []
        self.created = time.time()
        self._busy = asyncio.Lock()
        self._prefetch: asyncio.Task | None = None

    @classmethod
    async def open(
        cls, policy: DecisionPolicy, browser: Browser, viewport: tuple[int, int], url: str | None, prefetch: bool
    ) -> VisualSession:
        context = await browser.new_context(viewport={"width": viewport[0], "height": viewport[1]})
        page = await context.new_page()
        session = cls(policy, page, context, viewport)
        await session.stream.start()
        if url:
            await page.goto(url, wait_until="commit")
        if prefetch:
            session._prefetch = asyncio.create_task(session._prefetch_loop())
        return session

    async def close(self) -> None:
        if self._prefetch is not None:
            self._prefetch.cancel()
        await self.stream.stop()
        await self.context.close()

    def set_task(self, goal: str) -> None:
        self.goal = goal
        self.history = []

    async def _prefetch_loop(self) -> None:
        """Encode settled frames in the background so decisions only pay for the language pass."""
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(0.1)
            frame = self.stream.latest
            if frame is None or time.monotonic() - frame.ts < PREFETCH_QUIET_S or self._busy.locked():
                continue
            if self.cache.lookup(frame) is None:
                await loop.run_in_executor(None, self.policy.encode, frame, self.cache)

    async def decide(self) -> Decision:
        if not self.goal:
            raise ValueError("no task set for this session")
        frame = await self.stream.settle(timeout=1.2)
        motion = self.stream.motion()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self.policy.decide, frame, self.goal, list(self.history), motion, self.viewport, self.cache
        )

    async def execute(self, decision: Decision) -> ActuatorResult:
        async with self._busy:
            if decision.action == "wait":
                await asyncio.sleep(WAIT_S)
                result = ActuatorResult(True, "wait")
            elif decision.action == "done":
                result = ActuatorResult(True, "done")
            else:
                result = await self.actuator.execute(decision)
                await asyncio.sleep(POST_ACTION_S)
        if decision.action != "done":
            self.history.append(
                {k: v for k, v in decision.to_json().items() if k in ("action", "text", "url", "direction")}
            )
            self.history = self.history[-MAX_HISTORY * 4 :]
        self.log.append(StepRecord(decision.to_json(), result.ok, result.detail))
        self.log = self.log[-MAX_LOG:]
        return result

    async def step(self, min_confidence: float = 0.0) -> tuple[Decision, ActuatorResult | None]:
        decision = await self.decide()
        if decision.confidence < min_confidence:
            self.log.append(StepRecord(decision.to_json(), False, "below min_confidence; not executed"))
            return decision, None
        return decision, await self.execute(decision)

    def state(self) -> dict:
        latest = self.stream.latest
        return {
            "session_id": self.id,
            "policy": self.policy.name,
            "goal": self.goal,
            "url": self.page.url,
            "viewport": {"width": self.viewport[0], "height": self.viewport[1]},
            "history": self.history[-MAX_HISTORY:],
            "stream": {
                "frames_received": self.stream.received,
                "latest_frame_id": latest.frame_id if latest else None,
                "motion": round(self.stream.motion(), 4),
            },
            "visual_cache": {"hits": self.cache.hits, "misses": self.cache.misses},
            "steps": len(self.log),
        }
