# Deploying to a remote container (Akash)

How the demo box at `provider.boogle.cloud:30213` was brought up, so it can be redone from scratch.

Target is an **Akash-deployed Ubuntu container**, which is why a few obvious things don't work —
see [Gotchas](#gotchas) before debugging anything surprising.

| | |
|---|---|
| Host | `root@provider.boogle.cloud -p 30213` (key: `~/.ssh/id_ed25519`) |
| Public IP | `66.188.16.11` |
| OS | Ubuntu 24.04 LTS, x86_64 |
| App dir | `/opt/grace` |
| Logs | `/var/log/grace/` |
| Public URL | via ngrok — the container's `:8000` is **not** port-mapped |

---

## 1. Install the toolchain

The image ships `git` but no Python.

```bash
ssh root@provider.boogle.cloud -p 30213 -i ~/.ssh/id_ed25519

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y python3 python3-venv python3-pip curl ca-certificates gnupg
python3 -V   # must be >= 3.12 (pyproject requires-python); 24.04 ships 3.12.3
```

ngrok is not in apt — install the binary directly:

```bash
curl -sSLo /tmp/ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz
tar xzf /tmp/ngrok.tgz -C /usr/local/bin
chmod +x /usr/local/bin/ngrok
ngrok version
```

## 2. Clone and build

The repo is public, so no deploy key or token is needed.

```bash
git clone --branch develop-after-deadline https://github.com/UmaSanskriti/grace.git /opt/grace
cd /opt/grace

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

`uv` is used locally but is not needed here — `requirements.txt` is kept in sync with
`pyproject.toml` for exactly this case.

## 3. Ship the secrets

Not in git. Copy from your machine, in a **local** shell:

```bash
scp -P 30213 -i ~/.ssh/id_ed25519 .env root@provider.boogle.cloud:/opt/grace/.env
```

Then lock it down on the server:

```bash
chmod 600 /opt/grace/.env
chmod 700 /opt/grace
```

`GRACE_PHONE_NUMBER` **must** be set or `/` returns `503` — it has no default in source, by design.
`BASE_URL` is filled in at step 5, once the tunnel hands you a URL.

> Copying the full `.env` puts every production key on the box. If you only need the landing page,
> a file with just `GRACE_PHONE_NUMBER` is enough — `/` and `/health` work without any API keys.

## 4. Start the app

```bash
mkdir -p /var/log/grace
cd /opt/grace
setsid nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  > /var/log/grace/app.log 2>&1 < /dev/null &

curl -s localhost:8000/health
```

`setsid` matters: without it the process is in the SSH session's process group and dies when you
disconnect. `--host 0.0.0.0` rather than `127.0.0.1` so ngrok can reach it.

## 5. Open the tunnel

```bash
# token comes from the .env you just copied
ngrok config add-authtoken "$(grep '^NGROK_AUTH_TOKEN=' /opt/grace/.env | cut -d= -f2-)"

setsid nohup ngrok http 8000 --log stdout --log-format logfmt \
  > /var/log/grace/ngrok.log 2>&1 < /dev/null &

# read the assigned URL back off the local agent API
curl -s localhost:4040/api/tunnels \
  | python3 -c 'import sys,json;[print(t["public_url"]) for t in json.load(sys.stdin)["tunnels"]]'
```

Then point the app at its own public URL and restart it, so webhook callbacks and report links
resolve:

```bash
cd /opt/grace
sed -i 's|^BASE_URL=.*|BASE_URL=https://<your-ngrok-host>|' .env

kill "$(pgrep -f uvicorn | head -1)"
setsid nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  > /var/log/grace/app.log 2>&1 < /dev/null &

curl -s localhost:8000/health   # base_url should now be the ngrok URL
```

## 6. Ship the admin dashboard (optional)

The React dashboard is served at `/admin`. `web/dist` is gitignored and there is
no Node on the box, so build locally and copy the bundle up.

**Build on your machine**, with `VITE_APP_BASE_URL` explicitly blank:

```bash
cd web
npm ci                          # first time only
VITE_APP_BASE_URL= npm run build
```

Clearing that variable matters. `web/.env` sets it to `http://localhost:8000` for
the Vite dev server, and vite bakes the value in at build time — build without
clearing it and the deployed bundle calls *the visitor's own machine*, failing
as `Failed to fetch`. Blank means the bundle uses the origin it was served
from, which is correct whenever one backend serves both the bundle and the API,
and needs no rebuild when the public URL changes.

Sanity-check before shipping:

```bash
grep -c 'localhost:8000' dist/assets/*.js   # must be 0
```

**Copy it up:**

```bash
ssh root@provider.boogle.cloud -p 30213 -i ~/.ssh/id_ed25519 'mkdir -p /opt/grace/web/dist'
scp -r -P 30213 -i ~/.ssh/id_ed25519 web/dist/ root@provider.boogle.cloud:/opt/grace/web/
```

Restart the app (step 4) and `/admin` serves it. If `web/dist` is absent the
route just 404s — nothing else is affected.

## 7. Verify from outside

From your own machine, not the box — the point is to prove the tunnel works:

```bash
U=https://<your-ngrok-host>
curl -s -H 'ngrok-skip-browser-warning: 1' $U/health
curl -s -H 'ngrok-skip-browser-warning: 1' $U/ | grep -o 'href="tel:[^"]*"'

# dashboard, if shipped — /admin and a client-side route must both be 200
for p in /admin /admin/agents; do
  curl -s -H 'ngrok-skip-browser-warning: 1' -o /dev/null -w "$p -> %{http_code}\n" $U$p
done
```

The `tel:` link should show the number from `.env`. If it's missing, `GRACE_PHONE_NUMBER` didn't
make it across.

---

## Gotchas

**No systemd.** PID 1 is `tini`. `systemctl` isn't installed, so a `.service` unit is not an option
— this is why the app runs under `setsid nohup`. Installing `supervisor` also doesn't help: apt
gets it onto disk but `invoke-rc.d` refuses to start it (`policy-rc.d denied execution`), so you'd
be hand-starting `supervisord` anyway. For a demo box nohup is the honest choice; the tradeoff is
**nothing restarts on crash or container restart** — rerun steps 4 and 5.

**Port 8000 is not publicly reachable.** Only the SSH port is mapped through, so
`http://provider.boogle.cloud:8000` times out and there is no way to skip the tunnel. Confirm with
`curl --max-time 8 http://provider.boogle.cloud:8000/health` if you're unsure.

**ngrok free tier allows exactly one online endpoint per account.** If a tunnel is already running
anywhere else on the same token — a laptop, another box — the server's tunnel dies immediately with:

```
failed to start tunnel: The endpoint 'https://<name>.ngrok-free.dev' is already online
ERR_NGROK_334
```

Stop the other one first, or use a token from a different account. Because the free hostname is
stable per account, handing the endpoint over does **not** change the URL: anything already
configured against it (e.g. the ElevenLabs webhook) keeps working and simply routes to whoever
holds the tunnel.

**ngrok shows an interstitial** to first-time browser visitors on the free tier. `curl` skips it
with `-H 'ngrok-skip-browser-warning: 1'`; browsers can't, short of a paid plan.

**Locale warnings** (`setlocale: LC_ALL: cannot change locale`) are noise from the image and safe
to ignore.

## Everything is public and unauthenticated

The tunnel exposes the whole API, not just the landing page:

| Route | Exposure |
|---|---|
| `GET /` | landing page — intended |
| `GET /docs` | **interactive Swagger UI**, lets any visitor drive the API from a browser |
| `GET /admin/*` | **admin dashboard** — browsable case list and full call transcripts |
| `GET /call-transcript` | no auth — proxies complete transcripts of families' calls |
| `POST /debug/call` | **no auth** — places real, billable ElevenLabs calls |
| `POST /webhooks/elevenlabs` | HMAC-verified when `ELEVENLABS_WEBHOOK_SECRET` is set |
| `GET /cases/{id}`, `POST /cases/{id}/advance` | no auth |

Fine for a short demo on an unguessable hostname holding synthetic data. Before leaving it up any
longer, at minimum pass `docs_url=None` to `FastAPI()`, put a shared-secret check in front of
`/debug/call`, and put HTTP Basic auth in front of `/admin` and `/call-transcript` — those two
surface real families' call transcripts to anyone with the link.

## Redeploying a new commit

```bash
cd /opt/grace
git pull origin develop-after-deadline
.venv/bin/pip install -r requirements.txt   # only if deps changed

kill "$(pgrep -f uvicorn | head -1)"
setsid nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  > /var/log/grace/app.log 2>&1 < /dev/null &
```

The tunnel survives an app restart — leave ngrok alone unless the URL needs to change.

If the change touched `web/`, rebuild and re-ship the bundle too (step 6) — `git pull` does not
bring it, since `web/dist` is gitignored.

## Checking on it

```bash
ps -eo pid,etime,args --no-headers | grep -E 'uvicorn|ngrok http' | grep -v grep
tail -50 /var/log/grace/app.log
tail -50 /var/log/grace/ngrok.log
curl -s localhost:4040/api/tunnels | head -c 400   # current public URL
```
