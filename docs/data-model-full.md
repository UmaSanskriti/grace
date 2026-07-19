# Grace — Full Data Model (real ingestion spec)

**Status: STUB / WORK IN PROGRESS.**
This is the *real* data we need to ingest from users and funeral homes — much richer than the
minimal happy-path model in [`v0-instruction.md`](./v0-instruction.md). v0 exists to prove the
end-to-end flow; this document is where the production-grade fields get specified.

Everything below is a placeholder outline. Fill in types, enums, validation, and required/optional
flags as we design each area for real.

---

## 1. Full user intake (`user_info.json`) — SPEC'D (Slice 2)

**Implemented:** schema in `app/extraction.py` (`USER_INFO_SCHEMA`), extraction prompt in
`prompts/extract_user_info.md`, interview flow in `prompts/intake_agent.md`. Full field
definitions, data types, tier design (required core → conditional branches → optional
defaults), and the religion/tradition implications table:
https://github.com/omarcontreras96/hacknation-negotiator/blob/main/docs/intake-spec.md

Shape (extends the v0 fields; pipeline-compatible):

- **v0 core (kept):** `contact_name`, `service_type` (coarse: cremation / burial /
  memorial_only / undecided), `location {city, state, zip}`, `timeline`, `budget_usd`
  (**volunteered only — Grace never asks**; cost_posture replaces the budget question),
  `attendee_estimate`
- **`mode`** — at_need | pre_need
- **`cost_posture`** — lowest_comparable_total | balanced | prioritize_fit (how to weigh
  price vs. fit; never a forced dollar ceiling)
- **`must_haves[]`** — true dealbreakers in the family's words, incl. every confirmed
  tradition practice ("tahara by chevra kadisha", "witness cremation", "burial within 48
  hours"). Downstream: hard filter in report ranking — a home that can't meet one cannot
  win on price; re-confirmed on every provider call; never traded.
- **`flexible_if_savings[]`** — only items the family explicitly offered to drop/downgrade.
  Downstream: the ONLY negotiation concessions `strategy.py` may propose (Slice 5).
- **`service_preferences{}`** — enumerated detail fields (disposition_detail, viewing +
  hours, ceremony + location, witness_cremation, ashes_return, urn/casket source,
  cemetery_status, embalming, ritual_preparation, religion_tradition, language_needs,
  service_date_window, custody_location/deadline, authority_confirmed). "unknown"/null when
  not discussed — defaults are applied downstream, never invented by extraction.
- **`unknowns[]`** — every field the caller skipped or didn't know, by name.

Deliberately NOT collected (v0): SSN/ID/payment data, cause of death, medical history,
deceased's name/age/weight, insurance details — data minimization for the demo.

## 2. Itemized quote breakdown (`quotes/{fh_id}.json`)

v0 captures only `quoted_price_usd` + `notes`. The real quote is an itemized **General Price List
(GPL)** — the FTC Funeral Rule requires funeral homes to provide this. Capturing line items is what
makes apples-to-apples comparison and negotiation possible.

Line items to ingest (per FTC GPL categories):

- **Basic services fee** (non-declinable professional services)
- **Transfer of remains** to funeral home
- **Embalming** (and note: not legally required for many services — flag when upsold)
- **Other preparation** of the body (dressing, cosmetology, refrigeration)
- **Use of facilities/staff** — viewing, ceremony, memorial service
- **Transport** — hearse, limousine, service/utility vehicle
- **Merchandise** — casket, urn, alternative container, outer burial container/vault
- **Cremation fee** (crematory charge) / **direct cremation** package price
- **Cash advance items** (paid to third parties — clergy, obituary, flowers, death certificates,
  permits) — flag markup
- **Package vs. à la carte** — capture both the bundled package price and the itemized alternative

Each line item: `item`, `category`, `price_usd`, `declinable` (bool), `included_in_package` (bool),
`notes`. Plus overall: `package_name`, `total_usd`, `includes[]`, `excludes[]`, `availability`,
`gpl_provided` (bool), `quote_valid_until`.

## 3. Negotiation detail (`strategy.json`, `negotiations/{fh_id}.json`)

- Per-home target price, walk-away price, BATNA
- Leverage: specific competitor line items ("home X charges $Y less for the same casket")
- Which items are negotiable vs. fixed (basic services fee often non-negotiable; merchandise markup is)
- Concessions to seek (waive embalming, package upgrade, cash-advance markup removal)
- Recorded outcome: final itemized price, concessions gained, what was declined

## 4. Market data

- Local/regional average prices per service type and per line item
- Source citations (Tavily / NFDA / state data) for use as negotiation ammunition
- Confidence / recency of each figure

## 5. Comparison & report fields (`report.md` + structured backing)

- Normalized per-home comparison across identical line items
- Original vs. negotiated totals, and per-item deltas
- Value ranking (not just cheapest — what's included matters)
- Flags: missing GPL, unusual upsells, availability risk
- Grace's recommendation + reasoning, surfaced to the family

---

## Open questions

- How to normalize wildly different package structures into comparable line items?
- Which fields are hard-required for a usable quote vs. nice-to-have?
- Storage: does the itemized model push us off flat JSON toward SQLite sooner? (See v0 §3.)
