-- The location a customer chose to attach to a claim report. It is optional: all three columns are null, or all three are set together.
-- The authorization time is the server's record that the customer attached it explicitly; it is never inferred or backfilled.
ALTER TABLE claims ADD COLUMN location_latitude NUMERIC(8, 6) CHECK (location_latitude IS NULL OR location_latitude BETWEEN -90 AND 90);
ALTER TABLE claims ADD COLUMN location_longitude NUMERIC(9, 6) CHECK (location_longitude IS NULL OR location_longitude BETWEEN -180 AND 180);
ALTER TABLE claims ADD COLUMN location_authorized_at TIMESTAMPTZ;
ALTER TABLE claims ADD CONSTRAINT claims_location_together CHECK (
  (location_latitude IS NULL AND location_longitude IS NULL AND location_authorized_at IS NULL)
  OR (location_latitude IS NOT NULL AND location_longitude IS NOT NULL AND location_authorized_at IS NOT NULL));
