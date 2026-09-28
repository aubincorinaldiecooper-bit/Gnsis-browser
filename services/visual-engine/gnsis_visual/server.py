"""Browser Visual API: local daemon with persistent visual sessions over HTTP and WebSocket.

The API exposes only the structured decision contract (`schema.py`); callers never
see which model implements the policy.
"""

from __future__ import annotations

import argparse
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

import psutil
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from playwright.async_api import Browser, async_playwright
from pydantic import BaseModel, Field

from .engine import DecisionPolicy
from .schema import ACTIONS, DecisionError, decision_from_json, validate_decision
from .session import VisualSession

DEFAULT_PORT = 8793
MAX_SESSIONS = 8


class OpenSession(BaseModel):
    url: str | None = None
    width: int = Field(1280, ge=320, le=3840)
    height: int = Field(800, ge=240, le=2160)


class TaskBody(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)


class StepBody(BaseModel):
    min_confidence: float = Field(0.0, ge=0.0, le=1.0)


class RunBody(BaseModel):
    goal: str | None = None
    max_steps: int = Field(12, ge=1, le=100)
    min_confidence: float = Field(0.0, ge=0.0, le=1.0)


@dataclass
class ApiState:
    policy: DecisionPolicy
    browser: Browser | None = None
    prefetch: bool = True
    started: float = 0.0


def create_app(policy: DecisionPolicy, headless: bool = True, prefetch: bool = True) -> FastAPI:
    state = ApiState(policy=policy, prefetch=prefetch, started=time.time())
    sessions: dict[str, VisualSession] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        async with async_playwright() as pw:
            state.browser = await pw.chromium.launch(headless=headless)
            try:
                yield
            finally:
                for s in list(sessions.values()):
                    await s.close()
                await state.browser.close()

    app = FastAPI(title="GNSIS Browser Visual API", version="0.1.0", lifespan=lifespan)

    def get(session_id: str) -> VisualSession:
        s = sessions.get(session_id)
        if s is None:
            raise HTTPException(404, f"unknown session {session_id}")
        return s

    async def run(s: VisualSession, body: RunBody, emit=None) -> dict:
        if body.goal:
            s.set_task(body.goal)
        steps = []
        status = "max_steps"
        for _ in range(body.max_steps):
            decision, result = await s.step(body.min_confidence)
            item = {"decision": decision.to_json(), "executed": result is not None}
            steps.append(item)
            if emit is not None:
                await emit({"type": "step", **item})
            if result is None:
                status = "low_confidence"
                break
            if decision.action == "done":
                status = "done"
                break
        return {"status": status, "steps": steps, "state": s.state()}

    @app.get("/v1/health")
    async def health() -> dict:
        proc = psutil.Process(os.getpid())
        return {
            "ok": state.browser is not None,
            "policy": policy.name,
            "actions": list(ACTIONS),
            "sessions": len(sessions),
            "rss_gb": round(proc.memory_info().rss / 1e9, 2),
            "uptime_s": round(time.time() - state.started, 1),
        }

    @app.post("/v1/sessions")
    async def open_session(body: OpenSession) -> dict:
        if len(sessions) >= MAX_SESSIONS:
            raise HTTPException(429, "session limit reached")
        assert state.browser is not None
        s = await VisualSession.open(policy, state.browser, (body.width, body.height), body.url, state.prefetch)
        sessions[s.id] = s
        return s.state()

    @app.get("/v1/sessions")
    async def list_sessions() -> list[dict]:
        return [s.state() for s in sessions.values()]

    @app.get("/v1/sessions/{session_id}")
    async def session_state(session_id: str) -> dict:
        return get(session_id).state()

    @app.delete("/v1/sessions/{session_id}")
    async def close_session(session_id: str) -> dict:
        s = get(session_id)
        del sessions[session_id]
        await s.close()
        return {"closed": session_id}

    @app.post("/v1/sessions/{session_id}/task")
    async def set_task(session_id: str, body: TaskBody) -> dict:
        s = get(session_id)
        s.set_task(body.goal)
        return s.state()

    @app.post("/v1/sessions/{session_id}/decide")
    async def decide(session_id: str) -> dict:
        s = get(session_id)
        try:
            return (await s.decide()).to_json()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/v1/sessions/{session_id}/step")
    async def step(session_id: str, body: StepBody | None = None) -> dict:
        s = get(session_id)
        try:
            decision, result = await s.step((body or StepBody()).min_confidence)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"decision": decision.to_json(), "executed": result is not None}

    @app.post("/v1/sessions/{session_id}/run")
    async def run_task(session_id: str, body: RunBody) -> dict:
        try:
            return await run(get(session_id), body)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/v1/sessions/{session_id}/execute")
    async def execute(session_id: str, body: dict) -> dict:
        """Execute a caller-supplied structured decision through the same validated actuator."""
        s = get(session_id)
        try:
            decision = validate_decision(decision_from_json(body), s.viewport)
        except (DecisionError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(422, f"invalid decision: {exc}") from exc
        result = await s.execute(decision)
        return {"executed": result.ok, "detail": result.detail}

    @app.get("/v1/sessions/{session_id}/frame")
    async def frame(session_id: str) -> Response:
        s = get(session_id)
        latest = await s.stream.wait_frame(timeout=2.0)
        return Response(latest.jpeg, media_type="image/jpeg", headers={"X-Frame-Id": str(latest.frame_id)})

    @app.websocket("/v1/sessions/{session_id}/ws")
    async def ws(websocket: WebSocket, session_id: str) -> None:
        await websocket.accept()
        s = sessions.get(session_id)
        if s is None:
            await websocket.close(code=4404, reason="unknown session")
            return
        try:
            while True:
                msg = await websocket.receive_json()
                op = msg.get("op")
                try:
                    if op == "task":
                        s.set_task(str(msg["goal"]))
                        out: dict = {"state": s.state()}
                    elif op == "decide":
                        out = {"decision": (await s.decide()).to_json()}
                    elif op == "step":
                        d, r = await s.step(float(msg.get("min_confidence", 0.0)))
                        out = {"decision": d.to_json(), "executed": r is not None}
                    elif op == "run":
                        body = RunBody(**{k: v for k, v in msg.items() if k != "op"})
                        out = await run(s, body, emit=websocket.send_json)
                    elif op == "execute":
                        d = validate_decision(decision_from_json(msg["decision"]), s.viewport)
                        r = await s.execute(d)
                        out = {"executed": r.ok, "detail": r.detail}
                    elif op == "state":
                        out = {"state": s.state()}
                    else:
                        raise ValueError(f"unknown op {op!r}")
                    await websocket.send_json({"type": "result", "op": op, **out})
                except (DecisionError, KeyError, TypeError, ValueError) as exc:
                    await websocket.send_json({"type": "error", "op": op, "error": str(exc)})
        except WebSocketDisconnect:
            return

    return app


def main() -> None:
    import uvicorn

    from .backbone import BackboneConfig
    from .engine import JEVEngine

    ap = argparse.ArgumentParser(description="GNSIS Browser Visual API daemon")
    ap.add_argument("--model", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default=None)
    ap.add_argument("--res", type=int, default=896)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--no-prefetch", action="store_true")
    args = ap.parse_args()
    dtype = args.dtype or ("bfloat16" if args.device == "cuda" else "float32")
    policy = JEVEngine(
        BackboneConfig(args.model, dtype=dtype, device=args.device, scale_resolution=args.res), args.head
    )
    app = create_app(policy, headless=not args.headed, prefetch=not args.no_prefetch)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
