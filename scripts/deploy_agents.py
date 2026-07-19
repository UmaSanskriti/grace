#!/usr/bin/env python
"""Manage Grace's ElevenLabs agent configuration in git.

Two sources of truth, one per concern:

  prompts/{type}_agent.md   prose  — `## First message` + `## System prompt`
  agents/{type}.json        config — the full conversation_config (llm, voice,
                                      temperature, asr, turn, ... everything
                                      EXCEPT the prompt text + first message)

Workflow:

  1. `--pull` downloads each live agent's conversation_config into agents/{type}.json
     (stripping the prompt text + first_message, which live in prompts/*.md).
     Run once to bootstrap, or any time to re-sync from the dashboard.
  2. Edit agents/{type}.json (voice, llm, temperature, ...) and/or prompts/*.md.
  3. `deploy` merges the prompt back in, shows a diff of what would change on the
     live agent, asks for confirmation, then PATCHes.

Usage:
    uv run python scripts/deploy_agents.py --pull            # bootstrap / re-sync from live
    uv run python scripts/deploy_agents.py --dry-run         # show diff, change nothing
    uv run python scripts/deploy_agents.py                   # deploy all (asks per agent)
    uv run python scripts/deploy_agents.py --agent quote     # one agent
    uv run python scripts/deploy_agents.py --yes             # skip the confirmation prompt

Agent ids come from .env (ELEVENLABS_{INTAKE,QUOTE,NEGO}_AGENT_ID); unset agents
are skipped. platform_settings (widget, data-collection, evaluation) is NOT managed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from app.config import settings  # noqa: E402

API_BASE = "https://api.elevenlabs.io"

# agent_type -> (prompt markdown file, config json file, settings attr for the id)
AGENTS: dict[str, tuple[str, str, str]] = {
    "intake": ("prompts/intake_agent.md", "agents/intake.json", "elevenlabs_intake_agent_id"),
    "quote": ("prompts/quote_agent.md", "agents/quote.json", "elevenlabs_quote_agent_id"),
    "nego": ("prompts/negotiation_agent.md", "agents/nego.json", "elevenlabs_nego_agent_id"),
}

_HEADING = re.compile(r"^##\s+(.*?)\s*$")
_DYN_VAR = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


class DeployError(RuntimeError):
    pass


# --- prompt parsing ---------------------------------------------------------

def parse_prompt_file(path: Path) -> tuple[str, str]:
    """Return (first_message, system_prompt) from a prompt markdown file."""
    if not path.exists():
        raise DeployError(f"prompt file not found: {path}")
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in path.read_text().splitlines():
        m = _HEADING.match(line)
        if m:
            current = m.group(1).strip().lower()
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(line)

    def section(name: str) -> str:
        if name not in sections:
            raise DeployError(f"{path}: missing '## {name.title()}' section")
        return "\n".join(sections[name]).strip()

    first_message = section("first message")
    system_prompt = section("system prompt")
    if not first_message or not system_prompt:
        raise DeployError(f"{path}: first message / system prompt section is empty")
    return first_message, system_prompt


def detect_dynamic_vars(*texts: str) -> list[str]:
    found: list[str] = []
    for text in texts:
        for name in _DYN_VAR.findall(text):
            if name.startswith("system__") or name in found:
                continue
            found.append(name)
    return found


# --- ElevenLabs API ---------------------------------------------------------

def _headers() -> dict[str, str]:
    if not settings.elevenlabs_api_key:
        raise DeployError("ELEVENLABS_API_KEY is not set")
    return {"xi-api-key": settings.elevenlabs_api_key, "Content-Type": "application/json"}


def get_agent(agent_id: str) -> dict:
    r = httpx.get(f"{API_BASE}/v1/convai/agents/{agent_id}", headers=_headers(), timeout=30)
    if r.status_code >= 300:
        raise DeployError(f"GET agent {agent_id} failed [{r.status_code}]: {r.text}")
    return r.json()


def patch_agent(agent_id: str, conversation_config: dict) -> dict:
    r = httpx.patch(
        f"{API_BASE}/v1/convai/agents/{agent_id}",
        headers=_headers(),
        json={"conversation_config": conversation_config},
        timeout=30,
    )
    if r.status_code >= 300:
        raise DeployError(f"PATCH agent {agent_id} failed [{r.status_code}]: {r.text}")
    return r.json()


# --- config build / strip ---------------------------------------------------

def strip_managed_text(conversation_config: dict) -> dict:
    """Remove prompt text + first_message (owned by prompts/*.md) from a config."""
    cc = json.loads(json.dumps(conversation_config))  # deep copy
    agent = cc.get("agent") or {}
    agent.pop("first_message", None)
    if isinstance(agent.get("prompt"), dict):
        agent["prompt"].pop("prompt", None)
    return cc


def build_desired_config(config_path: Path, prompt_path: Path) -> dict:
    """Load the mirrored config and inject prompt text + first message + vars."""
    if not config_path.exists():
        raise DeployError(
            f"{config_path} not found — run `--pull` first to bootstrap it from the live agent"
        )
    cc = json.loads(config_path.read_text())
    first_message, system_prompt = parse_prompt_file(prompt_path)

    agent = cc.setdefault("agent", {})
    agent["first_message"] = first_message
    prompt = agent.setdefault("prompt", {})
    prompt["prompt"] = system_prompt

    # Ensure every {{var}} used in the prose has a placeholder (default "" unless
    # the config file already set a value).
    placeholders = agent.setdefault("dynamic_variables", {}).setdefault(
        "dynamic_variable_placeholders", {}
    )
    for var in detect_dynamic_vars(first_message, system_prompt):
        placeholders.setdefault(var, "")
    return cc


# --- deep diff --------------------------------------------------------------

def _eq(a: object, b: object) -> bool:
    # Strings compare stripped so trailing-whitespace noise (ElevenLabs appends a
    # newline to first_message) isn't reported as a change.
    if isinstance(a, str) and isinstance(b, str):
        return a.strip() == b.strip()
    return a == b


def deep_diff(old: object, new: object, path: str = "") -> list[tuple[str, str, object, object]]:
    """Return (op, path, old, new) leaf differences. op in changed/added/removed."""
    diffs: list[tuple[str, str, object, object]] = []
    if isinstance(old, dict) and isinstance(new, dict):
        for key in old.keys() | new.keys():
            sub = f"{path}.{key}" if path else key
            if key not in new:
                diffs.append(("removed", sub, old[key], None))
            elif key not in old:
                diffs.append(("added", sub, None, new[key]))
            else:
                diffs.extend(deep_diff(old[key], new[key], sub))
    elif not _eq(old, new):
        diffs.append(("changed", path, old, new))
    return diffs


def _fmt(v: object, n: int = 100) -> str:
    s = json.dumps(v) if not isinstance(v, str) else v
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[:n] + "…"


def print_diff(agent_type: str, diffs: list[tuple[str, str, object, object]]) -> None:
    if not diffs:
        print(f"  [{agent_type}] no changes — live config already matches git")
        return
    print(f"  [{agent_type}] {len(diffs)} change(s):")
    sym = {"changed": "~", "added": "+", "removed": "-"}
    for op, path, old, new in sorted(diffs, key=lambda d: d[1]):
        print(f"    {sym[op]} {path}")
        if op != "added":
            print(f"        - {_fmt(old)}")
        if op != "removed":
            print(f"        + {_fmt(new)}")


# --- commands ---------------------------------------------------------------

def _resolve(agent_type: str) -> tuple[str, Path, Path]:
    prompt_rel, config_rel, id_attr = AGENTS[agent_type]
    agent_id = getattr(settings, id_attr)
    if not agent_id:
        raise DeployError(f"{id_attr.upper()} not set in .env")
    return agent_id, REPO_ROOT / prompt_rel, REPO_ROOT / config_rel


def pull_one(agent_type: str) -> None:
    try:
        agent_id, _prompt_path, config_path = _resolve(agent_type)
    except DeployError as e:
        print(f"[{agent_type}] SKIP — {e}")
        return
    cc = get_agent(agent_id).get("conversation_config", {})
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(strip_managed_text(cc), indent=2) + "\n")
    print(f"[{agent_type}] pulled -> {config_path.relative_to(REPO_ROOT)}")


def deploy_one(agent_type: str, *, dry_run: bool, assume_yes: bool) -> None:
    try:
        agent_id, prompt_path, config_path = _resolve(agent_type)
    except DeployError as e:
        print(f"[{agent_type}] SKIP — {e}")
        return

    desired = build_desired_config(config_path, prompt_path)
    live = get_agent(agent_id).get("conversation_config", {})
    diffs = deep_diff(live, desired)

    print_diff(agent_type, diffs)
    if not diffs or dry_run:
        return

    if not assume_yes:
        try:
            resp = input(f"  Apply {len(diffs)} change(s) to [{agent_type}] {agent_id}? [y/N] ")
        except EOFError:
            resp = ""
        if resp.strip().lower() not in ("y", "yes"):
            print(f"  [{agent_type}] skipped")
            return

    patch_agent(agent_id, desired)
    print(f"  [{agent_type}] ✔ deployed")


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage ElevenLabs agent config in git.")
    parser.add_argument("--agent", choices=[*AGENTS, "all"], default="all")
    parser.add_argument("--pull", action="store_true", help="download live config into agents/*.json")
    parser.add_argument("--dry-run", action="store_true", help="show diff, change nothing")
    parser.add_argument("--yes", "-y", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()

    targets = list(AGENTS) if args.agent == "all" else [args.agent]
    try:
        if args.pull:
            for t in targets:
                pull_one(t)
            return 0
        if args.dry_run:
            print("DRY RUN — no changes will be made\n")
        for t in targets:
            deploy_one(t, dry_run=args.dry_run, assume_yes=args.yes)
            print()
    except DeployError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
