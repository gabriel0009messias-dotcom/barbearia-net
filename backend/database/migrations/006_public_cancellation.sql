ALTER TABLE assinaturas ADD COLUMN cancellation_notice_minutes INTEGER NOT NULL DEFAULT 0
 CHECK (cancellation_notice_minutes BETWEEN 0 AND 129600);

-- Only a digest is persisted. The random capability is given once to the customer.
CREATE TABLE public_booking_access (
 appointment_id BIGINT PRIMARY KEY REFERENCES agendamentos(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
