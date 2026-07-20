# Grace — AI Funeral Quote & Negotiation Agent

Backend orchestrator for **Grace**, an AI phone agent that collects funeral quotes and negotiates
on a family's behalf. See [`docs/v0-instruction.md`](docs/v0-instruction.md) for the full v0 spec
and [`docs/superpowers/specs/2026-07-18-grace-v0-calling-loop-design.md`](docs/superpowers/specs/2026-07-18-grace-v0-calling-loop-design.md)
for the current build slice.

## Status

**Slice 1 — outbound call → webhook loop.** Place a real outbound call through ElevenLabs and
receive the transcript back via post-call webhook, persisted under `./data/`. Extraction /
research / strategy / report are scaffolded stubs (Slice 2+).

## Requirements

| Tool | Version | Purpose |
|---|---|---|
| [Python](https://www.python.org/) | 3.12+ | runtime (see `requires-python` in `pyproject.toml`) |
| [uv](https://docs.astral.sh/uv/) | latest | virtualenv + dependency manager |
| [ngrok](https://ngrok.com/) | latest | public HTTPS tunnel so ElevenLabs can reach the local webhook |

You will also need API keys / IDs for **ElevenLabs**, **OpenAI**, **Google Places**, and **Tavily**
(see `.env.sample`), plus an [ngrok account](https://dashboard.ngrok.com/signup) (free tier is fine)
to authenticate the tunnel.

### Install on macOS

The easiest path is [Homebrew](https://brew.sh/):

```bash
# uv (installs its own bundled Python, so you don't need Python separately)
brew install uv

# ngrok
brew install ngrok
```

Alternatives if you prefer not to use Homebrew:

```bash
# uv — official standalone installer
curl -LsSf https://astral.sh/uv/install.sh | sh

# Python 3.12 (only needed if not using uv's bundled Python)
brew install python@3.12
```

Then authenticate ngrok once with the authtoken from your
[ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken):

```bash
ngrok config add-authtoken <your-token>
```

The same token is kept in `.env` as `NGROK_AUTH_TOKEN` for convenience (the app itself
does not read it).

Verify everything is on your PATH:

```bash
uv --version
ngrok --version
```

## Setup

```bash
uv venv
uv pip install -r requirements.txt
cp .env.sample .env   # then fill in keys (already done if you have .env)
```

Set `DEMO_TARGETS` in `.env` to a comma-separated list of E.164 numbers you're allowed to call
(teammate phones for the demo — **never real funeral homes**).

### SMS notifications (optional)

To text the user pipeline-progress updates, set these Twilio credentials in `.env` (from
[console.twilio.com](https://console.twilio.com)):

Auth uses an **API key** (Twilio recommends this over the account Auth Token, which grants full
account access). Create one at Console → Account → **API keys & tokens**.

| Var | What it is |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID (starts with `AC…`) — needed to build the request URL |
| `TWILIO_API_KEY_SID` | API key SID (starts with `SK…`) — the request username |
| `TWILIO_API_KEY_SECRET` | API key secret — the request password (shown once at key creation) |
| `TWILIO_SMS_FROM` | an **SMS-capable** Twilio number in E.164 to send from (e.g. `+14155550123`) |

These are separate from the ElevenLabs API key. The user's number is captured automatically from the
inbound intake call (`case.user_phone`), so no number needs to be entered by hand. If all three are
set, `settings.sms_configured` is true and SMS sending is enabled; if unset, SMS is skipped.

## Run + test the calling loop

```bash
# 1. start the API
uv run uvicorn app.main:app --reload --port 8000

# 2. expose it (new terminal)
ngrok http 8000
```

Paste the ngrok **https** URL into each ElevenLabs agent's post-call webhook config as
`{ngrok-url}/webhooks/elevenlabs` (see the setup notes at the top of each file in `prompts/`).
Deploy the agent prompts from git with `scripts/deploy_agents.py` (below) instead of pasting them
by hand.

```bash
# 3. place a test call to the first DEMO_TARGET
curl -X POST localhost:8000/debug/call \
  -H 'content-type: application/json' \
  -d '{"agent":"quote"}'

# or to a specific number with context
curl -X POST localhost:8000/debug/call \
  -H 'content-type: application/json' \
  -d '{"agent":"quote","to_number":"+14155551234","dynamic_vars":{"city":"Oakland","state":"CA","service_type":"cremation","timeline":"within a week","attendee_count":"30"}}'
```

Answer the phone, role-play a funeral home, hang up. Then:

```bash
curl localhost:8000/cases/<case_id>          # full case state (transcripts land here)
cat data/<case_id>/transcripts/*.txt
```

## Manage agents in git (`scripts/deploy_agents.py`)

Agent configuration is version-controlled across two files per agent:

| File | Owns |
|---|---|
| `prompts/{type}_agent.md` | prose — the `## First message` and `## System prompt` sections |
| `agents/{type}.json` | the full `conversation_config` — llm, voice, temperature, asr, turn, ... (everything *except* the prompt text + first message) |

The script targets the ElevenLabs agents named by the `ELEVENLABS_*_AGENT_ID` values in `.env`
(`type` = `intake` | `quote` | `nego` | `report`).

```bash
# 1. bootstrap (or re-sync) agents/*.json from your live agents — run this first
uv run python scripts/deploy_agents.py --pull

# 2. edit agents/*.json (voice, llm, temperature, ...) and/or prompts/*.md

# 3. deploy: shows a diff of what would change on the live agent, then asks to confirm
uv run python scripts/deploy_agents.py --dry-run      # show the diff, change nothing
uv run python scripts/deploy_agents.py                # deploy all (prompts each agent y/N)
uv run python scripts/deploy_agents.py --agent quote  # just one agent
uv run python scripts/deploy_agents.py --yes          # skip the confirmation prompt (CI)
```

Deploy merges the prompt back into the mirrored config and PATCHes the whole `conversation_config`,
so git is the source of truth — a value changed in the dashboard is reverted on the next deploy
unless you `--pull` it first. `{{dynamic_variables}}` used in the prose are auto-registered as
placeholders (default `""`); set non-empty defaults directly in `agents/{type}.json`.

### git holds production prompts; live is deliberately shorter

The prompts in this repo are the realistic, production-length versions. The agents currently live
in ElevenLabs run intentionally **shortened** scripts so demo calls stay brief. That divergence is
on purpose, so `--dry-run` reporting drift on `quote`/`nego` is the expected state, not a problem
to fix — **do not run a plain `deploy` to "sync" it** unless you actually mean to lengthen the live
demo calls, and do not `--pull` the prose back, which would overwrite the production prompt with
the demo script.

### Mirrored but never pushed

Two things are tracked so drift shows up in a diff, but are only ever changed in the dashboard:

| File | Owns |
|---|---|
| `agents/report.json` + `prompts/report_agent.md` | the `report` agent — mirror-only (`PULL_ONLY` in the script), so `deploy` reports drift and skips it |
| `agents/workspace.json` | workspace-level config: `/v1/convai/settings` and the workspace webhooks (id, name, URL, auth type). No secret values are returned by the API, so this is safe to commit |

`--dry-run` also checks the live post-call webhook against `BASE_URL` and warns when they diverge —
the failure mode every ngrok restart causes, where calls still connect and transcripts silently
never arrive:

```bash
uv run python scripts/deploy_agents.py --dry-run --agent workspace
#   [workspace] ✔ post-call webhook matches BASE_URL -> https://….ngrok-free.dev/webhooks/elevenlabs
```

Still not managed at all (dashboard only): attaching phone numbers, the webhook HMAC secret,
`platform_settings` (widget, data collection, evaluation criteria), and the workspace tool
definitions.

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /` | consumer landing page (needs `GRACE_PHONE_NUMBER`, else `503`) |
| `GET /health` | liveness + config check |
| `POST /debug/call` | place a test outbound call |
| `POST /webhooks/elevenlabs` | single post-call webhook entrypoint |
| `GET /cases/{id}` | dump full case state (demo UI) |
| `GET /cases/{id}/report` | return `report.md` (Slice 6) |
| `POST /cases/{id}/advance` | manual pipeline nudge (Slice 2+) |

## Deploy to a remote box

See [docs/deploy-remote.md](docs/deploy-remote.md) — full walkthrough for the Akash Ubuntu
container demo box, including the container-specific gotchas (no systemd, `:8000` not port-mapped,
ngrok's one-endpoint-per-account limit) and what the tunnel leaves publicly exposed.

## Compliance

Do **not** place AI calls to real funeral homes. Use `DEMO_TARGETS` (teammate phones) for all
testing and demos. Grace always identifies itself as an AI assistant on every call.
