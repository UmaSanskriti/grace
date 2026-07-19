# Grace — Full Data Model (real ingestion spec)

**Status: STUB / WORK IN PROGRESS.**
This is the *real* data we need to ingest from users and funeral homes — much richer than the
minimal happy-path model in [`v0-instruction.md`](./v0-instruction.md). v0 exists to prove the
end-to-end flow; this document is where the production-grade fields get specified.

Everything below is a placeholder outline. Fill in types, enums, validation, and required/optional
flags as we design each area for real.

---

## 1. Full user intake (`user_info.json`)

The v0 version captures only what's needed to *request* a quote. The real intake needs enough to
match, compare, and negotiate on the family's behalf.

- **Contact** — name, phone, email, relationship to deceased, preferred contact method/times, timezone
- **Deceased** — name, age, date of death, place of death (hospital / home / hospice / coroner),
  current location of the body, weight (affects cremation/handling), veteran status (VA benefits)
- **Service** — disposition type (cremation / burial / green burial / donation), viewing/visitation
  yes/no, memorial vs. graveside vs. full service, attendee estimate, religious/cultural/denominational
  requirements, language needs, music/flowers/officiant preferences
- **Logistics** — desired timeline / date constraints, cemetery or existing plot, transport across
  city/state lines, out-of-town family
- **Financial** — budget range, insurance / pre-need policy, VA or other benefits, payment method,
  financial-hardship / assistance eligibility
- **Consent / legal** — authorizing agent (next of kin), authority to make arrangements, record-keeping consent

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
