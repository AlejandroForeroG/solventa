ALTER TABLE signal_refresh_jobs ADD CONSTRAINT refresh_nonempty_scopes CHECK (coalesce(array_length(scopes, 1), 0) > 0);
