-- Administrative suspension never changes paid periods or trial claims.
ALTER TABLE assinaturas ADD COLUMN bloqueio_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Historical Admin PATCH accepted both spellings, also used by billing.
-- No durable provenance distinguishes them: preserve suspension conservatively.
-- Review/unlock requires an explicit authorized Admin action; facts stay intact.
UPDATE assinaturas SET bloqueio_admin = TRUE WHERE lower(btrim(status)) IN ('bloqueado', 'bloqueada');
