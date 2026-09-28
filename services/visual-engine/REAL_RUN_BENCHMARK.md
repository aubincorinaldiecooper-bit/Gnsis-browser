# GNSIS real-run visual benchmark

This benchmark is built from **actual GNSIS executions**, not a permanently frozen synthetic dataset.

## Learning loop

1. GNSIS sees a real screen frame.
2. System 1 emits a visual action/target.
3. The environment actuator executes the action.
4. GNSIS observes the post-action frames and verification result.
5. The run can become a training example.
6. A recent subset that the next candidate model has not trained on can be used as the current evaluation cohort.
7. After that cohort has served its evaluation purpose, it may retire into training and newer real runs replace it.

There is no permanent old anchor set in this design. Synthetic fixtures remain useful for deterministic code/contract tests, not as the headline product benchmark.

## Perception boundary

The model receives rendered pixels only.

For browser actions, executor-side target geometry may be recorded **after** a visual point already exists. That geometry is evaluation/training metadata and must never be fed back into System-1 perception or target selection.

## JSONL case format

Each line passed to `scripts/eval_real_runs.py` is one real action case:

```json
{
  "schema_version": 1,
  "run_id": "run-123",
  "case_id": "action-7",
  "captured_at_ms": 1790625600000,
  "context": "browser",
  "frame_id": "frame-442",
  "frame_path": "frames/frame-442.jpg",
  "goal": "Click Continue",
  "action": "click",
  "viewport": {"width": 1280, "height": 800},
  "candidates": {
    "raw": {"status": "resolved", "point": {"x": 612, "y": 391}},
    "raw+r24": {
      "status": "resolved",
      "point": {"x": 625, "y": 398},
      "method": "nearby"
    },
    "ocr": {"status": "resolved", "point": {"x": 628, "y": 400}},
    "ocr+r24": {
      "status": "resolved",
      "point": {"x": 628, "y": 400},
      "method": "exact-hit"
    }
  },
  "target_box": {"x": 600, "y": 380, "width": 90, "height": 42},
  "execution": {
    "executed_variant": "raw+r24",
    "actuator_success": true,
    "verified_success": true,
    "user_corrected": false,
    "latency_ms": 21.4
  }
}
```

Candidates that were not probed use `{"status":"unavailable"}`. Resolver abstention uses `{"status":"abstained"}`.

`target_box` is optional because some environments/actions will only have outcome-level supervision. When present, it allows counterfactual geometric comparison across all recorded variants. The actual executed path is scored separately using `verified_success`.

## Run

```bash
cd services/visual-engine

python scripts/eval_real_runs.py \
  --runs /path/to/real-runs.jsonl \
  --context browser \
  --latest 1000 \
  --out /path/to/report.json
```

The report includes:

- candidate coverage;
- raw / raw+r24 / OCR / OCR+r24 geometric accuracy where executor geometry exists;
- resolver abstentions;
- actual actuator success;
- post-action verified success;
- user corrections;
- execution latency;
- action/context mix.

The runtime and browser bridge will be instrumented separately to produce this schema. This PR defines the evaluation contract first so execution logging has a stable target.
