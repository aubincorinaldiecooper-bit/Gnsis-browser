"""Extract frozen-backbone decision features for collected states (CPU or GPU)."""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch
from PIL import Image

from gnsis_visual.backbone import BackboneConfig, MiniCPMVBackbone
from gnsis_visual.labels import action_label, target_labels, value_label
from gnsis_visual.prompt import build_layout


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="float32")
    ap.add_argument("--mode", default="16x")
    ap.add_argument("--res", type=int, default=896)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=1)
    args = ap.parse_args()
    bb = MiniCPMVBackbone(
        BackboneConfig(
            args.model, dtype=args.dtype, device=args.device, downsample_mode=args.mode, scale_resolution=args.res
        )
    )
    rows = [json.loads(line) for line in (Path(args.data) / "states.jsonl").read_text().splitlines()]
    if args.limit:
        rows = rows[: args.limit]
    rows = rows[args.shard :: args.shards]
    records, t0 = [], time.time()
    for i, row in enumerate(rows):
        img = Image.open(io.BytesIO((Path(args.data) / "frames" / row["frame"]).read_bytes()))
        layout = build_layout(row["goal"], row["history"])
        feats = bb.decision_features(layout, bb.encode_visual(img))
        pos, off = target_labels(row["box"], feats.grid, tuple(row["viewport"]))
        records.append(
            {
                "queries": feats.queries.half(),
                "actions": feats.actions.half(),
                "values": feats.values.half(),
                "visual": feats.visual.half(),
                "visual_embeds": feats.visual_embeds.half(),
                "grid": feats.grid,
                "motion": float(row["motion"]),
                "action": action_label(row["action"]),
                "value": value_label(row["action"], row["value"], layout.values),
                "target_pos": pos,
                "target_offset": off,
                "meta": {
                    k: row[k] for k in ("episode", "family", "variants", "action", "box", "value", "viewport", "goal")
                },
                "timing_ms": feats.timing_ms,
            }
        )
        if i % 100 == 0:
            print(f"{i}/{len(rows)} {time.time() - t0:.0f}s", flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    torch.save({"records": records, "config": vars(args)}, args.out)
    print(f"saved {len(records)} records to {args.out} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
