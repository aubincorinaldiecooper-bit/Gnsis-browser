"""Procedural websites with known visual targets, served from memory over HTTP."""

from __future__ import annotations

import html
import json
import random
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import vocab

RUNTIME_JS = (Path(__file__).parent / "runtime.js").read_text()
FONTS = ["Liberation Sans", "DejaVu Sans", "Liberation Serif", "DejaVu Serif", "Liberation Mono", "JetBrains Mono"]
LIGHT_BG = ["#ffffff", "#f7f7f9", "#fdf6e3", "#eef2f7", "#f4f1ea", "#fafafa"]
DARK_BG = ["#111827", "#1e1e1e", "#0f172a", "#18181b", "#1f2933"]
ACCENTS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#4b5563", "#ca8a04"]


@dataclass
class Theme:
    bg: str
    fg: str
    muted: str
    card: str
    accent: str
    font: str
    size: int
    radius: int
    button_style: str

    @staticmethod
    def sample(rng: random.Random) -> Theme:
        dark = rng.random() < 0.3
        return Theme(
            bg=rng.choice(DARK_BG if dark else LIGHT_BG),
            fg="#e5e7eb" if dark else "#111827",
            muted="#9ca3af" if dark else "#6b7280",
            card="#27272a" if dark else "#ffffff",
            accent=rng.choice(ACCENTS),
            font=rng.choice(FONTS),
            size=rng.randint(13, 18),
            radius=rng.choice([0, 3, 6, 10, 20]),
            button_style=rng.choice(["filled", "outline", "pill", "flat"]),
        )

    def css(self) -> str:
        b = {
            "filled": f"background:{self.accent};color:#fff;border:0",
            "outline": f"background:transparent;color:{self.accent};border:2px solid {self.accent}",
            "pill": f"background:{self.accent};color:#fff;border:0;border-radius:999px",
            "flat": f"background:{self.card};color:{self.fg};border:1px solid {self.muted}",
        }[self.button_style]
        return f"""
*{{box-sizing:border-box}} body{{margin:0;background:{self.bg};color:{self.fg};font-family:'{self.font}';font-size:{self.size}px}}
header{{display:flex;align-items:center;gap:22px;padding:14px 28px;border-bottom:1px solid {self.muted}}}
header .logo{{font-weight:bold;font-size:1.3em;margin-right:auto}} a{{color:{self.accent};cursor:pointer}}
main{{padding:20px 28px}} .grid{{display:grid;gap:18px}} .card{{background:{self.card};padding:14px;border-radius:{self.radius}px;
border:1px solid {self.muted}}} .btn{{{b};border-radius:{self.radius}px;padding:.55em 1.2em;font:inherit;cursor:pointer}}
.muted{{color:{self.muted}}} label{{display:block;margin:10px 0 4px}} input{{font:inherit;padding:.45em;width:280px;
border:1px solid {self.muted};border-radius:{min(self.radius, 8)}px;background:{self.card};color:{self.fg}}}
#toast{{display:none;position:fixed;top:18px;right:18px;background:#16a34a;color:#fff;padding:12px 18px;border-radius:8px;font-weight:bold}}
#busy{{display:none;position:fixed;inset:0;background:{self.bg}e0;align-items:center;justify-content:center;flex-direction:column;gap:14px}}
.spin{{width:46px;height:46px;border:6px solid {self.muted};border-top-color:{self.accent};border-radius:50%;animation:s .8s linear infinite}}
@keyframes s{{to{{transform:rotate(360deg)}}}}
#overlay{{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center}}
#overlay.bottom{{align-items:flex-end;background:#0002}} #overlay .box{{background:{self.card};padding:24px;border-radius:10px;max-width:520px}}
#overlay.bottom .box{{max-width:none;width:100%;border-radius:0}}
"""


def _text(rng: random.Random, n: int) -> str:
    return " ".join(rng.choice(vocab.WORDS) for _ in range(n)).capitalize() + "."


@dataclass
class PageSpec:
    family: str
    title: str
    body: str
    theme: Theme
    site: str
    runtime: dict = field(default_factory=dict)
    error_first: bool = False

    def render(self) -> str:
        overlay = self.runtime.get("overlay_html", "")
        spec = {k: v for k, v in self.runtime.items() if k != "overlay_html"}
        spec["family"] = self.family
        return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(self.title)}</title>
<style>{self.theme.css()}</style></head><body>{self.body}
<div id="toast"></div><div id="busy"><div class="spin"></div><div class="muted">Loading…</div></div>{overlay}
<script>window.__spec={json.dumps(spec)};</script><script>{RUNTIME_JS}</script></body></html>"""


ERROR_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family:'DejaVu Sans';background:#f1f3f4;color:#202124;padding:120px 20%">
<div style="font-size:64px">:(</div><h1>This page isn’t working</h1><p>The server was unable to handle this request.</p>
<p style="color:#5f6368">HTTP ERROR 500</p>
<script>window.__st={};window.__oracle=()=>({action:'recover'});window.__success=()=>false;</script></body></html>"""


class TaskServer:
    """In-memory HTTP server for generated pages; tracks hits for error-first pages."""

    def __init__(self) -> None:
        self.pages: dict[str, PageSpec] = {}
        self.hits: dict[str, int] = {}
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                spec = server.pages.get(self.path)
                if spec is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                server.hits[self.path] = server.hits.get(self.path, 0) + 1
                body = ERROR_PAGE if spec.error_first and server.hits[self.path] == 1 else spec.render()
                data = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def close(self) -> None:
        self.httpd.shutdown()
