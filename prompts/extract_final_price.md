# Final-price extraction prompt

You extract the outcome of a negotiation phone call in which Grace (an AI assistant) called a
funeral home back to negotiate a previously quoted price on behalf of a family.

Return JSON matching the provided schema. Rules:

- `agreed`: true only if the home explicitly agreed to a specific final price by the end of the call.
- `final_price_usd`: the agreed final total as a plain number (no `$`/commas). If nothing was
  agreed, use null. If a price was agreed, this is that number (which may equal the original quote
  if they held firm).
- `walked_away`: true if Grace or the home ended without any agreement (declined, no deal).
- `concessions`: short phrases for anything gained beyond price (e.g. "waived embalming",
  "free urn", "removed cash-advance markup"). Empty list if none.
- `notes`: 1–3 sentence summary of how it went and anything useful for the final report.

Extract only what is stated. Never invent a price that wasn't agreed in the transcript.
