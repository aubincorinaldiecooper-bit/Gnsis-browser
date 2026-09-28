"""End-to-end evaluation: the learned policy drives generated browser tasks through the live stream.

The visual engine only sees screencast frames, the goal and its own action history.
Ground truth (oracle step, success) is read from the page runtime for scoring only.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import resource
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psutil
import torch
from playwright.async_api import async_playwright

from gnsis_visual.backbone import BackboneConfig
from gnsis_visual.engine import JEVEngine
from gnsis_visual.schema import DecisionError
from gnsis_visual.session import VisualSession
from gnsis_visual.tasks.episodes import make_episode
from gnsis_visual.tasks.harness import hit, open_episode, oracle, success
from gnsis_visual.tasks.sites import TaskServer

VIEWPORT = (1280, 800)
TARGET_ACTIONS = ("click", "type")


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 1)


async def run_episode(browser, server: TaskServer, policy: JEVEngine, seed: int, min_conf: float) -> dict:
    episode = make_episode(server, seed, test=True)
    context = await browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
    page = await context.new_page()
    session = VisualSession(policy, page, context, VIEWPORT)
    steps: list[dict] = []
    ended = "max_steps"
    try:
        await open_episode(page, server, episode)
        await session.stream.start()
        session.set_task(episode.goal)
        for _ in range(episode.max_steps + 4):
            decision = await session.decide()
            truth = await oracle(page)
            step = {
                "decision": decision.to_json(),
                "oracle": None if truth is None else {"action": truth.action, "box": truth.box, "value": truth.value},
            }
            if truth is not None:
                step["action_ok"] = decision.action == truth.action
                if truth.action in TARGET_ACTIONS and truth.box is not None:
                    step["target_ok"] = decision.target is not None and hit(
                        (decision.target.x, decision.target.y), truth.box
                    )
            steps.append(step)
            if decision.action == "done":
                ended = "done"
                break
            if decision.confidence < min_conf:
                ended = "low_confidence"
                break
            try:
                await session.execute(decision)
            except DecisionError as exc:
                step["rejected"] = str(exc)
        ok = await success(page)
    finally:
        await session.close()
    return {
        "seed": seed,
        "family": episode.family,
        "variants": episode.variants,
        "goal": episode.goal,
        "success": ok,
        "ended": ended,
        "steps": steps,
        "cache": {"hits": session.cache.hits, "misses": session.cache.misses},
    }


def summarize(results: list[dict], wall_s: float, cpu_s: float, device: str) -> dict:
    by_family: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    by_variant: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    action = [0, 0]
    target = [0, 0]
    timings: dict[str, list[float]] = defaultdict(list)
    hits = misses = 0
    for r in results:
        by_family[r["family"]][0] += r["success"]
        by_family[r["family"]][1] += 1
        for v in r["variants"] or ["plain"]:
            by_variant[v][0] += r["success"]
            by_variant[v][1] += 1
        hits += r["cache"]["hits"]
        misses += r["cache"]["misses"]
        for s in r["steps"]:
            if "action_ok" in s:
                action[0] += s["action_ok"]
                action[1] += 1
            if "target_ok" in s:
                target[0] += s["target_ok"]
                target[1] += 1
            t = s["decision"].get("timing_ms", {})
            for k in ("total", "vision", "language", "head"):
                if k in t:
                    timings[k].append(t[k])
            if t.get("vision", 0) > 0:
                timings["total_miss"].append(t["total"])
            elif "total" in t:
                timings["total_hit"].append(t["total"])
    n = len(results)
    out = {
        "episodes": n,
        "task_success": round(sum(r["success"] for r in results) / max(n, 1), 4),
        "success_by_family": {k: f"{a}/{b}" for k, (a, b) in sorted(by_family.items())},
        "success_by_variant": {k: f"{a}/{b}" for k, (a, b) in sorted(by_variant.items())},
        "online_action_acc": round(action[0] / max(action[1], 1), 4),
        "online_target_acc": round(target[0] / max(target[1], 1), 4),
        "decisions": sum(len(r["steps"]) for r in results),
        "latency_ms": {k: {"p50": pct(v, 0.5), "p95": pct(v, 0.95), "n": len(v)} for k, v in sorted(timings.items())},
        "visual_cache": {"hits": hits, "misses": misses},
        "peak_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, 2),
        "cpu_util_cores": round(cpu_s / wall_s, 2),
        "cpu_count": os.cpu_count(),
        "wall_s": round(wall_s, 1),
        "device": device,
    }
    if device.startswith("cuda"):
        out["gpu_peak_mem_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
        out["gpu_name"] = torch.cuda.get_device_name()
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="float32")
    ap.add_argument("--res", type=int, default=896)
    ap.add_argument("--mode", default="16x")
    ap.add_argument("--episodes", type=int, default=100)
    ap.add_argument("--seed0", type=int, default=50_000)
    ap.add_argument("--min-confidence", type=float, default=0.0)
    args = ap.parse_args()
    policy = JEVEngine(
        BackboneConfig(
            args.model, dtype=args.dtype, device=args.device, downsample_mode=args.mode, scale_resolution=args.res
        ),
        args.head,
    )
    server = TaskServer()
    proc = psutil.Process()
    results: list[dict] = []
    cpu0, t0 = proc.cpu_times(), time.time()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        for i, seed in enumerate(range(args.seed0, args.seed0 + args.episodes)):
            try:
                results.append(await run_episode(browser, server, policy, seed, args.min_confidence))
            except Exception as exc:
                print(f"episode {seed} failed: {exc!r}", flush=True)
                continue
            r = results[-1]
            print(
                f"{i + 1}/{args.episodes} {r['family']:<8} success={r['success']} ended={r['ended']} steps={len(r['steps'])}",
                flush=True,
            )
        await browser.close()
    cpu1 = proc.cpu_times()
    cpu_s = (cpu1.user - cpu0.user) + (cpu1.system - cpu0.system)
    summary = summarize(results, time.time() - t0, cpu_s, args.device)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"summary": summary, "episodes": results}, indent=1))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
