# Visual Decision Engine — Game Plan

This file is the working plan for `services/visual-engine`. It is written for
humans first (plain language) and for coding agents second (rules at the end).

## 1. The goal in one sentence

A **small "System 1" vision model that runs on your own computer**, watches the
live browser, and instantly picks the next move — _click here, type this,
scroll, wait, done_ — without writing any sentences. Bigger "System 2" agents
(Claude, Codex, local agents) hand it tasks through a simple API and let it do
the clicking.

```
Claude / Codex / local agent        <- System 2: thinks, plans, decides the goal
            |
     Browser Visual API             <- simple local service (HTTP / WebSocket / MCP)
            |
  visual decision engine            <- System 1: looks at the screen, picks the move
            |
         actuator                   <- turns the move into real mouse/keyboard input
            |
         browser  ---- live video of the page ----> back to the engine (loop)
```

## 2. What "System 1" means here

| System 1 (this project)               | System 2 (Claude, Codex, ...)        |
| ------------------------------------- | ------------------------------------ |
| Fast, reflex-like, one move at a time | Slow, deliberate, long-horizon plans |
| Small, runs locally                   | Large, usually cloud                 |
| Only sees pixels of the rendered page | Reads text, reasons, writes code     |
| Answers with a structured move (JSON) | Answers with language                |

System 1 never reads the page's HTML/DOM. It only sees what a person would see.

## 3. What a "move" looks like

Every decision is a small JSON object, never prose:

```json
{ "action": "click", "target": { "x": 742, "y": 311 }, "confidence": 0.97 }
{ "action": "type", "target": { "x": 180, "y": 245 }, "text": "alice@example.com", "confidence": 0.93 }
{ "action": "scroll", "direction": "down", "confidence": 0.88 }
{ "action": "navigate", "url": "https://example.com/pricing", "confidence": 0.95 }
{ "action": "back" | "wait" | "done" | "recover", "confidence": 0.9 }
```

Actions: `click`, `type`, `scroll`, `navigate`, `back`, `wait`, `done`, `recover`.
The engine can only ever output one of these, with coordinates inside the
visible page. Anything invalid is rejected before it reaches the browser.

## 4. How it works (the pieces)

1. **Live page video (persistent stream).** Chromium sends a continuous stream of
   rendered frames (CDP screencast). We keep a short, bounded history and measure
   motion, so the engine knows when the page is still loading or has settled.
   No separate screenshot path.
2. **Vision backbone: MiniCPM-V 4.6** (~1.3B parameters, open weights). Used
   _frozen_, as "eyes": it turns the frame plus the goal into internal features
   in one pass. We never ask it to write text.
3. **JEV-style decision head** (idea from Vision-JEV). A tiny trained layer on top
   of the backbone that _points_ instead of writing:
    - points at one of the 8 actions,
    - points at one screen region (the target) and nudges it to the exact spot,
    - points at one argument (text to type, URL, or scroll direction) taken from
      the goal.
      Confidence is how sure each pointer is.
4. **Actuator.** Turns the move into real mouse clicks, keystrokes, scrolls or
   navigation, then the loop repeats on the new frames.
5. **Browser Visual API.** A local daemon with persistent sessions
   (open session -> give goal -> get decision / step / run -> close), over HTTP,
   WebSocket and MCP, so any agent can use it. The API does not expose which
   model is inside, so the model can be swapped later.

## 5. How we find click targets without the DOM (two stages)

The backbone splits the screen into a grid of visual tokens (13 x 20 at our
default setting; each cell covers about 64 x 61 page pixels). Finding a target
is split into two jobs:

1. **Semantic target (the head).** Which control is meant? The head scores every
   cell against the goal and picks the most likely region. This is the "System 1
   intelligence".
2. **Precise grounding (a separate, small layer).** Where exactly is that
   control? It turns the chosen region into an exact clickable rectangle, using
   only rendered pixels:

```
OCR text boxes (RapidOCR, word level)
        +
visual control proposals (OmniParser icon_detect_v3, MIT)
        +
label -> control association ("Email" label -> nearby input rectangle)
        |
precise actionable region  ->  click at its centre
```

The API returns structured actions with exact pixel targets, never grid cells.

## 6. Where we stand

| Piece                                                                  | Status                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Live rendered stream (CDP screencast, motion, settle)                  | Done, tested                                                        |
| Actuator (click / type / scroll / navigate / back / wait) + validation | Done, tested                                                        |
| Practice + held-out test websites (unseen labels/values)               | Done: 3,673 train, 824 unseen-name test, 840 known-name test states |
| Vision backbone (MiniCPM-V 4.6, frozen, no text generation)            | Done, CPU + GPU measured                                            |
| JEV decision head (action / value / target pointers)                   | Trained (30 epochs, 2.4M params)                                    |
| Browser Visual API (HTTP + WebSocket + MCP, persistent sessions)       | Done, tested with a real browser                                    |
| OCR target snapping (first version)                                    | Built, first offline results                                        |
| Visual control proposals + label->input association                    | In progress                                                         |
| Full grounding evaluation (metrics in section 9)                       | Next                                                                |
| End-to-end task success with the trained head                          | Not measured yet                                                    |
| PR                                                                     | Not opened yet                                                      |

## 7. Measured numbers

### Speed and memory (native weights, no quantization, 1280x800 page)

| Hardware                      | Time per decision (p50 / p95) | Memory     |
| ----------------------------- | ----------------------------- | ---------- |
| CPU only (8-core Xeon), 896px | ~2.7 s                        | 6.2 GB RAM |
| CPU only, 672px               | ~1.4 s                        | 6.2 GB RAM |
| NVIDIA L4 GPU, 896px, bf16    | 0.37 s / 0.39 s               | 2.8 GB GPU |
| NVIDIA L4 GPU, 672px, bf16    | 0.29 s / 0.29 s               | 2.7 GB GPU |

- The decision head itself: ~2 ms. Nearly all time is the backbone.
- Unchanged frames reuse cached visual features (the vision step is skipped).
- OCR (RapidOCR, CPU, single process): ~1.4-1.8 s full frame, ~0.8-1.0 s on a
  small crop. Not optimised yet (GPU runtime / smaller input still to try).

### Accuracy on held-out websites with unseen button names (824 screens)

| Metric                                         | Result    |
| ---------------------------------------------- | --------- |
| Picks the right action                         | **92.0%** |
| Picks the right typed value / URL / direction  | 92.9%     |
| Click lands on the right element (all targets) | **59.2%** |
| - buttons / links                              | 59.9%     |
| - text fields                                  | 51.3%     |
| - pop-up dismiss controls                      | 67.2%     |
| Whole decision fully correct                   | 80.6%     |

Same metrics on the practice screens: action 100%, target 99%. The head learned
the practice button names instead of learning to read new ones.

### First OCR snapping result (unseen names, 278 target screens)

| Target type      | Raw head point | With OCR snap                                      |
| ---------------- | -------------- | -------------------------------------------------- |
| Buttons / links  | 65.3%          | **79.2%**                                          |
| Dismiss controls | 74.1%          | 75.9%                                              |
| Text fields      | 52.6%          | 27.6% if snapped to the label -> kept on raw point |
| All              | 63.7%          | **71.2%**                                          |

## 8. Bottlenecks (in order of impact)

1. **Precise grounding on unseen names.** Choosing the action is solved (92%);
   landing on the exact control is not (59%). Clear train/test gap = memorisation.
2. **Coarse grid.** One cell is ~64 x 61 px; many targets are smaller (e.g. a
   42 x 16 px menu link), so a near-miss lands next to the control.
3. **OCR merges neighbouring links** into one line ("Webinars Library Comment"),
   so the snapped point lands in the middle of the group. Fix: word-level boxes.
4. **Text fields.** The visible label often sits outside the input (above or to
   the left), so snapping to the label misses. Needs label -> input association.
5. **Icon-only controls** (x, menus, back arrows) have no readable text. Needs
   visual control proposals. The current test sites contain few icons, so the
   test suite also needs more of them.
6. **OCR latency on CPU** (~1 s) is larger than the GPU decision itself.
7. **End-to-end task success** with the trained head is not measured yet.

## 9. Plan: grounding experiment (current focus)

Decision rule: **no bigger model, no more button-name training, no policy
redesign until this experiment is complete.** If grounding raises unseen-target
accuracy substantially while action accuracy stays ~92%, the decision model is
treated as sufficient and effort moves to the grounding layer.

Steps:

1. Word-level OCR spans (fixes merged links).
2. Visual control proposals from OmniParser `icon_detect_v3` (MIT, ~280 MB,
   TorchScript, torch-only at runtime).
3. Label -> control association for text fields (label above/left -> nearest
   input proposal; placeholder text inside the input).
4. Icon / dismiss path: proposals near the head's region when no text matches.
5. Measure, separately for **known names / unseen names / text fields /
   dismiss controls & icons**:
    - semantic target accuracy (did the head pick the right control?)
    - raw coordinate accuracy (did the original point land inside it?)
    - OCR-snapped accuracy
    - full grounding accuracy (OCR + proposals + association)
    - OCR coverage (is the control represented by readable text?)
    - pixel miss distance of raw misses (median / p90)
    - **headline: how much of the unseen-vs-known gap disappears with grounding**
6. Grounding latency (CPU and GPU) and memory.
7. End-to-end task success on held-out sites with grounding on.

## 10. Parked options (only after the grounding experiment)

- **GUI-Actor-2B** (Microsoft, MIT, 2.2B): same point-don't-write design,
  86.5% on the ScreenSpot grounding benchmark. Candidate backbone swap.
- **Florence-2-base** (Microsoft, MIT, 0.23B): tiny grounding model.
- Zoom-in second look (coarse-to-fine crop), LoRA adapters, confidence gating,
  check-after-click recovery, more varied practice sites.
- **Voice layer (dormant, optional):** faster-whisper large-v3-turbo (MIT) for
  speech -> goal text, CosyVoice 3 0.5B (Apache-2.0) for spoken status. Sits
  outside System 1; the visual decision path does not change.

## 11. What would make us say "this doesn't work"

- Grounding does not close most of the unseen-name gap.
- The engine can't tell "loading" from "done" using the stream.
- Decisions plus grounding stay too slow for a responsive loop even on a GPU.

Each of these is measured, not assumed.

## Rules for coding agents working here

- Perception input is the rendered stream only. Never feed DOM trees, HTML,
  selectors or element indexes to the engine. Page ground truth
  (`gnsis_visual/tasks/runtime.js`, `harness.py`) is for labels and scoring only.
- No screenshot capture path; frames come from `ScreencastStream`.
- The decision path never calls `generate`; output is produced by pointer heads.
- Every decision passes `validate_decision` before the actuator runs it.
- Keep the public API model-independent (`schema.py` is the contract).
- Measure native first; optimise only with numbers that justify it.
- All code and comments in English.


## Real-run benchmark direction

The primary product benchmark now comes from **actual GNSIS executions**, not a permanently frozen synthetic held-out set.

Real runs should preserve the pre-action frame, goal, raw visual target, optional OCR/r24 candidate probes, executor-side target geometry when available, actual actuator result, post-action verification, latency, and user correction/recovery signals. The evaluator is `scripts/eval_real_runs.py`; the schema and rolling-cohort policy are documented in `REAL_RUN_BENCHMARK.md`.

Recent unseen real runs may be used as the current evaluation cohort and can later retire into training once newer runs replace them. Synthetic tasks remain useful for deterministic implementation tests and controlled experiments, but they are not the headline product benchmark.

The rendered-pixel perception boundary does not change: executor geometry is evaluation/training metadata captured only after System 1 has already produced its target.
