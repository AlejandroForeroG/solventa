-- Partner quote API: readable quote code and its per-year counter.
-- The counter is a table, not a sequence, because runtime grants are per table.
ALTER TABLE quotes ADD COLUMN quote_code STRING UNIQUE CHECK (quote_code ~ '^COT-[0-9]{4}-[0-9]{5}$');
CREATE TABLE quote_counters (
  year INT8 PRIMARY KEY CHECK (year >= 2000),
  last_value INT8 NOT NULL CHECK (last_value >= 0 AND last_value <= 99999)
);
