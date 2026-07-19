# Grace — personalised funeral-home search

**Grace calls the funeral homes, so grieving families don't have to.** Families share their needs (traditions, language, timing, budget) by phone or text; Grace calls nearby funeral homes with the same brief, gathers itemized quotes, flags missing fees, negotiates only with the family's permission, and reports back with matched options. Every decision — and every payment — stays with the family.

This repo contains the **production-ready static frontend** and the contract a backend must implement. It is written to be picked up by AI coding agents: every integration point is marked in-source and specified below.

## Repo layout

```
index.html         The entire site: markup, CSS, JS, and fonts in one file (no build step,
                   zero external requests — fonts are embedded as base64 @font-face).
dusk-linen.html    Earlier visual system, kept for reference.
qa.js              jsdom behavioural test harness (see "QA" below).
package.json       Harness dependency (jsdom).
```

## Frontend architecture (what an agent needs to know before editing)

- **Single file, two views.** A client-side router switches between `#view` states: **Home** (elements tagged `.g-v-home`) and **Your arrangements** (`section#progress`). Navigation is click-driven buttons — there are deliberately **zero `<a>` elements** in the document (hosting sandboxes intercept anchors). Do not add anchors; wire new nav through `[data-route]` buttons.
- **Entry hashes** (read on load and on `hashchange`, never required for in-page nav): `#home`, `#arrangements`, and `#arrangements-live` (opens the arrangements view with the live dashboard active — this is the hash the texted private link should land on).
- **All classes are namespaced `g-`** to survive host-CSS collisions. Keep the prefix on anything you add.
- **Master components.** All Call/Text CTAs are instances of one pair (`.g-btn.g-btn-fill` / `.g-btn.g-btn-line`) using shared SVG `<symbol>` icons (`#i-call`, `#i-text`). Don't fork variants.
- **Contact sheet** (`#sheetRoot`): mode toggle (call/text), phone input with validation, explicit consent checkbox, focus-trapped dialog, visible statuses, cancel/edit/error paths. Fires nothing without consent.

## Integration point 1 — starting a contact request

In `index.html`, search for the comment **`── Integration point`** inside `startRequest()`. Replace the simulated timeout with a real request:

```
POST /api/contact
{ "mode": "call" | "text", "phone": "+15550123456", "consent": true }
→ 202 Accepted
```

- On success call `showActive()`; on failure call `showFailure(mode())`. Both UI paths (statuses, retry, switch-channel, cancel) already exist.
- Preview the failure UX any time with `window.GRACE_SIMULATE_FAILURE = true`.
- **Hard rule:** never initiate a call/text unless `consent` was checked by the user in the sheet.

## Integration point 2 — the live arrangements dashboard

After first contact, the backend texts the family a private link, e.g. `https://<host>/d/<token>`, which should resolve to this page with `#arrangements-live`. Validate the token server-side and render the family's `CaseState` into `#dashLive` (the shipped sample markup mirrors the exact shape; see the second `── Integration point` comment).

Suggested read API:

```
GET /api/case/<token> → CaseState
```

```jsonc
// CaseState — maps 1:1 onto the dashboard components
{
  "family": { "firstName": "Maya" },
  "updatedAt": "2026-07-18T23:41:00Z",
  "currentStep": 3,                       // 1..4, drives .g-progressbar + caption
  "requirements": {
    "confirmed": ["Direct cremation, no embalming", "..."],
    "open": ["Where to send the death certificates?"]   // renders .g-open-item with Call/Text CTAs
  },
  "calls": [                               // renders .g-home sub-cards
    { "name": "Cedar & Vine Cremation", "price": 2980, "itemized": true,
      "tags": ["Transfer tomorrow"], "flags": ["Death certificates not included"] },
    { "name": "Oak & Olive Chapel", "status": "Voicemail left · awaiting a call back" }
  ],
  "negotiation": { "provider": "Cedar & Vine Cremation", "approvedAt": "...",
    "asks": ["Fold the death-certificate copies into the base price"],
    "status": "awaiting_written_reply" },
  "payment": { "status": "locked" }        // family pays the provider DIRECTLY; Grace never handles money
}
```

## Suggested backend (per the pitch deck's system flow)

Three voice agents over one shared case record:

| Component | Role | Service |
|---|---|---|
| Intake Agent | voice/text intake → collects needs, confirms permissions, creates CaseSpec | Twilio SMS + Voice |
| Caller Agent | calls providers with the same confirmed brief | Twilio Voice |
| Closer Agent | negotiates (only user-approved asks), ranks, explains | — |
| Quote normalization | itemize, compare, flag missing fees | OpenAI structured outputs |
| Provider research | find nearby funeral homes | Tavily |
| Evidence ledger | calls, transcripts, quotes (auditable) | Markdown/DB |

Typical env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OPENAI_API_KEY`, `TAVILY_API_KEY`. Case tokens must be unguessable and revocable.

## Guardrails (non-negotiable product rules — enforce in any agent you build)

1. Grace **never books, signs, or authorizes** cremation, burial, embalming, or transport.
2. Grace **never handles money**; payment goes family → funeral home directly.
3. **Consent before contact**, per channel. Replying **STOP** to any text ends contact and erases the case.
4. Negotiate **only asks the family approved**; unknowns are flagged, never guessed.
5. Providers cannot pay for placement; no data is sold or shared beyond approved funeral homes.

## QA

```bash
npm install
node qa.js                                # normal browser behaviour (tests ./index.html)
node qa.js --no-hashchange                # sandboxed-host simulation
node qa.js --hash='#arrangements-live'    # texted-link entry
```

Behavioural assertions (jsdom): routing, master-component conformance (all CTAs identical, zero anchors), dialog flow, dashboard toggles, delegated-listener resilience.

**Rendered QA** (real Chromium — layout, hit-testing, genuine mouse clicks at 390/560/1200px):

```bash
node realqa.mjs
```

Run this tier before shipping any CSS change that touches positioned or fixed elements; jsdom cannot catch layout regressions (e.g., a nav control rendered off-screen).

## Deploy

Pure static file — GitHub Pages, Netlify, or any object store. No build, no runtime deps, no external requests.
