"""Evaluation-only harness: opens episodes and reads ground truth from the page runtime.

Ground truth (oracle labels, success) is read from the page's test runtime and is
never passed to the visual engine.
"""

from __future__ import annotations

from dataclasses import dataclass

from playwright.async_api import Page

from .episodes import Episode
from .sites import TaskServer


@dataclass(frozen=True)
class OracleStep:
    action: str
    box: tuple[float, float, float, float] | None
    value: str | None

    @property
    def center(self) -> tuple[int, int] | None:
        if self.box is None:
            return None
        x, y, w, h = self.box
        return int(x + w / 2), int(y + h / 2)


async def open_episode(page: Page, server: TaskServer, episode: Episode) -> None:
    await page.goto(server.url(episode.start), wait_until="load")
    for key in episode.setup_clicks:
        await page.click(f'[data-k="{key}"]')
        await page.wait_for_load_state("load")


async def oracle(page: Page) -> OracleStep | None:
    try:
        raw = await page.evaluate("window.__oracle ? window.__oracle() : null")
    except Exception:
        return None
    if raw is None:
        return None
    box = raw.get("target")
    return OracleStep(raw["action"], tuple(box) if box else None, raw.get("value"))


async def success(page: Page) -> bool:
    try:
        return bool(await page.evaluate("window.__success ? window.__success() : false"))
    except Exception:
        return False


def hit(point: tuple[int, int], box: tuple[float, float, float, float]) -> bool:
    x, y, w, h = box
    return x <= point[0] <= x + w and y <= point[1] <= y + h
