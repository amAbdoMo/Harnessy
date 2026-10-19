from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from deepseek_harness import DeepSeekHarness


@pytest.fixture
def directory_runtime(tmp_path: Path) -> Path:
    script = tmp_path / "directory_runtime.py"
    script.write_text(
        """
import json
import os
import sys
from pathlib import Path

origin = str(Path.cwd())
directories = {}
for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get("method")
    params = frame.get("params") or {}
    if method == "initialize":
        origin = params["cwd"]
        result = {"serverInfo": {"name": "directory-runtime", "version": "1"}}
    elif method in ("session/working-directory/get", "session/working-directory/set"):
        session_id = params["sessionId"]
        current = directories.get(session_id, origin)
        if method.endswith("/set"):
            current = str((Path(current) / params["path"]).resolve())
            directories[session_id] = current
        result = json.loads(os.environ["DIRECTORY_REPLY"]) if "DIRECTORY_REPLY" in os.environ else {"cwd": current}
    elif method == "shutdown":
        result = {}
    else:
        raise RuntimeError("unexpected method: " + str(method))
    print(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result}), flush=True)
    if method == "shutdown":
        break
""",
        encoding="utf-8",
    )
    return script


def test_session_directory_wire_keeps_sessions_independent(directory_runtime: Path, tmp_path: Path) -> None:
    origin = tmp_path.resolve()
    with DeepSeekHarness(
        cwd=str(origin),
        dsh_home=str(tmp_path / "home"),
        _launch_args=(sys.executable, str(directory_runtime)),
    ) as harness:
        first = harness.start_session("first")
        second = harness.start_session("second")
        assert first.get_working_directory() == str(origin)
        assert first.set_working_directory("selected") == str(origin / "selected")
        assert second.get_working_directory() == str(origin)
        assert harness.client.get_working_directory(first.id) == str(origin / "selected")
        assert first.set_working_directory("..") == str(origin)


@pytest.mark.parametrize("response", [{}, {"cwd": None}, {"cwd": 12}, {"cwd": ""}])
def test_invalid_directory_wire_response_is_rejected(
    directory_runtime: Path, tmp_path: Path, response: dict[str, object]
) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path),
        dsh_home=str(tmp_path / "home"),
        env={"DIRECTORY_REPLY": json.dumps(response)},
        _launch_args=(sys.executable, str(directory_runtime)),
    ) as harness:
        with pytest.raises(ValidationError):
            harness.start_session("invalid").get_working_directory()


def test_directory_expectations_match_the_recorded_sdk_event_projection() -> None:
    """Keep both SDK fixture sources aligned; this does not qualify Python runtime I/O."""
    root = Path(__file__).resolve().parents[3]
    recording = root / "snapshots" / "sdk" / "directory-change" / "notifications.expected.jsonl"
    frames = [json.loads(line) for line in recording.read_text(encoding="utf-8").splitlines()]
    events = [frame["params"]["event"] for frame in frames if frame["method"] == "session.event"]
    selected = []
    for event in events:
        source = event.get("data", {}).get("source", {})
        if event["type"] == "working-directory/change" or (
            event["type"] == "user/message" and source.get("kind") in ("working-directory", "runtime-context")
        ):
            selected.append({"type": event["type"], "data": event["data"]})
    expected = Path(__file__).parent / "expected" / "working-directory-events.json"
    assert selected == json.loads(expected.read_text(encoding="utf-8"))
