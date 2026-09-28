"""Evaluate OCR grounding stacked with the browser actuator's bounded r24 resolver.

This is an evaluation-only bridge between the existing pixel-only OCR snapper and
the browser-specific actuator cleanup. It replays the same held-out generated
states in a live browser, then scores four paths against oracle boxes:

    raw pointer
    raw pointer + r24
    OCR-snapped pointer
    OCR-snapped pointer + r24

The DOM is used only by the benchmark scorer to emulate the production
PageController resolver after a visual point has already been selected. No DOM
information is passed to the visual model, head, OCR, or decoding path.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch
from PIL import Image
from playwright.async_api import Page, async_playwright

from gnsis_visual.actuator import CoordinateActuator
from gnsis_visual.batching import HEAD_INPUTS, collate
from gnsis_visual.decode import decode
from gnsis_visual.head import HeadConfig, JEVDecisionHead
from gnsis_visual.ocr import TextBox, TextReader, snap_target
from gnsis_visual.prompt import value_candidates
from gnsis_visual.schema import Decision, Target
from gnsis_visual.tasks.episodes import make_episode
from gnsis_visual.tasks.harness import OracleStep, hit, open_episode, oracle
from gnsis_visual.tasks.sites import TaskServer

VIEWPORT = (1280, 800)
TARGET_ACTIONS = ("click", "type", "recover")
EPISODE_SEED = re.compile(r"/p/t(\d+)$")
_reader: TextReader | None = None

# Mirrors packages/page-controller/src/resolveTarget.ts. Keep this deliberately
# local and deterministic: it is scorer-side execution geometry, not perception.
R24_JS = r"""
({ action, point, maxRadiusPx }) => {
  const CLICK_SELECTOR = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="combobox"]'
  ].join(',')

  const NON_TYPABLE = new Set([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image',
    'radio', 'range', 'reset', 'submit'
  ])

  const disabled = (el) =>
    el.getAttribute?.('aria-disabled') === 'true' ||
    ('disabled' in el && Boolean(el.disabled))

  const visible = (el) => {
    if (!(el instanceof HTMLElement) || disabled(el)) return false
    const style = getComputedStyle(el)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none'
    ) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const typable = (el) => {
    if (el instanceof HTMLTextAreaElement) return visible(el)
    if (el instanceof HTMLInputElement) {
      return !NON_TYPABLE.has((el.type || '').toLowerCase()) && visible(el)
    }
    return false
  }

  const editableHost = (start) => {
    let cur = start
    while (cur) {
      if (cur instanceof HTMLElement) {
        const attr = cur.getAttribute('contenteditable')
        if (attr?.toLowerCase() === 'false') return null
        if (attr === '' || attr?.toLowerCase() === 'true') {
          return visible(cur) ? cur : null
        }
      }
      cur = cur.parentElement
    }
    return null
  }

  const compatibleAncestor = (start) => {
    let cur = start
    while (cur) {
      if (cur instanceof HTMLElement) {
        if (action === 'click' && cur.matches(CLICK_SELECTOR) && visible(cur)) return cur
        if (action === 'type' && typable(cur)) return cur
        if (action === 'select' && cur instanceof HTMLSelectElement && visible(cur)) return cur
      }
      cur = cur.parentElement
    }
    if (action === 'type') return editableHost(start)
    return null
  }

  const labelControl = (start) => {
    if (action !== 'type' && action !== 'select') return null
    const label = start instanceof HTMLLabelElement ? start : start.closest?.('label')
    if (!(label instanceof HTMLLabelElement)) return null

    const valid = (el) => {
      if (!(el instanceof HTMLElement)) return false
      if (action === 'type') return typable(el) || editableHost(el) === el
      return el instanceof HTMLSelectElement && visible(el)
    }

    if (valid(label.control)) return label.control
    if (label.htmlFor) {
      const byId = document.getElementById(label.htmlFor)
      if (valid(byId)) return byId
    }
    const wrapped = action === 'type'
      ? label.querySelector('input, textarea, [contenteditable="true"]')
      : label.querySelector('select')
    return valid(wrapped) ? wrapped : null
  }

  const topHit = (x, y) => document.elementsFromPoint(x, y)[0] || null

  const resolveHit = (hit) => {
    if (!hit) return null
    return compatibleAncestor(hit) || labelControl(hit)
  }

  const rectDistance = (el) => {
    const r = el.getBoundingClientRect()
    const dx = Math.max(r.left - point.x, 0, point.x - r.right)
    const dy = Math.max(r.top - point.y, 0, point.y - r.bottom)
    return Math.hypot(dx, dy)
  }

  const center = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  const describe = (el, method, radius = null) => ({
    point: center(el),
    method,
    radius,
    key: el.getAttribute?.('data-k') || null,
    tag: el.tagName || null,
    box: (() => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height]
    })()
  })

  const exactHit = topHit(point.x, point.y)
  const exact = resolveHit(exactHit)
  if (exact) {
    const method = exact === exactHit ? 'exact-hit' : 'actionable-ancestor'
    return { ...describe(exact, method), abstained: false, ambiguous: false, ms: 0 }
  }

  const started = performance.now()
  const capped = Math.max(0, Math.min(24, maxRadiusPx ?? 24))
  for (const radius of [8, 16, 24].filter((r) => r <= capped)) {
    const d = radius / Math.SQRT2
    const offsets = [
      [radius, 0], [-radius, 0], [0, radius], [0, -radius],
      [d, d], [d, -d], [-d, d], [-d, -d]
    ]
    const candidates = new Map()
    for (const [dx, dy] of offsets) {
      const el = resolveHit(topHit(point.x + dx, point.y + dy))
      if (el && !candidates.has(el)) candidates.set(el, rectDistance(el))
    }
    if (!candidates.size) continue

    const ranked = [...candidates.entries()].sort((a, b) => a[1] - b[1])
    const [best, bestDistance] = ranked[0]
    const secondDistance = ranked[1]?.[1]
    if (secondDistance !== undefined && Math.abs(secondDistance - bestDistance) < 2) {
      return {
        point: null,
        method: 'raw-point',
        radius,
        abstained: true,
        ambiguous: true,
        ms: performance.now() - started
      }
    }
    return {
      ...describe(best, 'nearby', radius),
      abstained: false,
      ambiguous: false,
      ms: performance.now() - started
    }
  }

  return {
    point: null,
    method: 'raw-point',
    radius: null,
    abstained: true,
    ambiguous: false,
    ms: performance.now() - started
  }
}
"""


def _ocr(path: str) -> tuple[list[dict], float]:
    global _reader
    if _reader is None:
        torch.set_num_threads(1)
        _reader = TextReader()
    boxes, ms = _reader.timed_read(Image.open(path))
    return [b.__dict__ for b in boxes], ms


def episode_seed(row: dict[str, Any]) -> int:
    match = EPISODE_SEED.fullmatch(row["episode"])
    if not match:
        raise ValueError(f"unsupported episode id: {row['episode']}")
    return int(match.group(1))


async def wait_for_non_wait_oracle(page: Page, timeout_s: float = 5.0) -> OracleStep | None:
    deadline = time.monotonic() + timeout_s
    last: OracleStep | None = None
    while time.monotonic() < deadline:
        last = await oracle(page)
        if last is not None and last.action != "wait":
            return last
        await asyncio.sleep(0.1)
    return last


def decision_from_oracle(step: OracleStep) -> Decision:
    target = None
    if step.box is not None:
        x, y, w, h = step.box
        target = Target(int(x + w / 2), int(y + h / 2))
    return Decision(
        action=step.action,
        confidence=1.0,
        target=target,
        text=step.value if step.action == "type" else None,
        url=step.value if step.action == "navigate" else None,
        direction=step.value if step.action == "scroll" else None,
    )


async def replay_history(page: Page, row: dict[str, Any]) -> tuple[bool, str]:
    actuator = CoordinateActuator(page, VIEWPORT)
    for i, saved in enumerate(row.get("history", [])):
        expected = saved["action"]
        current = await oracle(page)
        if current is None:
            return False, f"history[{i}] oracle unavailable"

        if expected == "wait":
            if current.action != "wait":
                return False, f"history[{i}] expected wait, live={current.action}"
            await asyncio.sleep(0.65)
            continue

        if current.action == "wait":
            current = await wait_for_non_wait_oracle(page)
            if current is None:
                return False, f"history[{i}] timed out waiting for stable oracle"

        if current.action != expected:
            return False, f"history[{i}] expected {expected}, live={current.action}"

        await actuator.execute(decision_from_oracle(current))
        await asyncio.sleep(0.15)

    return True, ""


async def r24(page: Page, action: str, point: tuple[int, int], radius: int) -> dict[str, Any]:
    kind = "click" if action == "recover" else action
    result = await page.evaluate(
        R24_JS,
        {
            "action": kind,
            "point": {"x": point[0], "y": point[1]},
            "maxRadiusPx": radius,
        },
    )
    return result


def group_for(action: str) -> str:
    return {"click": "buttons/links", "type": "text fields", "recover": "dismiss"}[action]


def add_score(stats: dict[str, dict[str, list[int]]], variant: str, group: str, ok: bool) -> None:
    for key in (group, "all"):
        stats[variant][key][0] += int(ok)
        stats[variant][key][1] += 1


def fmt(pair: list[int]) -> str:
    ok, total = pair
    return f"{ok}/{total} = {100 * ok / max(total, 1):.1f}%"


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--features", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--ocr-cache", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--radius", type=int, default=24)
    ap.add_argument("--max-states", type=int, default=0)
    ap.add_argument("--out")
    args = ap.parse_args()

    data = Path(args.data)
    rows = [json.loads(line) for line in (data / "states.jsonl").read_text().splitlines()]
    records = torch.load(args.features, weights_only=False)["records"]
    if len(rows) != len(records):
        raise SystemExit("features do not match states")

    ckpt = torch.load(args.head, weights_only=False)
    head = JEVDecisionHead(HeadConfig(**ckpt["config"])).eval()
    head.load_state_dict(ckpt["state_dict"])

    idx = [i for i, row in enumerate(rows) if row["box"] and row["action"] in TARGET_ACTIONS]
    if args.max_states > 0:
        idx = idx[: args.max_states]

    cache_path = Path(args.ocr_cache)
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    todo = [rows[i]["frame"] for i in idx if rows[i]["frame"] not in cache]
    if todo:
        paths = [str(data / "frames" / frame) for frame in todo]
        with ProcessPoolExecutor(args.workers) as pool:
            for frame, result in zip(todo, pool.map(_ocr, paths), strict=True):
                cache[frame] = {"boxes": result[0], "ms": result[1]}
        cache_path.write_text(json.dumps(cache))

    prepared: dict[int, dict[str, Any]] = {}
    snap_sources: Counter[str] = Counter()
    for i in idx:
        row, rec = rows[i], records[i]
        if rec["meta"]["goal"] != row["goal"]:
            raise SystemExit(f"row {i} does not match its features")

        with torch.no_grad():
            out = head(**{k: v for k, v in collate([rec]).items() if k in HEAD_INPUTS})

        grid = tuple(rec["grid"])
        viewport = tuple(row["viewport"])
        decoded = decode(out, value_candidates(row["goal"]), grid, viewport)
        if decoded.target is None:
            continue

        pointer = (decoded.target.x, decoded.target.y)
        p_target = torch.softmax(out["target"][0, : grid[0] * grid[1]], -1)
        boxes = [
            TextBox(box["text"], tuple(box["box"]), box["score"])
            for box in cache[row["frame"]]["boxes"]
        ]
        ocr_point, source = snap_target(
            pointer,
            row["action"],
            row["goal"],
            p_target,
            grid,
            viewport,
            boxes,
        )
        snap_sources[f"{row['action']}:{source}"] += 1
        prepared[i] = {"raw": pointer, "ocr": ocr_point, "ocr_source": source}

    stats: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    rescue: Counter[str] = Counter()
    false_fix: Counter[str] = Counter()
    wrong_neighbor: Counter[str] = Counter()
    abstain: Counter[str] = Counter()
    methods: Counter[str] = Counter()
    resolver_ms: list[float] = []
    shifts: list[float] = []
    unmatched: list[dict[str, Any]] = []
    probed = 0

    server = TaskServer()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            for n, i in enumerate(prepared, start=1):
                row = rows[i]
                server.pages.clear()
                server.hits.clear()
                episode = make_episode(server, episode_seed(row), test=True)

                context = await browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
                page = await context.new_page()
                try:
                    await open_episode(page, server, episode)
                    ok, reason = await replay_history(page, row)
                    if not ok:
                        unmatched.append({"row": i, "frame": row["frame"], "reason": reason})
                        continue

                    truth = await oracle(page)
                    if truth is not None and truth.action == "wait":
                        truth = await wait_for_non_wait_oracle(page)
                    if truth is None or truth.action != row["action"] or truth.box is None:
                        unmatched.append(
                            {
                                "row": i,
                                "frame": row["frame"],
                                "reason": (
                                    "oracle mismatch: "
                                    f"saved={row['action']} live={None if truth is None else truth.action}"
                                ),
                            }
                        )
                        continue

                    probed += 1
                    group = group_for(row["action"])
                    raw_point = prepared[i]["raw"]
                    ocr_point = prepared[i]["ocr"]
                    raw_ok = hit(raw_point, truth.box)
                    ocr_ok = hit(ocr_point, truth.box)

                    add_score(stats, "raw", group, raw_ok)
                    add_score(stats, "ocr", group, ocr_ok)

                    for source_name, point, base_ok in (
                        ("raw", raw_point, raw_ok),
                        ("ocr", ocr_point, ocr_ok),
                    ):
                        resolved = await r24(page, row["action"], point, args.radius)
                        resolved_point = resolved.get("point")
                        resolved_ok = bool(
                            resolved_point
                            and hit(
                                (int(round(resolved_point["x"])), int(round(resolved_point["y"]))),
                                truth.box,
                            )
                        )
                        variant = f"{source_name}+r{args.radius}"
                        add_score(stats, variant, group, resolved_ok)

                        method = resolved.get("method", "unknown")
                        methods[f"{source_name}:{row['action']}:{method}"] += 1
                        resolver_ms.append(float(resolved.get("ms") or 0.0))

                        if resolved.get("abstained"):
                            abstain[f"{source_name}:{group}"] += 1
                        if not base_ok and resolved_ok:
                            rescue[f"{source_name}:{group}"] += 1
                        if base_ok and not resolved_ok:
                            false_fix[f"{source_name}:{group}"] += 1
                        if not base_ok and not resolved_ok and resolved_point:
                            wrong_neighbor[f"{source_name}:{group}"] += 1

                        if resolved_point:
                            dx = float(resolved_point["x"]) - point[0]
                            dy = float(resolved_point["y"]) - point[1]
                            shifts.append((dx * dx + dy * dy) ** 0.5)

                    print(
                        f"{n}/{len(prepared)} {row['action']:<7} "
                        f"raw={int(raw_ok)} ocr={int(ocr_ok)}",
                        flush=True,
                    )
                finally:
                    await context.close()

            await browser.close()
    finally:
        server.close()

    def pct(values: list[float], q: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        return round(ordered[min(len(ordered) - 1, int(q * (len(ordered) - 1)))], 2)

    report = {
        "states_requested": len(prepared),
        "states_probed": probed,
        "states_unmatched": len(unmatched),
        "radius_px": min(24, max(0, args.radius)),
        "accuracy": {
            variant: {group: fmt(pair) for group, pair in sorted(groups.items())}
            for variant, groups in sorted(stats.items())
        },
        "rescues": dict(sorted(rescue.items())),
        "false_fixes": dict(sorted(false_fix.items())),
        "wrong_neighbors": dict(sorted(wrong_neighbor.items())),
        "abstentions": dict(sorted(abstain.items())),
        "resolver_methods": dict(sorted(methods.items())),
        "snap_sources": dict(sorted(snap_sources.items())),
        "resolver_ms_p50": pct(resolver_ms, 0.5),
        "resolver_ms_p95": pct(resolver_ms, 0.95),
        "resolved_shift_px_mean": round(sum(shifts) / max(len(shifts), 1), 2),
        "resolved_shift_px_p90": pct(shifts, 0.9),
        "ocr_ms_full_frame_p50": pct(
            [float(cache[rows[i]["frame"]]["ms"]) for i in prepared],
            0.5,
        ),
        "ocr_ms_full_frame_p95": pct(
            [float(cache[rows[i]["frame"]]["ms"]) for i in prepared],
            0.95,
        ),
        "unmatched": unmatched[:50],
    }

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(report, indent=2))

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
