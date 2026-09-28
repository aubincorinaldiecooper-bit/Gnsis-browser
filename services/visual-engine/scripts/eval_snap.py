"""Offline evaluation of OCR target snapping on held-out cached features."""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch
from PIL import Image

from gnsis_visual.batching import HEAD_INPUTS, collate
from gnsis_visual.decode import decode
from gnsis_visual.head import HeadConfig, JEVDecisionHead
from gnsis_visual.ocr import TextBox, TextReader, snap_target
from gnsis_visual.prompt import value_candidates
from gnsis_visual.tasks.harness import hit

TARGET_ACTIONS = ("click", "type", "recover")
_reader: TextReader | None = None


def _ocr(path: str) -> tuple[list[dict], float]:
    global _reader
    if _reader is None:
        torch.set_num_threads(1)
        _reader = TextReader()
    boxes, ms = _reader.timed_read(Image.open(path))
    return [b.__dict__ for b in boxes], ms


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--features", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--ocr-cache", required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    rows = [json.loads(line) for line in (Path(args.data) / "states.jsonl").read_text().splitlines()]
    records = torch.load(args.features, weights_only=False)["records"]
    if len(rows) != len(records):
        raise SystemExit("features do not match states")
    ckpt = torch.load(args.head, weights_only=False)
    head = JEVDecisionHead(HeadConfig(**ckpt["config"])).eval()
    head.load_state_dict(ckpt["state_dict"])
    idx = [i for i, r in enumerate(rows) if r["box"] and r["action"] in TARGET_ACTIONS]
    cache_path = Path(args.ocr_cache)
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    todo = [rows[i]["frame"] for i in idx if rows[i]["frame"] not in cache]
    if todo:
        paths = [str(Path(args.data) / "frames" / f) for f in todo]
        with ProcessPoolExecutor(args.workers) as pool:
            for frame, res in zip(todo, pool.map(_ocr, paths), strict=True):
                cache[frame] = {"boxes": res[0], "ms": res[1]}
        cache_path.write_text(json.dumps(cache))
    stats: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    sources: dict[str, int] = defaultdict(int)
    for i in idx:
        row, rec = rows[i], records[i]
        if rec["meta"]["goal"] != row["goal"]:
            raise SystemExit(f"row {i} does not match its features")
        with torch.no_grad():
            out = head(**{k: v for k, v in collate([rec]).items() if k in HEAD_INPUTS})
        grid, viewport, box = tuple(rec["grid"]), tuple(row["viewport"]), tuple(row["box"])
        d = decode(out, value_candidates(row["goal"]), grid, viewport)
        if d.target is None:
            continue
        p_target = torch.softmax(out["target"][0, : grid[0] * grid[1]], -1)
        boxes = [TextBox(b["text"], tuple(b["box"]), b["score"]) for b in cache[row["frame"]]["boxes"]]
        base = (d.target.x, d.target.y)
        variants = {
            "pointer": base,
            "near_text": snap_target(base, row["action"], row["goal"], p_target, grid, viewport, boxes, False)[0],
        }
        snapped, src = snap_target(base, row["action"], row["goal"], p_target, grid, viewport, boxes)
        variants["goal_text"] = snapped
        sources[f"{row['action']}:{src}"] += 1
        for name, pt in variants.items():
            ok = hit(pt, box)
            for key in (name, f"{name}:{row['action']}"):
                stats[key][0] += ok
                stats[key][1] += 1
    ms = sorted(cache[rows[i]["frame"]]["ms"] for i in idx)
    result = {k: f"{a}/{b} = {a / b:.3f}" for k, (a, b) in sorted(stats.items())}
    result["snap_sources"] = dict(sorted(sources.items()))
    result["ocr_ms_full_frame_p50"] = round(ms[len(ms) // 2], 1)
    result["ocr_ms_full_frame_p95"] = round(ms[int(0.95 * (len(ms) - 1))], 1)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
