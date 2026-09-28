"""Train the JEV decision head on cached backbone features and report offline accuracy."""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch

from gnsis_visual.batching import HEAD_INPUTS, collate
from gnsis_visual.decode import decode
from gnsis_visual.head import HeadConfig, JEVDecisionHead, decision_loss
from gnsis_visual.prompt import value_candidates
from gnsis_visual.tasks.harness import hit


def to_device(batch: dict[str, torch.Tensor], device: str) -> dict[str, torch.Tensor]:
    return {k: v.to(device) if isinstance(v, torch.Tensor) else v for k, v in batch.items()}


def load(paths: list[str]) -> list[dict]:
    records: list[dict] = []
    for path in paths:
        records += torch.load(path, weights_only=False)["records"]
    return records


def evaluate(head: JEVDecisionHead, records: list[dict], device: str = "cpu") -> dict:
    head.eval()
    stats = defaultdict(lambda: [0, 0])
    per_action = defaultdict(lambda: [0, 0])
    head_ms = []
    with torch.no_grad():
        for r in records:
            batch = to_device(collate([r]), device)
            t0 = time.perf_counter()
            out = {k: v.float().cpu() for k, v in head(**{k: batch[k] for k in HEAD_INPUTS}).items()}
            meta = r["meta"]
            d = decode(out, value_candidates(meta["goal"]), tuple(r["grid"]), tuple(meta["viewport"]))
            head_ms.append((time.perf_counter() - t0) * 1e3)
            ok_action = d.action == meta["action"]
            stats["action"][0] += ok_action
            stats["action"][1] += 1
            per_action[meta["action"]][0] += ok_action
            per_action[meta["action"]][1] += 1
            if meta["box"] is not None and meta["action"] in ("click", "type", "recover"):
                ok_t = d.target is not None and hit((d.target.x, d.target.y), tuple(meta["box"]))
                stats["target"][0] += ok_t
                stats["target"][1] += 1
                stats[f"target_{meta['action']}"][0] += ok_t
                stats[f"target_{meta['action']}"][1] += 1
            if meta["action"] in ("type", "navigate", "scroll"):
                got = d.text or d.url or d.direction
                stats["value"][0] += ok_action and got == meta["value"]
                stats["value"][1] += 1
            full = ok_action
            if meta["action"] in ("click", "type") or (meta["action"] == "recover" and meta["box"]):
                full = full and d.target is not None and hit((d.target.x, d.target.y), tuple(meta["box"]))
            if meta["action"] in ("type", "navigate", "scroll"):
                full = full and (d.text or d.url or d.direction) == meta["value"]
            stats["decision"][0] += full
            stats["decision"][1] += 1
    res = {k: round(a / b, 4) for k, (a, b) in stats.items()}
    res["n"] = len(records)
    res["per_action"] = {k: f"{a}/{b}" for k, (a, b) in sorted(per_action.items())}
    head_ms.sort()
    res["head_ms_p50"] = round(head_ms[len(head_ms) // 2], 2)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True, nargs="+")
    ap.add_argument("--test", required=True, nargs="+")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    train, test = load(args.train), load(args.test)
    layers, _, hidden = train[0]["visual"].shape
    head = JEVDecisionHead(HeadConfig(hidden_size=hidden, n_layers=layers)).to(args.device)
    opt = torch.optim.AdamW(head.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * ((len(train) + args.bs - 1) // args.bs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    print(f"train={len(train)} test={len(test)} params={sum(p.numel() for p in head.parameters()) / 1e6:.2f}M")
    for epoch in range(args.epochs):
        head.train()
        random.shuffle(train)
        totals = defaultdict(float)
        for i in range(0, len(train), args.bs):
            batch = to_device(collate(train[i : i + args.bs]), args.device)
            losses = decision_loss(head(**{k: batch[k] for k in HEAD_INPUTS}), batch)
            opt.zero_grad()
            losses["total"].backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            opt.step()
            sched.step()
            for k, v in losses.items():
                totals[k] += v.item()
        n = (len(train) + args.bs - 1) // args.bs
        msg = " ".join(f"{k}={v / n:.3f}" for k, v in totals.items())
        if epoch % 5 == 4 or epoch == args.epochs - 1:
            print(f"epoch {epoch + 1} {msg} test={json.dumps(evaluate(head, test, args.device))}", flush=True)
        else:
            print(f"epoch {epoch + 1} {msg}", flush=True)
    result = {"train": evaluate(head, train[:500], args.device), "test": evaluate(head, test, args.device)}
    head = head.cpu()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": head.state_dict(), "config": head.config.__dict__}, args.out)
    Path(args.out).with_suffix(".json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
