"""Visual decision engine: rendered frame + goal -> validated structured decision.

`DecisionPolicy` is the model-independent seam used by sessions and the API.
`JEVEngine` implements it with the frozen MiniCPM-V backbone and the JEV head.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, replace
from typing import Protocol

import numpy as np
import torch

from .backbone import BackboneConfig, MiniCPMVBackbone, VisualTokens
from .batching import HEAD_INPUTS, collate
from .decode import decode
from .head import HeadConfig, JEVDecisionHead
from .prompt import build_layout
from .schema import Decision, validate_decision
from .stream import Frame, frame_distance

REUSE_DISTANCE = 0.002


class DecisionPolicy(Protocol):
    name: str

    def decide(
        self, frame: Frame, goal: str, history: list[dict], motion: float, viewport: tuple[int, int], cache: VisualCache
    ) -> Decision: ...

    def encode(self, frame: Frame, cache: VisualCache) -> None: ...


@dataclass
class VisualCache:
    """Per-session cache of the last encoded frame; reused while the page is visually unchanged."""

    signature: np.ndarray | None = None
    frame_id: int = -1
    tokens: VisualTokens | None = None
    hits: int = 0
    misses: int = 0

    def lookup(self, frame: Frame) -> VisualTokens | None:
        if self.tokens is None or self.signature is None:
            return None
        if frame.frame_id == self.frame_id or frame_distance(frame.signature, self.signature) < REUSE_DISTANCE:
            return self.tokens
        return None

    def store(self, frame: Frame, tokens: VisualTokens) -> None:
        self.signature, self.frame_id, self.tokens = frame.signature, frame.frame_id, tokens


class JEVEngine:
    name = "minicpm-v-4.6+jev-head"

    def __init__(self, backbone: BackboneConfig, head_path: str):
        self.backbone = MiniCPMVBackbone(backbone)
        ckpt = torch.load(head_path, map_location="cpu", weights_only=False)
        self.head = JEVDecisionHead(HeadConfig(**ckpt["config"])).eval()
        self.head.load_state_dict(ckpt["state_dict"])
        self._lock = threading.Lock()

    def encode(self, frame: Frame, cache: VisualCache) -> None:
        with self._lock:
            if cache.lookup(frame) is None:
                cache.store(frame, self.backbone.encode_visual(frame.image()))

    def decide(
        self, frame: Frame, goal: str, history: list[dict], motion: float, viewport: tuple[int, int], cache: VisualCache
    ) -> Decision:
        with self._lock:
            t0 = time.perf_counter()
            visual = cache.lookup(frame)
            if visual is None:
                cache.misses += 1
                visual = self.backbone.encode_visual(frame.image())
                cache.store(frame, visual)
                vision_ms = visual.timing_ms["vision"] + visual.timing_ms["preprocess"]
            else:
                cache.hits += 1
                vision_ms = 0.0
            layout = build_layout(goal, history)
            feats = self.backbone.decision_features(layout, visual)
            t1 = time.perf_counter()
            record = {
                "queries": feats.queries,
                "actions": feats.actions,
                "values": feats.values,
                "visual": feats.visual,
                "visual_embeds": feats.visual_embeds,
                "grid": feats.grid,
                "motion": motion,
            }
            batch = collate([record])
            with torch.inference_mode():
                out = self.head(**{k: batch[k] for k in HEAD_INPUTS})
            decision = decode(out, layout.values, feats.grid, viewport)
            t2 = time.perf_counter()
        timing = {
            "vision": round(vision_ms, 1),
            "language": round(feats.timing_ms["language"], 1),
            "head": round((t2 - t1) * 1e3, 2),
            "total": round((t2 - t0) * 1e3, 1),
        }
        return validate_decision(replace(decision, frame_id=frame.frame_id, timing_ms=timing), viewport)
