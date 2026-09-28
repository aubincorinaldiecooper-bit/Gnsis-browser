"""Evaluate grounding and execution from actual GNSIS runs.

Input is newline-delimited JSON recorded by the runtime/browser execution seam.
There is no synthetic episode regeneration and no dependency on old checkpoints.

When executor-side target geometry is available, the report compares all recorded
candidate variants (raw, raw+r24, OCR, OCR+r24). Separately, it reports the real
outcome of the variant that was actually executed and verified on the live run.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gnsis_visual.real_runs import VARIANTS, RealRunCase, geometric_score


def ratio(ok: int, total: int) -> dict[str, int | float | None]:
    return {
        "ok": ok,
        "total": total,
        "rate": round(ok / total, 4) if total else None,
    }


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(q * (len(ordered) - 1)))
    return round(ordered[idx], 2)


def evaluate(cases: list[RealRunCase]) -> dict[str, Any]:
    geometry: dict[str, dict[str, list[int]]] = defaultdict(
        lambda: defaultdict(lambda: [0, 0])
    )
    availability: dict[str, int] = defaultdict(int)
    abstentions: dict[str, int] = defaultdict(int)

    verified_by_variant: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    actuator_by_variant: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    corrections_by_variant: dict[str, int] = defaultdict(int)
    latency_by_variant: dict[str, list[float]] = defaultdict(list)

    contexts: dict[str, int] = defaultdict(int)
    actions: dict[str, int] = defaultdict(int)

    for case in cases:
        contexts[case.context] += 1
        actions[case.action] += 1

        for variant in VARIANTS:
            candidate = case.candidates[variant]
            if candidate.status != "unavailable":
                availability[variant] += 1
            if candidate.status == "abstained":
                abstentions[variant] += 1

            score = geometric_score(case, variant)
            if score is not None:
                for key in ("all", case.action):
                    geometry[variant][key][0] += int(score)
                    geometry[variant][key][1] += 1

        executed = case.outcome.executed_variant
        if executed is None:
            continue
        if case.outcome.actuator_success is not None:
            actuator_by_variant[executed][0] += int(case.outcome.actuator_success)
            actuator_by_variant[executed][1] += 1
        if case.outcome.verified_success is not None:
            verified_by_variant[executed][0] += int(case.outcome.verified_success)
            verified_by_variant[executed][1] += 1
        if case.outcome.user_corrected:
            corrections_by_variant[executed] += 1
        if case.outcome.latency_ms is not None:
            latency_by_variant[executed].append(case.outcome.latency_ms)

    return {
        "schema_version": 1,
        "cases": len(cases),
        "time_range_ms": {
            "first": min((c.captured_at_ms for c in cases), default=None),
            "last": max((c.captured_at_ms for c in cases), default=None),
        },
        "contexts": dict(sorted(contexts.items())),
        "actions": dict(sorted(actions.items())),
        "candidate_coverage": {
            variant: ratio(availability[variant], len(cases)) for variant in VARIANTS
        },
        "geometry_accuracy": {
            variant: {
                action: ratio(values[0], values[1])
                for action, values in sorted(geometry[variant].items())
            }
            for variant in VARIANTS
        },
        "abstentions": {variant: abstentions[variant] for variant in VARIANTS},
        "live_execution": {
            variant: {
                "actuator_success": ratio(*actuator_by_variant[variant]),
                "verified_success": ratio(*verified_by_variant[variant]),
                "user_corrections": corrections_by_variant[variant],
                "latency_ms_p50": (
                    round(median(latency_by_variant[variant]), 2)
                    if latency_by_variant[variant]
                    else None
                ),
                "latency_ms_p95": percentile(latency_by_variant[variant], 0.95),
            }
            for variant in VARIANTS
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", required=True, help="JSONL of recorded real GNSIS cases")
    parser.add_argument("--out")
    parser.add_argument(
        "--context",
        choices=("browser", "desktop"),
        help="optionally evaluate only one execution context",
    )
    parser.add_argument(
        "--since-ms",
        type=int,
        default=0,
        help="only include runs captured at or after this timestamp",
    )
    parser.add_argument(
        "--latest",
        type=int,
        default=0,
        help="evaluate only the newest N matching cases",
    )
    args = parser.parse_args()

    cases: list[RealRunCase] = []
    for line_no, line in enumerate(Path(args.runs).read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            case = RealRunCase.from_json(json.loads(line))
        except Exception as exc:
            raise SystemExit(f"{args.runs}:{line_no}: {exc}") from exc
        if args.context and case.context != args.context:
            continue
        if case.captured_at_ms < args.since_ms:
            continue
        cases.append(case)

    cases.sort(key=lambda case: (case.captured_at_ms, case.case_id))
    if args.latest > 0:
        cases = cases[-args.latest :]

    report = evaluate(cases)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rendered + "\n")
    print(rendered)


if __name__ == "__main__":
    main()
