# Panoptic

Panoptic is the live temporal perception layer used by GNSIS Browser.

It is intentionally separate from browser reasoning and execution:

```text
Panoptic -> Laya -> Actuator
```

Panoptic continuously watches the browser viewport and carries causal visual
state forward across frames. Laya receives a bounded current-state summary plus
a closed set of legal actions. The Actuator is Alibaba Page Agent's existing
browser execution machinery, extended with coordinate-based actions for visual
targets.

## Temporal contract

- One stateful temporal session per browser tab.
- Ordered timestamps are preserved across the session.
- Native `silence`, `standby`, and `response` states are preserved.
- `standby` causes the next frame to be examined with a 4x pixel budget.
- Context length and total observed stream length are separate controls.
- The default temporal budget is 4,096 sampled frames and can be configured.
- Panoptic never generates or executes browser actions.
- If Panoptic has not produced a `response`, the agent does not force a Laya
  action from an incomplete visual state.

## Local endpoint

```text
ws://127.0.0.1:8792/v1/panoptic/stream
```

A non-loopback bind requires `GNSIS_PANOPTIC_TOKEN`.

## Run

```bash
pip install -r services/panoptic/requirements.txt
python services/panoptic/panoptic_stream.py
```

See `UPSTREAM.md` for internal model provenance and licensing notes.
