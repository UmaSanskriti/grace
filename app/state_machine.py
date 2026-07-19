"""Case lifecycle state machine.

Status flow (from v0-instruction.md §5.1):
    awaiting_intake -> intake_done -> researching -> calling_for_quotes
    -> quotes_collected -> strategy_ready -> negotiating -> done

Slice 1 uses storage.set_status directly. This module will own the transition
rules + next-action dispatch (kick research, call next home, generate report)
in Slice 2+.
"""

from __future__ import annotations

STATUSES = [
    "awaiting_intake",
    "intake_done",
    "researching",
    "calling_for_quotes",
    "quotes_collected",
    "strategy_ready",
    "negotiating",
    "done",
]

# TODO(Slice 2+): allowed-transition map + advance(case_id) dispatcher that runs
# the next pipeline step and is idempotent under webhook retries.
