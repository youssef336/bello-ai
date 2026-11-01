-- Paid models the owner explicitly allowed (through OpenRouter credits). Never used unless
-- paid mode is on and the monthly cap is not reached.
ALTER TABLE models ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN price_in REAL;   -- USD per 1M input tokens
ALTER TABLE models ADD COLUMN price_out REAL;  -- USD per 1M output tokens

-- Estimated spend, from token estimates × catalog prices.
ALTER TABLE usage ADD COLUMN cost_est REAL NOT NULL DEFAULT 0;
