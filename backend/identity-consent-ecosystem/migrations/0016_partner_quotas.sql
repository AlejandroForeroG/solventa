CREATE TABLE partner_quota_policy (
  id BOOL PRIMARY KEY DEFAULT true CHECK (id),
  daily_limit INT8 NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000000000),
  tracking_since TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO partner_quota_policy (id,daily_limit) VALUES (true,1000);

CREATE TABLE partner_quota_overrides (
  partner_id UUID PRIMARY KEY REFERENCES partners(id),
  daily_limit INT8 NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID NOT NULL
);

CREATE TABLE partner_quota_windows (
  partner_id UUID NOT NULL REFERENCES partners(id),
  window_start DATE NOT NULL,
  used INT8 NOT NULL CHECK (used>=1),
  first_admitted_at TIMESTAMPTZ NOT NULL,
  last_admitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (partner_id,window_start)
);
