ALTER TABLE consents ADD CONSTRAINT consents_nonempty_scopes CHECK (coalesce(array_length(scopes, 1), 0) > 0);
ALTER TABLE partner_credentials ADD CONSTRAINT credentials_nonempty_scopes CHECK (coalesce(array_length(scopes, 1), 0) > 0);
