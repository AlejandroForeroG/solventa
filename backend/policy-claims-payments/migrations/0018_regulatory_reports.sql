-- A revision is immutable evidence: the CSV, its manifest and hash never change, and a changed fact set adds another revision.
CREATE TABLE report_revisions (
  id UUID PRIMARY KEY,
  period STRING NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  destination STRING NOT NULL CHECK (destination IN ('regulator', 'reinsurer')),
  revision INT4 NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  format_version STRING NOT NULL CHECK (format_version IN ('regulator-portfolio.v1', 'reinsurer-bordereau.v1')),
  content STRING NOT NULL,
  content_hash STRING NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  manifest JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  generated_by UUID NOT NULL,
  correlation_id UUID NOT NULL,
  UNIQUE (period, destination, revision),
  UNIQUE (period, destination, content_hash)
);
CREATE INDEX report_revisions_by_generation ON report_revisions (generated_at DESC, id DESC);
-- One delivery identity per revision: a retry reuses it, so a confirmed outcome is never repeated.
CREATE TABLE report_deliveries (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL UNIQUE REFERENCES report_revisions(id),
  status STRING NOT NULL CHECK (status IN ('pending', 'dispatched', 'acknowledged', 'rejected', 'uncertain')),
  attempts INT4 NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  reference STRING CHECK (reference IS NULL OR reference ~ '^MOCK-RPT-[0-9a-f-]{36}$'),
  rejection_code STRING CHECK (rejection_code IS NULL OR rejection_code ~ '^[a-z_]{3,48}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'acknowledged') = (reference IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejection_code IS NOT NULL))
);
-- The explicitly simulated destinations keep their own ledger, so a lookup after a timeout works across instances.
CREATE TABLE report_destination_receipts (
  delivery_id UUID PRIMARY KEY,
  destination STRING NOT NULL CHECK (destination IN ('regulator', 'reinsurer')),
  content_hash STRING NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  outcome STRING NOT NULL CHECK (outcome IN ('acknowledged', 'rejected')),
  reference STRING CHECK (reference IS NULL OR reference ~ '^MOCK-RPT-[0-9a-f-]{36}$'),
  rejection_code STRING CHECK (rejection_code IS NULL OR rejection_code ~ '^[a-z_]{3,48}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((outcome = 'acknowledged') = (reference IS NOT NULL)),
  CHECK ((outcome = 'rejected') = (rejection_code IS NOT NULL))
);
