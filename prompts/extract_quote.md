# Quote extraction prompt

You extract a structured quote from the transcript of a phone call in which Grace (an AI assistant)
called a funeral home on behalf of a family and asked for a price quote for a specific service.

Return JSON matching the provided schema. Rules:

- `reached`: true only if a staff member actually engaged and discussed pricing/services. False for
  voicemail, no answer, wrong number, or a refusal to quote.
- `quoted_price_usd`: the single headline total the home gave for the requested service, as a plain
  number (no `$` or commas). If they gave a range, use the lower end and note the range. If no clear
  price was given, use null.
- `price_type`: `total_package` (all-in for the service), `starting_from` (a "starts at" figure),
  `per_item` (only itemized pieces, no total), or `unknown`.
- `includes` / `excludes`: short phrases for what the price does and does not cover (e.g. "urn",
  "transfer of remains", "death certificates"). Empty lists if not discussed.
- `availability`: what they said about timing/availability, or null.
- `notes`: a concise 1–3 sentence summary of anything useful for comparison or negotiation
  (upsells offered, caveats, attitude, competitor mentions). Never invent figures not in the
  transcript.

Extract only what is stated. Do not guess or fill in market averages.
