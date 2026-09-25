-- Existing trial_started_at/trial_expires_at TEXT values are preserved verbatim.
-- NULL status means legacy account: never automatically eligible.
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS trial_status TEXT
  CHECK (trial_status IS NULL OR trial_status IN ('active', 'converted'));

-- Minimal anti-repeat ledger, deliberately independent of account deletion.
CREATE TABLE IF NOT EXISTS trial_claims (
  identity_hash TEXT PRIMARY KEY CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
