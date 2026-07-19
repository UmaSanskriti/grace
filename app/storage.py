"""JSON-file storage under ./data/.

Layout:
    data/
      _index.json                     # conversation_id -> {case_id, agent_type, fh_id}
      <case_id>/
        case.json                     # pipeline state
        user_info.json
        funeral_homes.json
        quotes/<fh_id>.json
        strategy.json
        negotiations/<fh_id>.json
        transcripts/<name>.txt
        raw/<conversation_id>.json    # raw webhook payloads (debugging)
        report.md

Concurrency note: v0 runs calls sequentially, so plain file writes are fine.
The _index is read-modify-written under a process-local lock to survive the
occasional overlapping webhook retry.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_DIR = Path("data")
INDEX_PATH = DATA_DIR / "_index.json"

_index_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --- low-level json helpers -------------------------------------------------

def _read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2))


# --- case directory ---------------------------------------------------------

def case_dir(case_id: str) -> Path:
    return DATA_DIR / case_id


def new_case_id() -> str:
    """case_YYYYMMDD_NNN, sequential within the day."""
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing = [p.name for p in DATA_DIR.glob(f"case_{day}_*") if p.is_dir()]
    n = len(existing) + 1
    return f"case_{day}_{n:03d}"


def create_case(user_phone: str = "", status: str = "awaiting_intake") -> dict:
    case_id = new_case_id()
    case = {
        "case_id": case_id,
        "status": status,
        "created_at": _now_iso(),
        "user_phone": user_phone,
    }
    _write_json(case_dir(case_id) / "case.json", case)
    return case


def read_case(case_id: str) -> dict | None:
    return _read_json(case_dir(case_id) / "case.json")


def set_status(case_id: str, status: str) -> None:
    case = read_case(case_id)
    if case is None:
        raise KeyError(f"unknown case {case_id}")
    case["status"] = status
    case["updated_at"] = _now_iso()
    _write_json(case_dir(case_id) / "case.json", case)


def save_json(case_id: str, relpath: str, obj: Any) -> Path:
    path = case_dir(case_id) / relpath
    _write_json(path, obj)
    return path


def read_json(case_id: str, relpath: str, default: Any = None) -> Any:
    return _read_json(case_dir(case_id) / relpath, default)


def save_transcript(case_id: str, name: str, text: str) -> Path:
    path = case_dir(case_id) / "transcripts" / f"{name}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def save_raw_payload(case_id: str, conversation_id: str, payload: Any) -> Path:
    path = case_dir(case_id) / "raw" / f"{conversation_id}.json"
    _write_json(path, payload)
    return path


def dump_case(case_id: str) -> dict | None:
    """Full case state for GET /cases/{id} — our demo 'UI'."""
    d = case_dir(case_id)
    if not d.exists():
        return None
    out = read_case(case_id) or {"case_id": case_id}
    out["user_info"] = read_json(case_id, "user_info.json")
    out["funeral_homes"] = read_json(case_id, "funeral_homes.json")
    out["strategy"] = read_json(case_id, "strategy.json")
    quotes_dir = d / "quotes"
    out["quotes"] = (
        [_read_json(p) for p in sorted(quotes_dir.glob("*.json"))]
        if quotes_dir.exists()
        else []
    )
    nego_dir = d / "negotiations"
    out["negotiations"] = (
        [_read_json(p) for p in sorted(nego_dir.glob("*.json"))]
        if nego_dir.exists()
        else []
    )
    tdir = d / "transcripts"
    out["transcripts"] = (
        sorted(p.name for p in tdir.glob("*.txt")) if tdir.exists() else []
    )
    return out


# --- conversation_id -> case index -----------------------------------------

def index_conversation(
    conversation_id: str, case_id: str, agent_type: str, fh_id: str | None = None
) -> None:
    with _index_lock:
        idx = _read_json(INDEX_PATH, {}) or {}
        idx[conversation_id] = {
            "case_id": case_id,
            "agent_type": agent_type,
            "fh_id": fh_id,
        }
        _write_json(INDEX_PATH, idx)


def lookup_conversation(conversation_id: str) -> dict | None:
    idx = _read_json(INDEX_PATH, {}) or {}
    return idx.get(conversation_id)


def newest_case_with_status(status: str) -> str | None:
    """Fallback routing for inbound calls we didn't initiate (e.g. intake)."""
    if not DATA_DIR.exists():
        return None
    candidates = []
    for p in DATA_DIR.glob("case_*"):
        if not p.is_dir():
            continue
        case = _read_json(p / "case.json")
        if case and case.get("status") == status:
            candidates.append((case.get("created_at", ""), case["case_id"]))
    if not candidates:
        return None
    return max(candidates)[1]
