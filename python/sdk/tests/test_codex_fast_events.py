from __future__ import annotations

import json
import runpy
import sys
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness, Notification


@pytest.mark.parametrize("event_type", ["llm-pi-ai/fast-mode", "plugin:python-sdk-test/state"])
def test_session_run_retains_ignorable_events_and_forwards_notifications(
    tmp_path: Path,
    event_type: str,
) -> None:
    """Unknown plugin preferences remain available without becoming assistant text."""
    script = tmp_path / "fake_fast_transcript.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"serverInfo": {"name": "fake-transcript"}}}), flush=True)
    elif method == "session/prompt":
        session_id = request["params"]["sessionId"]
        def notify(method, params):
            print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)
        def event(value):
            notify("session.event", {"sessionId": session_id, "event": value})
        event({"type": "agent/inbox/spliced", "seq": 0, "time": 0, "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"messageId": "message-1"}}), flush=True)
        event({"type": sys.argv[1], "seq": 1, "time": 0, "data": {"enabled": True}, "ignorable": True})
        event({"type": sys.argv[1], "seq": 2, "time": 0, "data": {"enabled": False}, "ignorable": True})
        event({"type": "assistant/message", "seq": 3, "time": 0, "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": "FAST_MODE_OK"}]}}})
        event({"type": "turn/end", "seq": 4, "time": 0, "data": {"turn": 1, "reason": {"kind": "completed"}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {}}), flush=True)
        break
""".strip() + "\n",
        encoding="utf-8",
    )

    seen: list[Notification] = []
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script), event_type),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run(
            "exercise the fast preference",
            session_id="main",
            on_notification=seen.append,
        )

    expected_path = Path(__file__).parent / "expected" / "codex-fast-notifications.json"
    expected_notifications = json.loads(expected_path.read_text(encoding="utf-8"))
    if event_type == "plugin:python-sdk-test/state":
        for notification in expected_notifications:
            notification["params"]["event"]["type"] = event_type
    retained_events = [event for event in result.events if event["type"] == event_type]
    assert retained_events == [notification["params"]["event"] for notification in expected_notifications]
    assert retained_events[0]["data"]["enabled"] is True
    assert retained_events[1]["data"]["enabled"] is False
    assert all(event["ignorable"] is True for event in retained_events)
    for notifications in (result.notifications, seen):
        projected = [
            {"method": notification.method, "params": notification.payload}
            for notification in notifications
            if notification.method == "session.event"
            and notification.payload["event"]["type"] == event_type
        ]
        assert projected == expected_notifications
    assert result.final_response == "FAST_MODE_OK"
    assert result.finish_reason == "completed"


ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/cli/lib/bin.js"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh profile runtime")
def test_codex_fast_commands_through_the_real_sdk_profile() -> None:
    """The packaged-runtime owner checks command outcomes, notifications, and persistence."""
    smoke = runpy.run_path(str(ROOT / "scripts/smoke-python-runtime.py"))
    smoke["smoke_sdk_codex_fast_mode"](CLI, False)
