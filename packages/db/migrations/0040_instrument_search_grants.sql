-- Lookups by company name (ADR 0029): when nothing trades as the symbol, the
-- worker stores the closest listings on the lookup for the person to pick.
GRANT UPDATE (candidates) ON "instrument_lookup" TO tm_app;
