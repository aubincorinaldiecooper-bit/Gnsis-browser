"""Deterministic coordinate actuator: structured decision -> browser input events."""

from __future__ import annotations

from dataclasses import dataclass

from playwright.async_api import Page

from .schema import Decision, validate_decision

SCROLL_FRACTION = 0.7


@dataclass(frozen=True)
class ActuatorResult:
    ok: bool
    detail: str = ""


class CoordinateActuator:
    def __init__(self, page: Page, viewport: tuple[int, int]):
        self.page = page
        self.viewport = viewport

    async def execute(self, decision: Decision) -> ActuatorResult:
        validate_decision(decision, self.viewport)
        page, act = self.page, decision.action
        mouse, keyboard = page.mouse, page.keyboard
        if act == "click":
            await mouse.click(decision.target.x, decision.target.y)
        elif act == "type":
            await mouse.click(decision.target.x, decision.target.y)
            await keyboard.press("ControlOrMeta+A")
            await keyboard.insert_text(decision.text or "")
        elif act == "scroll":
            dy = int(self.viewport[1] * SCROLL_FRACTION) * (1 if decision.direction == "down" else -1)
            await mouse.move(self.viewport[0] // 2, self.viewport[1] // 2)
            await mouse.wheel(0, dy)
        elif act == "navigate":
            await page.goto(decision.url or "", wait_until="commit")
        elif act == "back":
            await page.go_back(wait_until="commit")
        elif act == "recover":
            await keyboard.press("Escape")
            if decision.target is not None:
                await mouse.click(decision.target.x, decision.target.y)
            else:
                await page.reload(wait_until="commit")
        return ActuatorResult(True, act)
