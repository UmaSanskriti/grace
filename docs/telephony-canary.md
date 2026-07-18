# Telephony Canary — Twilio Trial (spec §8.3)

**Run this in the first hour (build order §12.2, 0–1 h).** SMS delivery is a
**go/no-go gate**; **voice proceeds regardless** of the SMS result. Do **not** spend
the hackathon debugging carrier registration — see the stop condition below.

> Synthetic data + pre-consented, allowlisted team phones only. All numbers must be
> verified in Twilio and present in `DEMO_ALLOWED_E164`. Not legal advice.

## Preconditions

- [ ] Twilio trial created; email + lead phone verified (§8.1).
- [ ] One U.S. local number with **Voice + SMS** capability provisioned.
- [ ] Consumer canary phone **verified in Twilio** and added to `DEMO_ALLOWED_E164`.
- [ ] Messaging webhook set to `POST https://<app>/twilio/sms` (§8.4).
- [ ] Twilio **call recording OFF** (INV-09).

## Procedure (§8.3)

| # | Step | Pass criteria |
|---|------|---------------|
| 1 | Verify the consumer phone in Twilio. | Number shows **Verified**. |
| 2 | Send the **exact** Grace preference SMS (Console or Edge Function). | Message sent without error. |
| 3 | Confirm the phone receives it; check the **trial prefix**. | SMS arrives; trial "Sent from your Twilio trial account" prefix is acceptable for the demo. |
| 4 | Reply **TEXT**; confirm `POST /twilio/sms` receives the payload. | Handler logs **MessageSid, From, To, Body**. |
| 5 | Send Grace's next intake question; verify delivery. | Consumer receives the follow-up SMS. |
| 6 | Call the Twilio number from the validated phone (inbound voice). | Trial inbound voice connects. |
| 7 | Place an **outbound** voice test. | **Trial announcement + agent audio** both heard. |
| 8 | Record result below with **timestamp + screenshot**. | Row filled in; screenshot attached. |

The exact SMS in step 2 is `config/disclosure.json` → `messages.first_sms`:

> Grace here, the AI funeral-arrangements advocate for this demo. Would you rather
> continue by text or receive a call? Reply TEXT or CALL. Messages and calls may be
> transcribed and processed by our service providers. Reply STOP to stop.

## Results table

Fill this in during the canary. Attach screenshots to the repo/issue and reference
their filenames.

| Step | Result (pass/fail) | Timestamp | Screenshot / notes |
|------|--------------------|-----------|--------------------|
| 1 — Phone verified | | `<YYYY-MM-DDTHH:MMZ>` | `<screenshot-verify.png>` |
| 2 — First SMS sent | | | `<screenshot-send.png>` |
| 3 — SMS received + trial prefix | | | |
| 4 — Inbound webhook payload | | | MessageSid: `<…>` |
| 5 — Follow-up SMS delivered | | | |
| 6 — Inbound voice | | | |
| 7 — Outbound voice (announcement + audio) | | | `<screenshot-voice.png>` |
| 8 — Recorded | | | |

**Canary verdict:** SMS `[ go / no-go ]` · Voice `[ go / no-go ]`

## Stop condition (§8.3) — do not debug carrier registration

> If **outbound SMS does not deliver**, do **not** spend the hackathon debugging
> carrier registration.

- Trial accounts **cannot register A2P 10DLC**; toll-free verification **requires a
  paid account**.
- **Ask the organizers for Twilio credit** or fund a minimal upgrade.
- **Voice can continue on the trial** — proceed with the voice demo regardless.
- Engineering fallback (from the §12.3 ladder): use **Lovable in-app text**; keep
  voice. If no SMS-capable trial number, release/reprovision **once** if allowed,
  otherwise upgrade/promo. Escalate up the fallback ladder in
  [`acceptance-checklist.md`](./acceptance-checklist.md) → §12.3.
