"""Schema and scoring helpers for real GNSIS visual-run evaluation.

The benchmark consumes examples recorded from actual GNSIS use. Perception stays
pixel-only. Optional target geometry is executor-side evaluation data captured
*after* a visual target already exists; it must never be fed back into System 1.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

VariantName = Literal["raw", "raw+r24", "ocr", "ocr+r24"]
ActionName = Literal["click", "type", "recover"]

VARIANTS: tuple[VariantName, ...] = ("raw", "raw+r24", "ocr", "ocr+r24")
TARGET_ACTIONS = frozenset({"click", "type", "recover"})


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    width: float
    height: float

    def contains(self, point: Point) -> bool:
        return (
            self.x <= point.x <= self.x + self.width
            and self.y <= point.y <= self.y + self.height
        )


@dataclass(frozen=True)
class Candidate:
    point: Point | None
    status: Literal["resolved", "abstained", "unavailable"] = "resolved"
    method: str | None = None


@dataclass(frozen=True)
class ExecutionOutcome:
    executed_variant: VariantName | None
    actuator_success: bool | None
    verified_success: bool | None
    user_corrected: bool = False
    latency_ms: float | None = None


@dataclass(frozen=True)
class RealRunCase:
    schema_version: int
    run_id: str
    case_id: str
    captured_at_ms: int
    context: Literal["browser", "desktop"]
    frame_id: str | int
    frame_path: str | None
    goal: str
    action: str
    viewport: tuple[int, int]
    candidates: dict[VariantName, Candidate]
    target_box: Box | None
    outcome: ExecutionOutcome

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "RealRunCase":
        if data.get("schema_version") != 1:
            raise ValueError("unsupported real-run schema_version")
        context = data.get("context")
        if context not in {"browser", "desktop"}:
            raise ValueError("context must be browser|desktop")
        viewport = data.get("viewport") or {}
        width, height = int(viewport.get("width", 0)), int(viewport.get("height", 0))
        if width <= 0 or height <= 0:
            raise ValueError("viewport width/height must be positive")

        candidates: dict[VariantName, Candidate] = {}
        raw_candidates = data.get("candidates") or {}
        for name in VARIANTS:
            value = raw_candidates.get(name)
            if value is None:
                candidates[name] = Candidate(None, "unavailable")
                continue
            status = value.get("status", "resolved")
            if status not in {"resolved", "abstained", "unavailable"}:
                raise ValueError(f"invalid candidate status for {name}")
            raw_point = value.get("point")
            point = None
            if raw_point is not None:
                point = Point(float(raw_point["x"]), float(raw_point["y"]))
                if not (0 <= point.x < width and 0 <= point.y < height):
                    raise ValueError(f"{name} point is outside viewport")
            if status == "resolved" and point is None:
                raise ValueError(f"{name} resolved candidate requires point")
            candidates[name] = Candidate(point, status, value.get("method"))

        raw_box = data.get("target_box")
        target_box = (
            Box(
                float(raw_box["x"]),
                float(raw_box["y"]),
                float(raw_box["width"]),
                float(raw_box["height"]),
            )
            if raw_box is not None
            else None
        )
        if target_box is not None and (target_box.width <= 0 or target_box.height <= 0):
            raise ValueError("target_box width/height must be positive")

        execution = data.get("execution") or {}
        executed_variant = execution.get("executed_variant")
        if executed_variant is not None and executed_variant not in VARIANTS:
            raise ValueError("invalid executed_variant")

        return cls(
            schema_version=1,
            run_id=str(data["run_id"]),
            case_id=str(data["case_id"]),
            captured_at_ms=int(data["captured_at_ms"]),
            context=context,
            frame_id=data["frame_id"],
            frame_path=data.get("frame_path"),
            goal=str(data.get("goal") or ""),
            action=str(data["action"]),
            viewport=(width, height),
            candidates=candidates,
            target_box=target_box,
            outcome=ExecutionOutcome(
                executed_variant=executed_variant,
                actuator_success=execution.get("actuator_success"),
                verified_success=execution.get("verified_success"),
                user_corrected=bool(execution.get("user_corrected", False)),
                latency_ms=(
                    float(execution["latency_ms"])
                    if execution.get("latency_ms") is not None
                    else None
                ),
            ),
        )


def geometric_score(case: RealRunCase, variant: VariantName) -> bool | None:
    """Whether a candidate lands in executor-recorded target geometry.

    Returns None when the run did not record enough evaluation-only geometry.
    """

    if case.target_box is None:
        return None
    candidate = case.candidates[variant]
    if candidate.status != "resolved" or candidate.point is None:
        return False
    return case.target_box.contains(candidate.point)
