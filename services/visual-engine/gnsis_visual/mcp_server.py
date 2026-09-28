"""MCP (stdio) front-end for the Browser Visual API daemon.

The MCP process is a thin client: sessions live in the daemon, so MCP clients,
HTTP clients and WebSocket clients can share the same persistent visual sessions.
"""

from __future__ import annotations

import argparse
import os

import httpx
from mcp.server.mcpserver import MCPServer

API = os.environ.get("GNSIS_VISUAL_API", "http://127.0.0.1:8793")

server = MCPServer(
    name="gnsis-browser-visual",
    instructions=(
        "Visual System-1 browser control. Open a session, give it a goal, then step or run. "
        "Decisions are structured actions (click/type/scroll/navigate/back/wait/done/recover) chosen "
        "from the rendered page only."
    ),
)


def _call(method: str, path: str, json: dict | None = None) -> dict:
    with httpx.Client(base_url=API, timeout=120) as client:
        r = client.request(method, path, json=json)
        r.raise_for_status()
        return r.json()


@server.tool()
def open_session(url: str | None = None, width: int = 1280, height: int = 800) -> dict:
    """Open a persistent visual browser session (one tab + continuous rendered stream)."""
    return _call("POST", "/v1/sessions", {"url": url, "width": width, "height": height})


@server.tool()
def set_task(session_id: str, goal: str) -> dict:
    """Set the goal the visual engine should pursue in the session."""
    return _call("POST", f"/v1/sessions/{session_id}/task", {"goal": goal})


@server.tool()
def decide(session_id: str) -> dict:
    """Return the next structured decision for the current rendered frame without executing it."""
    return _call("POST", f"/v1/sessions/{session_id}/decide")


@server.tool()
def step(session_id: str, min_confidence: float = 0.0) -> dict:
    """Decide and execute one action."""
    return _call("POST", f"/v1/sessions/{session_id}/step", {"min_confidence": min_confidence})


@server.tool()
def run(session_id: str, goal: str | None = None, max_steps: int = 12, min_confidence: float = 0.0) -> dict:
    """Run decide/execute until done, low confidence, or max_steps."""
    body = {"goal": goal, "max_steps": max_steps, "min_confidence": min_confidence}
    return _call("POST", f"/v1/sessions/{session_id}/run", body)


@server.tool()
def execute(session_id: str, decision: dict) -> dict:
    """Execute a caller-supplied structured decision through the validated actuator."""
    return _call("POST", f"/v1/sessions/{session_id}/execute", decision)


@server.tool()
def session_state(session_id: str) -> dict:
    """Session goal, URL, bounded history, stream and cache statistics."""
    return _call("GET", f"/v1/sessions/{session_id}")


@server.tool()
def close_session(session_id: str) -> dict:
    """Close a session and its tab."""
    return _call("DELETE", f"/v1/sessions/{session_id}")


def main() -> None:
    global API
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=API)
    API = ap.parse_args().api
    server.run("stdio")


if __name__ == "__main__":
    main()
