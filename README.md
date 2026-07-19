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

## Run + test the calling loop

```bash
# 1. start the API
uv run uvicorn app.main:app --reload --port 8000

# 2. expose it (new terminal)
ngrok http 8000
```

Paste the ngrok **https** URL into each ElevenLabs agent's post-call webhook config as
`{ngrok-url}/webhooks/elevenlabs` (see the setup notes at the top of each file in `prompts/`).
Also configure the agent system prompts / first messages / dynamic variables from `prompts/`.

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

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + config check |
| `POST /debug/call` | place a test outbound call |
| `POST /webhooks/elevenlabs` | single post-call webhook entrypoint |
| `GET /cases/{id}` | dump full case state (demo UI) |
| `GET /cases/{id}/report` | return `report.md` (Slice 6) |
| `POST /cases/{id}/advance` | manual pipeline nudge (Slice 2+) |

## Compliance

Do **not** place AI calls to real funeral homes. Use `DEMO_TARGETS` (teammate phones) for all
testing and demos. Grace always identifies itself as an AI assistant on every call.
