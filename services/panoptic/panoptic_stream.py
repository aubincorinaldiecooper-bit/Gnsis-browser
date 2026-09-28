"""Panoptic causal browser-perception runtime.

Panoptic is GNSIS Browser's live temporal perception layer. The current model
backend is loaded behind this service and must stay an implementation detail of
the Panoptic boundary.

Invariants:
- one stateful streaming session per browser tab/session;
- source timestamps are ordered and preserved;
- native silence / standby / response states are surfaced;
- standby gives the next frame a 4x visual pixel budget;
- context length and total stream length are separate controls;
- this layer never chooses or executes browser actions.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any

from huggingface_hub import hf_hub_download, snapshot_download
from PIL import Image
from websockets.asyncio.server import ServerConnection, serve

# Implementation provenance is intentionally kept inside the runtime rather than
# exposed through the GNSIS Browser API. See UPSTREAM.md for source/license notes.
_BACKEND_MODEL_ID = "MCG-NJU/VideoChat3-4B"
_BACKEND_REVISION = os.environ.get("PANOPTIC_MODEL_REVISION", "37fa901")
_WEIGHTS_DIR = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))

NORMAL_MAX_PIXELS = int(os.environ.get("PANOPTIC_NORMAL_MAX_PIXELS", str(224 * 224)))
STANDBY_MAX_PIXELS = int(
    os.environ.get("PANOPTIC_STANDBY_MAX_PIXELS", str(NORMAL_MAX_PIXELS * 4))
)
DEFAULT_CONTEXT_ROUNDS = int(os.environ.get("PANOPTIC_CONTEXT_ROUNDS", "4096"))
DEFAULT_MAX_FRAMES = int(os.environ.get("PANOPTIC_MAX_FRAMES", "4096"))
DEFAULT_MAX_TOKENS = int(os.environ.get("PANOPTIC_MAX_OUTPUT_TOKENS", "192"))
MAX_FRAME_BYTES = int(os.environ.get("PANOPTIC_MAX_FRAME_BYTES", "2500000"))
AUTH_TOKEN = os.environ.get("GNSIS_PANOPTIC_TOKEN", "")

_TAG_RE = re.compile(r"^\s*(</Silence>|</Standby>|</Response>)\s*(.*)$", re.DOTALL)


def _perception_prompt(task: str) -> str:
    return f"""Continuously observe the browser viewport for this user task:

{task.strip()}

You are Panoptic, the perception layer only. Do not choose a browser action and
never execute anything. Preserve temporal evidence across frames and decide when
there is enough evidence to surface a useful current state.

When the streaming policy chooses </Response>, return JSON only:
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

point.x and point.y are normalized viewport coordinates in [0,1], centered on
the visible target. Report no more than 12 currently visible, task-relevant
targets. Do not emit selectors, DOM indexes, JavaScript, or action instructions.
If evidence is still evolving, use </Standby>. If it is not yet useful, use
</Silence> exactly as the native streaming policy specifies."""


def _parse_stream_answer(answer: str) -> tuple[str, str]:
    match = _TAG_RE.match(answer or "")
    if not match:
        return "silence", ""
    tag, content = match.groups()
    return {
        "</Silence>": "silence",
        "</Standby>": "standby",
        "</Response>": "response",
    }[tag], content.strip()


def _decode_frame(encoded: str) -> Image.Image:
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError(f"frame exceeds {MAX_FRAME_BYTES} bytes")
    with Image.open(io.BytesIO(raw)) as picture:
        return picture.convert("RGB").copy()


@dataclass(frozen=True)
class StartConfig:
    session_id: str
    tab_id: int
    task: str
    context_rounds: int
    max_frames: int
    max_tokens: int


def _parse_start(payload: dict[str, Any]) -> StartConfig:
    if payload.get("type") != "start":
        raise ValueError("first message must be type=start")
    if AUTH_TOKEN and payload.get("token") != AUTH_TOKEN:
        raise PermissionError("invalid Panoptic stream token")

    task = str(payload.get("task") or "").strip()
    session_id = str(payload.get("session_id") or "").strip()
    if not task:
        raise ValueError("task is required")
    if not session_id:
        raise ValueError("session_id is required")

    context_rounds = int(payload.get("context_rounds", DEFAULT_CONTEXT_ROUNDS))
    max_frames = int(payload.get("max_frames", DEFAULT_MAX_FRAMES))
    max_tokens = int(payload.get("max_tokens", DEFAULT_MAX_TOKENS))
    if context_rounds < 1:
        raise ValueError("context_rounds must be >= 1")
    if max_frames < 0:
        raise ValueError("max_frames must be >= 0 (0 means unbounded)")
    if max_tokens < 16:
        raise ValueError("max_tokens must be >= 16")

    return StartConfig(
        session_id=session_id,
        tab_id=int(payload.get("tab_id")),
        task=task,
        context_rounds=context_rounds,
        max_frames=max_frames,
        max_tokens=max_tokens,
    )


class Runtime:
    def __init__(self) -> None:
        import importlib.util

        started = time.time()
        model_path = snapshot_download(
            _BACKEND_MODEL_ID,
            revision=_BACKEND_REVISION,
            cache_dir=_WEIGHTS_DIR,
        )
        stream_path = hf_hub_download(
            _BACKEND_MODEL_ID,
            "inference_fast_vc3.py",
            revision=_BACKEND_REVISION,
            cache_dir=_WEIGHTS_DIR,
        )
        spec = importlib.util.spec_from_file_location("panoptic_stream_backend", stream_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load Panoptic streaming backend")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.StreamingSession = module.StreamingSession
        self.engine = module.VideoChat3StreamEngine(
            model_path,
            device="auto",
            attn_implementation=os.environ.get(
                "PANOPTIC_ATTN_IMPLEMENTATION", "flash_attention_2"
            ),
        )
        self.startup_ms = int((time.time() - started) * 1000)
        self.infer_lock = asyncio.Lock()

    def new_session(self, config: StartConfig):
        return self.StreamingSession(
            self.engine,
            question=_perception_prompt(config.task),
            question_time=0,
            max_rounds=config.context_rounds,
            global_question=True,
            max_tokens=config.max_tokens,
            temperature=0.0,
        )

    async def step(
        self,
        session: Any,
        frame: Image.Image,
        round_idx: int,
        frame_max_pixels: int,
        time_start: float,
        time_end: float,
    ) -> str:
        # One local model instance is shared by tab sessions. Serialize model
        # generation while preserving independent causal histories per session.
        async with self.infer_lock:
            return await asyncio.to_thread(
                session.step,
                frame,
                round_idx=round_idx,
                frame_max_pixels=frame_max_pixels,
                time_start=time_start,
                time_end=time_end,
            )


async def _send_json(ws: ServerConnection, payload: dict[str, Any]) -> None:
    await ws.send(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))


async def _handle_connection(ws: ServerConnection, runtime: Runtime) -> None:
    request_path = getattr(getattr(ws, "request", None), "path", "")
    if request_path and request_path.split("?", 1)[0] != "/v1/panoptic/stream":
        await ws.close(code=1008, reason="unsupported path")
        return

    started = time.time()
    try:
        first = json.loads(await ws.recv())
        if not isinstance(first, dict):
            raise ValueError("start message must be an object")
        config = _parse_start(first)
        session = runtime.new_session(config)

        await _send_json(
            ws,
            {
                "type": "ready",
                "session_id": config.session_id,
                "tab_id": config.tab_id,
                "backend": "panoptic",
                "context_rounds": config.context_rounds,
                "max_frames": config.max_frames,
                "normal_max_pixels": NORMAL_MAX_PIXELS,
                "standby_max_pixels": STANDBY_MAX_PIXELS,
            },
        )

        frames_seen = 0
        last_timestamp_ms = -1.0
        last_end_seconds = 0.0
        standby_high_res_remaining = 0

        async for raw_message in ws:
            payload = json.loads(raw_message)
            if not isinstance(payload, dict):
                raise ValueError("stream message must be an object")
            kind = payload.get("type")

            if kind == "end":
                await _send_json(
                    ws,
                    {
                        "type": "done",
                        "session_id": config.session_id,
                        "tab_id": config.tab_id,
                        "frames_seen": frames_seen,
                        "watched_through_seconds": last_end_seconds,
                        "elapsed_ms": int((time.time() - started) * 1000),
                    },
                )
                return

            if kind != "frame":
                raise ValueError(f"unsupported stream message type: {kind!r}")

            if config.max_frames and frames_seen >= config.max_frames:
                await _send_json(
                    ws,
                    {
                        "type": "done",
                        "reason": "max_frames reached",
                        "session_id": config.session_id,
                        "tab_id": config.tab_id,
                        "frames_seen": frames_seen,
                        "watched_through_seconds": last_end_seconds,
                    },
                )
                return

            frame_id = str(payload.get("frame_id") or "")
            timestamp_ms = float(payload.get("timestamp_ms"))
            duration_ms = max(1.0, float(payload.get("duration_ms") or 1.0))
            epoch = int(payload.get("epoch", 0))
            if not frame_id:
                raise ValueError("frame_id is required")
            if timestamp_ms < 0:
                raise ValueError("timestamp_ms must be non-negative")
            if timestamp_ms <= last_timestamp_ms:
                raise ValueError(
                    f"frame timestamps must be strictly increasing: "
                    f"{timestamp_ms} <= {last_timestamp_ms}"
                )

            encoded = payload.get("image_base64")
            if not isinstance(encoded, str) or not encoded:
                raise ValueError("image_base64 is required")

            frame = _decode_frame(encoded)
            high_res = standby_high_res_remaining > 0
            if high_res:
                standby_high_res_remaining -= 1
            frame_max_pixels = STANDBY_MAX_PIXELS if high_res else NORMAL_MAX_PIXELS

            time_start = timestamp_ms / 1000.0
            time_end = (timestamp_ms + duration_ms) / 1000.0
            answer = await runtime.step(
                session,
                frame,
                round_idx=frames_seen,
                frame_max_pixels=frame_max_pixels,
                time_start=time_start,
                time_end=time_end,
            )
            frames_seen += 1
            last_timestamp_ms = timestamp_ms
            last_end_seconds = max(last_end_seconds, time_end)

            state, content = _parse_stream_answer(answer)
            if state == "standby":
                # Upstream proactive streaming behavior: the next frame gets
                # 2x width/height visual budget (= 4x pixels).
                standby_high_res_remaining = max(standby_high_res_remaining, 1)

            await _send_json(
                ws,
                {
                    "type": "temporal_state",
                    "session_id": config.session_id,
                    "tab_id": config.tab_id,
                    "frame_id": frame_id,
                    "epoch": epoch,
                    "round_idx": frames_seen - 1,
                    "state": state,
                    "content": content,
                    "time_start": time_start,
                    "time_end": time_end,
                    "high_res": high_res,
                    "high_res_next": standby_high_res_remaining > 0,
                },
            )
    except PermissionError as error:
        await ws.close(code=1008, reason=str(error)[:120])
    except Exception as error:
        try:
            await _send_json(
                ws,
                {"type": "error", "reason": f"{type(error).__name__}: {error}"[:500]},
            )
        finally:
            await ws.close(code=1011, reason="Panoptic stream failed")


async def _main_async(host: str, port: int) -> None:
    if host not in {"127.0.0.1", "localhost", "::1"} and not AUTH_TOKEN:
        raise RuntimeError("Refusing non-loopback bind without GNSIS_PANOPTIC_TOKEN")

    runtime = Runtime()
    print(
        f"Panoptic ready on ws://{host}:{port}/v1/panoptic/stream "
        f"(startup={runtime.startup_ms}ms)"
    )
    async with serve(
        lambda ws: _handle_connection(ws, runtime),
        host,
        port,
        max_size=4_000_000,
    ):
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("GNSIS_PANOPTIC_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("GNSIS_PANOPTIC_PORT", "8792")),
    )
    args = parser.parse_args()
    asyncio.run(_main_async(args.host, args.port))


if __name__ == "__main__":
    main()
