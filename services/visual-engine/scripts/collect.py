"""Collect labelled rendered-stream states by running the oracle policy.

Frames are taken from the persistent CDP screencast (same path as live use);
labels come from the evaluation-only page runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.async_api import async_playwright

from gnsis_visual.actuator import CoordinateActuator
from gnsis_visual.schema import Decision, Target
from gnsis_visual.stream import ScreencastStream
from gnsis_visual.tasks.episodes import make_episode
from gnsis_visual.tasks.harness import open_episode, oracle
from gnsis_visual.tasks.sites import TaskServer

VIEWPORT = (1280, 800)


def to_decision(step, jitter: random.Random) -> Decision:
    target = None
    if step.box is not None:
        x, y, w, h = step.box
        target = Target(int(x + w * jitter.uniform(0.3, 0.7)), int(y + h * jitter.uniform(0.3, 0.7)))
    act = step.action
    return Decision(
        action=act,
        confidence=1.0,
        target=target,
        text=step.value if act == "type" else None,
        url=step.value if act == "navigate" else None,
        direction=step.value if act == "scroll" else None,
    )


async def run_episode(browser, server, seed, test, out_dir: Path, rows: list) -> None:
    episode = make_episode(server, seed, test)
    context = await browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
    page = await context.new_page()
    stream = ScreencastStream(page, VIEWPORT)
    jitter = random.Random(seed)
    history: list[dict] = []
    try:
        await open_episode(page, server, episode)
        await stream.start()
        for step_i in range(episode.max_steps):
            frame = await stream.settle(timeout=1.2)
            before = await oracle(page)
            motion = stream.motion()
            after = await oracle(page)
            if before is None or after is None or before != after:
                await asyncio.sleep(0.3)
                continue
            name = f"{episode.episode_id.strip('/').replace('/', '_')}_{step_i}.jpg"
            (out_dir / name).write_bytes(frame.jpeg)
            rows.append(
                {
                    "episode": episode.episode_id,
                    "family": episode.family,
                    "variants": episode.variants,
                    "goal": episode.goal,
                    "history": list(history),
                    "frame": name,
                    "motion": motion,
                    "action": before.action,
                    "box": before.box,
                    "value": before.value,
                    "viewport": VIEWPORT,
                }
            )
            if before.action == "done":
                break
            decision = to_decision(before, jitter)
            if decision.action == "wait":
                await asyncio.sleep(0.6)
            else:
                await CoordinateActuator(page, VIEWPORT).execute(decision)
            history.append({k: v for k, v in decision.to_json().items() if k in ("action", "text", "url", "direction")})
            await asyncio.sleep(0.15)
    finally:
        await stream.stop()
        await context.close()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--episodes", type=int, default=100)
    ap.add_argument("--seed0", type=int, default=0)
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    out = Path(args.out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    server = TaskServer()
    rows: list = []
    seeds = list(range(args.seed0, args.seed0 + args.episodes))
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        queue: asyncio.Queue = asyncio.Queue()
        for s in seeds:
            queue.put_nowait(s)

        async def worker() -> None:
            while not queue.empty():
                seed = queue.get_nowait()
                try:
                    await run_episode(browser, server, seed, args.test, out / "frames", rows)
                except Exception as exc:  # keep collecting; report failures
                    print(f"episode {seed} failed: {exc!r}", flush=True)

        await asyncio.gather(*(worker() for _ in range(args.workers)))
        await browser.close()
    with open(out / "states.jsonl", "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["action"]] = counts.get(row["action"], 0) + 1
    print(f"{len(rows)} states from {len(seeds)} episodes: {counts}")


if __name__ == "__main__":
    asyncio.run(main())
