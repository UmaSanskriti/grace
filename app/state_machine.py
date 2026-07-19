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

# Off-happy-path statuses (issue #16). A case sitting on one of these has
# STOPPED: no webhook and no cascade will move it on its own, so it needs an
# operator (POST /cases/{id}/advance) or a fix. They are deliberately kept out
# of STATUSES above, which is the linear success flow.
#
# Every entry must also appear in web_api._PROGRESS, or the dashboard pipeline
# nodes go dark for a case in that state and a stopped case reads as merely slow
# — which is the exact failure mode issue #16 is about.
FAILURE_STATUSES = [
    "orphan_webhook",        # webhook we could not route to any case
    "intake_call_failed",    # intake conversation failed or was cut off
    "intake_extract_failed",  # intake transcript would not extract
    "research_failed",       # no funeral homes found
    "quotes_failed",         # every home failed — nothing to negotiate over
]

# TODO(Slice 2+): allowed-transition map + advance(case_id) dispatcher that runs
# the next pipeline step and is idempotent under webhook retries.
# TODO(#16): watchdog for a case with an in-flight call and no webhook —
# reconcile against the ElevenLabs conversation API, then mark failed. Depends
# on #17; deliberately not implemented on this branch.
