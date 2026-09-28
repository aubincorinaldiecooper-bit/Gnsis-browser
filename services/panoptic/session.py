from __future__ import annotations

import math
from typing import Any

from PIL import Image

SYSTEM = """
You are Panoptic, a realtime browser-video perception system.
You receive browser frames in causal order. Every frame is labeled with its
actual time interval. Browser/user/actuator events may also appear at their real
timestamp.

Use </Silence> when current evidence is irrelevant or nothing useful has begun.
Use </Standby> when relevant activity is in progress but more evidence is needed.
Use </Response> only when enough evidence exists to expose a useful current state.

Never choose or execute a browser action. Never fabricate selectors, DOM indexes,
JavaScript, or hidden page state.
""".strip()


def perception_prompt(task: str) -> str:
    return f"""Continuously observe the browser for this user task:

{task.strip()}

When you choose </Response>, output JSON only after the tag:
{{
  "summary": "what is visibly true now",
  "change": "what materially changed since the previous useful state",
  "page_stable": true,
  "targets": [
    {{
      "id": "short-stable-id",
      "label": "visible label or concise visual description",
      "role": "button|link|input|select|tab|other",
      "point": {{"x": 0.0, "y": 0.0}},
      "affordances": ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL"]
    }}
  ]
}}

Coordinates are normalized viewport coordinates in [0,1]. Report at most 12
currently visible, task-relevant targets. Do not output an action recommendation.
"""


def fit_pixels(image: Image.Image, max_pixels: int) -> Image.Image:
    width, height = image.size
    area = max(1, width * height)
    if area <= max_pixels:
        return image
    scale = math.sqrt(max_pixels / area)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.BICUBIC)


def time_tag(start_ms: float, end_ms: float) -> str:
    return f"<{start_ms / 1000.0:.3f}s-{end_ms / 1000.0:.3f}s>"


class PanopticStreamingSession:
    def __init__(
        self,
        engine: Any,
        *,
        task: str,
        context_rounds: int,
        max_tokens: int,
        normal_max_pixels: int,
        standby_max_pixels: int,
    ) -> None:
        self.engine = engine
        self.task = task
        self.context_rounds = context_rounds
        self.max_tokens = max_tokens
        self.normal_max_pixels = normal_max_pixels
        self.standby_max_pixels = standby_max_pixels
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM}]}
        ]
        self.last_answer: str | None = None
        self.user_turns = 0

    def _trim(self) -> None:
        while self.user_turns > self.context_rounds:
            user_idx = next(
                (i for i, msg in enumerate(self.messages[1:], start=1) if msg["role"] == "user"),
                None,
            )
            if user_idx is None:
                break
            del self.messages[user_idx]
            if user_idx < len(self.messages) and self.messages[user_idx]["role"] == "assistant":
                del self.messages[user_idx]
            self.user_turns -= 1

        first_user = next((m for m in self.messages if m["role"] == "user"), None)
        if first_user is None:
            return
        task_prompt = perception_prompt(self.task)
        if not any(
            item.get("type") == "text" and task_prompt in str(item.get("text", ""))
            for item in first_user["content"]
        ):
            first_user["content"].insert(0, {"type": "text", "text": task_prompt})

    def step(
        self,
        frames: list[tuple[Image.Image, float, float, bool]],
        events: list[dict[str, Any]],
    ) -> str:
        if self.last_answer is not None:
            self.messages.append(
                {"role": "assistant", "content": [{"type": "text", "text": self.last_answer}]}
            )

        content: list[dict[str, Any]] = []
        if self.user_turns == 0:
            content.append({"type": "text", "text": perception_prompt(self.task)})

        events_sorted = sorted(events, key=lambda item: float(item.get("time_ms", 0)))
        event_index = 0

        for image, start_ms, end_ms, high_res in frames:
            while (
                event_index < len(events_sorted)
                and float(events_sorted[event_index].get("time_ms", 0)) <= end_ms
            ):
                event = events_sorted[event_index]
                content.append(
                    {
                        "type": "text",
                        "text": (
                            f"<event @{float(event.get('time_ms', 0)) / 1000.0:.3f}s> "
                            f"{str(event.get('content') or '').strip()}"
                        ),
                    }
                )
                event_index += 1

            budget = self.standby_max_pixels if high_res else self.normal_max_pixels
            content.append({"type": "image", "image": fit_pixels(image, budget)})
            content.append({"type": "text", "text": time_tag(start_ms, end_ms)})

        while event_index < len(events_sorted):
            event = events_sorted[event_index]
            content.append(
                {
                    "type": "text",
                    "text": (
                        f"<event @{float(event.get('time_ms', 0)) / 1000.0:.3f}s> "
                        f"{str(event.get('content') or '').strip()}"
                    ),
                }
            )
            event_index += 1

        self.messages.append({"role": "user", "content": content})
        self.user_turns += 1
        self._trim()

        answer = self.engine.infer(
            self.messages,
            max_tokens=self.max_tokens,
            temperature=0.0,
        )
        self.last_answer = answer
        return answer
