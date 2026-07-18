-- =====================================================================
-- Grace — 0002_seed.sql
-- Seed the three SYNTHETIC demo providers from config/personas.json.
--
-- These are role-play personas, NOT real funeral homes. Destinations are
-- placeholders (+10000000000); the real allowlisted team phone numbers are
-- injected at demo time from the DEMO_ALLOWED_E164 environment secret and
-- allowlisted is flipped to true only then (INV-02). Nothing is dialable
-- until the backend sets a real, allowlisted destination.
-- =====================================================================

insert into providers (provider_id, type, label, destination, persona_id, allowlisted)
values
  ('demo_transparent',   'demo', 'Transparent family-owned director', '+10000000000', 'A', false),
  ('demo_package_first', 'demo', 'Package-first stonewaller',          '+10000000000', 'B', false),
  ('demo_hidden_fee',    'demo', 'Low headline, hidden-fee operator',  '+10000000000', 'C', false)
on conflict (provider_id) do nothing;
