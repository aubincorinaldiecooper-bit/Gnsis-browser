from gnsis_visual.real_runs import RealRunCase, geometric_score


def sample_case() -> dict:
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "case_id": "case-1",
        "captured_at_ms": 1000,
        "context": "browser",
        "frame_id": "frame-7",
        "frame_path": "frames/frame-7.jpg",
        "goal": "Click Continue",
        "action": "click",
        "viewport": {"width": 1280, "height": 800},
        "candidates": {
            "raw": {"point": {"x": 90, "y": 90}},
            "raw+r24": {"point": {"x": 110, "y": 110}, "method": "nearby"},
            "ocr": {"point": {"x": 115, "y": 115}},
            "ocr+r24": {"point": {"x": 120, "y": 120}, "method": "exact-hit"},
        },
        "target_box": {"x": 100, "y": 100, "width": 50, "height": 30},
        "execution": {
            "executed_variant": "raw+r24",
            "actuator_success": True,
            "verified_success": True,
            "user_corrected": False,
            "latency_ms": 18.2,
        },
    }


def test_scores_recorded_candidates_against_executor_geometry() -> None:
    case = RealRunCase.from_json(sample_case())
    assert geometric_score(case, "raw") is False
    assert geometric_score(case, "raw+r24") is True
    assert geometric_score(case, "ocr") is True
    assert geometric_score(case, "ocr+r24") is True


def test_geometry_is_optional_for_real_outcome_only_cases() -> None:
    data = sample_case()
    data["target_box"] = None
    case = RealRunCase.from_json(data)
    assert geometric_score(case, "raw+r24") is None
    assert case.outcome.verified_success is True


def test_rejects_points_outside_source_viewport() -> None:
    data = sample_case()
    data["candidates"]["raw"]["point"] = {"x": 1280, "y": 20}
    try:
        RealRunCase.from_json(data)
    except ValueError as exc:
        assert "outside viewport" in str(exc)
    else:
        raise AssertionError("expected invalid point to be rejected")
