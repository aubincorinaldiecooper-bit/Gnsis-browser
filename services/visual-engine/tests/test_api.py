"""Browser Visual API against a real headless Chromium, with a model-free policy."""

import time
import urllib.parse

import pytest
from fastapi.testclient import TestClient

from gnsis_visual.engine import VisualCache
from gnsis_visual.schema import Decision, Target
from gnsis_visual.server import create_app
from gnsis_visual.stream import Frame

PAGE = "data:text/html," + urllib.parse.quote(
    "<body style='margin:0'><button id=b style='position:absolute;left:100px;top:100px;width:200px;height:80px'"
    " onclick=\"document.body.style.background='red';this.textContent='clicked'\">Go</button></body>"
)


class ClickThenDone:
    """Clicks the button once, then reports done; records what the API passed in."""

    name = "scripted-test-policy"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def encode(self, frame: Frame, cache: VisualCache) -> None:
        pass

    def decide(self, frame, goal, history, motion, viewport, cache) -> Decision:
        self.calls.append({"goal": goal, "history": history, "frame_id": frame.frame_id, "viewport": viewport})
        if any(h["action"] == "click" for h in history):
            return Decision("done", 0.9, frame_id=frame.frame_id)
        return Decision("click", 0.8, Target(200, 140), frame_id=frame.frame_id)


@pytest.fixture()
def api():
    policy = ClickThenDone()
    with TestClient(create_app(policy, headless=True, prefetch=False)) as client:
        yield client, policy


def test_http_session_runs_task_to_done(api):
    client, policy = api
    assert client.get("/v1/health").json()["policy"] == "scripted-test-policy"
    sid = client.post("/v1/sessions", json={"url": PAGE}).json()["session_id"]
    assert client.post(f"/v1/sessions/{sid}/decide").status_code == 409

    client.post(f"/v1/sessions/{sid}/task", json={"goal": "Click Go"})
    result = client.post(f"/v1/sessions/{sid}/run", json={"max_steps": 5}).json()
    assert result["status"] == "done"
    assert [s["decision"]["action"] for s in result["steps"]] == ["click", "done"]
    assert result["state"]["history"] == [{"action": "click"}]
    assert policy.calls[-1]["frame_id"] > policy.calls[0]["frame_id"], "decisions must follow the live stream"
    assert result["state"]["stream"]["frames_received"] >= 2

    frame = client.get(f"/v1/sessions/{sid}/frame")
    assert frame.headers["content-type"] == "image/jpeg" and frame.content[:2] == b"\xff\xd8"
    assert client.delete(f"/v1/sessions/{sid}").status_code == 200
    assert client.get(f"/v1/sessions/{sid}").status_code == 404


def test_low_confidence_decisions_are_not_executed(api):
    client, _ = api
    sid = client.post("/v1/sessions", json={"url": PAGE}).json()["session_id"]
    client.post(f"/v1/sessions/{sid}/task", json={"goal": "Click Go"})
    out = client.post(f"/v1/sessions/{sid}/step", json={"min_confidence": 0.95}).json()
    assert out == {"decision": out["decision"], "executed": False}
    assert client.get(f"/v1/sessions/{sid}").json()["history"] == []


def test_execute_rejects_invalid_caller_decisions(api):
    client, _ = api
    sid = client.post("/v1/sessions", json={"url": PAGE}).json()["session_id"]
    for bad in (
        {"action": "click"},
        {"action": "click", "target": {"x": 5000, "y": 1}},
        {"action": "eval"},
        {"action": "navigate", "url": "file:///etc/passwd"},
    ):
        assert client.post(f"/v1/sessions/{sid}/execute", json=bad).status_code == 422
    ok = client.post(f"/v1/sessions/{sid}/execute", json={"action": "click", "target": {"x": 200, "y": 140}})
    assert ok.json()["executed"] is True


def test_websocket_session(api):
    client, _ = api
    sid = client.post("/v1/sessions", json={"url": PAGE}).json()["session_id"]
    with client.websocket_connect(f"/v1/sessions/{sid}/ws") as ws:
        ws.send_json({"op": "decide"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"op": "execute", "decision": {"action": "type", "target": {"x": 1, "y": 1}}})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"op": "run", "goal": "Click Go", "max_steps": 4})
        events = [ws.receive_json(), ws.receive_json(), ws.receive_json()]
        assert [e["type"] for e in events] == ["step", "step", "result"]
        assert events[-1]["status"] == "done"
        ws.send_json({"op": "nope"})
        assert ws.receive_json()["type"] == "error"


def test_session_limit(api):
    client, _ = api
    t0 = time.time()
    ids = [client.post("/v1/sessions", json={}).json()["session_id"] for _ in range(8)]
    assert client.post("/v1/sessions", json={}).status_code == 429
    for sid in ids:
        client.delete(f"/v1/sessions/{sid}")
    assert time.time() - t0 < 60
