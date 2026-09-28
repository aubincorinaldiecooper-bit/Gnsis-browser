"""MCP stdio front-end forwards to the daemon and shares its persistent sessions."""

import json
import socket
import sys
import threading
import time

import httpx
import pytest
import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from test_api import PAGE, ClickThenDone

from gnsis_visual.server import create_app


@pytest.fixture()
def daemon():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(ClickThenDone(), prefetch=False), port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/v1/health").json()["ok"]:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield url
    server.should_exit = True
    thread.join(timeout=10)


def _payload(result) -> dict:
    assert not result.is_error, result
    if result.structured_content is not None:
        return result.structured_content.get("result", result.structured_content)
    return json.loads(result.content[0].text)


@pytest.mark.anyio
async def test_mcp_tools_drive_a_daemon_session(daemon):
    params = StdioServerParameters(command=sys.executable, args=["-m", "gnsis_visual.mcp_server", "--api", daemon])
    async with stdio_client(params) as (read, write), ClientSession(read, write) as mcp:
        await mcp.initialize()
        names = {t.name for t in (await mcp.list_tools()).tools}
        assert {
            "open_session",
            "set_task",
            "decide",
            "step",
            "run",
            "execute",
            "session_state",
            "close_session",
        } <= names
        sid = _payload(await mcp.call_tool("open_session", {"url": PAGE}))["session_id"]
        run = _payload(await mcp.call_tool("run", {"session_id": sid, "goal": "Click Go", "max_steps": 4}))
        assert run["status"] == "done"
        async with httpx.AsyncClient() as http:
            state = (await http.get(f"{daemon}/v1/sessions/{sid}")).json()
        assert state["history"] == [{"action": "click"}]
        _payload(await mcp.call_tool("close_session", {"session_id": sid}))


@pytest.fixture()
def anyio_backend():
    return "asyncio"
