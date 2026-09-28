# Panoptic backend provenance

Panoptic is the GNSIS Browser product/runtime boundary. Its current temporal
vision backend is derived from the VideoChat3 streaming implementation used in
Clipit and from the upstream MCG-NJU VideoChat3 proactive streaming code.

This file exists for engineering traceability and license compliance. Do not
leak the backend model name into Panoptic's public protocol, extension UI, or
product copy.

Current checkpoint:
- repository/model: `MCG-NJU/VideoChat3-4B`
- pinned revision default: `37fa901`
- official streaming helper loaded from the checkpoint:
  `inference_fast_vc3.py`

Ported behaviors:
- stateful StreamingSession
- causal frame-by-frame temporal accumulation
- native Silence / Standby / Response states
- adaptive higher-resolution next-frame inspection after Standby
- browser timestamp preservation
- long-running stream separated from context-window truncation

Before redistribution, keep the upstream model/repository license notices that
apply to the checkpoint and streaming helper.
