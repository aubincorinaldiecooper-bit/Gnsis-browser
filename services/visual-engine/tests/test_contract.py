"""Decision contract, label/decoder consistency, and head training behaviour."""

import pytest
import torch

from gnsis_visual.batching import HEAD_INPUTS, collate
from gnsis_visual.decode import decode
from gnsis_visual.head import HeadConfig, JEVDecisionHead, decision_loss
from gnsis_visual.labels import action_label, target_labels
from gnsis_visual.prompt import ValueCandidate
from gnsis_visual.schema import ACTIONS, Decision, DecisionError, Target, decision_from_json, validate_decision
from gnsis_visual.tasks.harness import hit

VIEWPORT = (1280, 800)
GRID = (13, 20)


@pytest.mark.parametrize(
    "decision",
    [
        Decision("click", 0.9),
        Decision("click", 0.9, Target(1280, 10)),
        Decision("type", 0.9, Target(10, 10)),
        Decision("navigate", 0.9, url="javascript:alert(1)"),
        Decision("scroll", 0.9, direction="left"),
        Decision("wait", 0.9, Target(10, 10)),
        Decision("click", 1.5, Target(10, 10)),
    ],
)
def test_actuator_never_receives_invalid_decisions(decision):
    with pytest.raises(DecisionError):
        validate_decision(decision, VIEWPORT)


def test_unknown_action_from_json_is_rejected():
    with pytest.raises(DecisionError):
        validate_decision(decision_from_json({"action": "eval", "confidence": 1}), VIEWPORT)


def test_valid_decision_round_trips_through_json():
    d = Decision("type", 0.97, Target(742, 311), text="alice@example.com")
    back = validate_decision(decision_from_json(d.to_json()), VIEWPORT)
    assert back.target == d.target and back.text == d.text and back.action == "type"


def _logits_for(action: str, cell: int, offset: torch.Tensor, n_values: int) -> dict[str, torch.Tensor]:
    n = GRID[0] * GRID[1]
    out = {
        "action": torch.full((1, len(ACTIONS)), -10.0),
        "value": torch.zeros(1, n_values),
        "target": torch.full((1, n), -10.0),
        "offset": torch.zeros(1, n, 2),
    }
    out["action"][0, action_label(action)] = 10.0
    out["target"][0, cell] = 10.0
    out["offset"][0] = offset
    return out


@pytest.mark.parametrize("box", [(700, 290, 90, 40), (5, 5, 40, 22), (1180, 760, 90, 36), (400, 380, 16, 16)])
def test_decoded_point_lands_in_box_given_oracle_labels(box):
    """A head that predicts the labelled cell and offset must decode to a point inside the box."""
    pos, offset = target_labels(box, GRID, VIEWPORT)
    cell = int(pos.nonzero()[0])
    d = decode(_logits_for("click", cell, offset, 1), [ValueCandidate("none", "")], GRID, VIEWPORT)
    assert d.target is not None and hit((d.target.x, d.target.y), box)
    validate_decision(d, VIEWPORT)


def test_decoder_masks_actions_without_required_argument():
    out = _logits_for("type", 0, torch.zeros(GRID[0] * GRID[1], 2), 1)
    out["action"][0, action_label("wait")] = 5.0
    d = decode(out, [ValueCandidate("none", "")], GRID, VIEWPORT)
    assert d.action == "wait"


def _record(action: str, box, n_values: int = 3) -> dict:
    layers, hidden, n = 2, 64, GRID[0] * GRID[1]
    pos, off = target_labels(box, GRID, VIEWPORT)
    return {
        "queries": torch.randn(layers, 3, hidden),
        "actions": torch.randn(layers, len(ACTIONS), hidden),
        "values": torch.randn(layers, n_values, hidden),
        "visual": torch.randn(layers, n, hidden),
        "visual_embeds": torch.randn(n, hidden),
        "grid": GRID,
        "motion": 0.0,
        "action": action_label(action),
        "value": 0,
        "target_pos": pos,
        "target_offset": off,
    }


def test_head_learns_to_point_at_target_cell():
    torch.manual_seed(0)
    records = [_record("click", (700, 290, 90, 40)), _record("done", None, n_values=2)]
    head = JEVDecisionHead(HeadConfig(hidden_size=64, n_layers=2, proj=32))
    opt = torch.optim.Adam(head.parameters(), lr=3e-3)
    batch = collate(records)
    for _ in range(150):
        losses = decision_loss(head(**{k: batch[k] for k in HEAD_INPUTS}), batch)
        opt.zero_grad()
        losses["total"].backward()
        opt.step()
    assert torch.isfinite(losses["total"])
    head.eval()
    with torch.no_grad():
        out = head(**{k: collate([records[0]])[k] for k in HEAD_INPUTS})
    d = decode(out, [ValueCandidate("none", "")] * 3, GRID, VIEWPORT)
    assert d.action == "click" and hit((d.target.x, d.target.y), (700, 290, 90, 40))
