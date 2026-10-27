from __future__ import annotations

import json
from pathlib import Path


def test_ptc_metadata_matches_recorded_sdk_event_projection() -> None:
    """Compare the SDK golden with the immutable input; this does not exercise Python runtime I/O."""
    root = Path(__file__).resolve().parents[3] / "snapshots" / "sdk" / "ptc-turn"
    source = [json.loads(line) for line in (root / "session.v4.jsonl").read_text(encoding="utf-8").splitlines()]
    frames = [json.loads(line) for line in (root / "notifications.current.expected.jsonl").read_text(encoding="utf-8").splitlines()]
    events = [frame["params"]["event"] for frame in frames if frame["method"] == "session.event"]
    def projection(records: list[dict]) -> list[dict]:
        return [{"name": event["data"]["name"], "meta": event["data"]["meta"]}
                for event in records if event["type"] == "tool/ptc-dispatch"]
    expected = [{"name": "bash", "meta": {"cwd": "{{cwd}}"}}] * 2
    assert projection(source) == expected
    assert projection(events) == expected
