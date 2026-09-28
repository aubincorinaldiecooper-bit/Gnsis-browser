"""Native backbone latency/memory benchmark on a rendered test page (CPU or GPU)."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psutil
import torch
from PIL import Image, ImageDraw

from gnsis_visual.backbone import BackboneConfig, MiniCPMVBackbone
from gnsis_visual.prompt import build_layout


def test_frame() -> Image.Image:
    img = Image.new("RGB", (1280, 800), "white")
    d = ImageDraw.Draw(img)
    for i in range(12):
        d.rectangle(
            [40 + (i % 4) * 300, 120 + (i // 4) * 200, 240 + (i % 4) * 300, 160 + (i // 4) * 200], fill="#2563eb"
        )
        d.text((60 + (i % 4) * 300, 132 + (i // 4) * 200), f"Button {i}", fill="white")
    return img


def pct(values: list[float], q: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, round(q * (len(s) - 1)))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="float32")
    ap.add_argument("--mode", default="16x")
    ap.add_argument("--res", type=int, default=896)
    ap.add_argument("--runs", type=int, default=12)
    ap.add_argument("--image")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    proc = psutil.Process()
    t = time.perf_counter()
    bb = MiniCPMVBackbone(
        BackboneConfig(
            args.model, dtype=args.dtype, device=args.device, downsample_mode=args.mode, scale_resolution=args.res
        )
    )
    load_s = time.perf_counter() - t
    img = Image.open(args.image).convert("RGB") if args.image else test_frame()
    layout = build_layout('Type "alice@example.com" into the Email field', [{"action": "click"}])
    timings = []
    proc.cpu_percent()
    for i in range(args.runs + 2):
        t0 = time.perf_counter()
        feats = bb.decision_features(layout, bb.encode_visual(img))
        total = (time.perf_counter() - t0) * 1e3
        if i >= 2:
            timings.append({**feats.timing_ms, "total": total})
    cpu = proc.cpu_percent() / psutil.cpu_count()
    result = {
        "device": args.device,
        "gpu": torch.cuda.get_device_name() if args.device == "cuda" else None,
        "dtype": args.dtype,
        "mode": args.mode,
        "res": args.res,
        "grid": list(feats.grid),
        "tokens": int(feats.timing_ms["tokens"]),
        "load_s": round(load_s, 1),
        "rss_gb": round(proc.memory_info().rss / 1e9, 2),
        "gpu_mem_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2) if args.device == "cuda" else None,
        "cpu_util_pct": round(cpu, 1),
    }
    for key in ("vision", "language", "total"):
        vals = [x[key] for x in timings]
        result[f"{key}_p50_ms"] = round(statistics.median(vals), 1)
        result[f"{key}_p95_ms"] = round(pct(vals, 0.95), 1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
