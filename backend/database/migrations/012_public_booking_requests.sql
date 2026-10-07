-- Recovery capabilities are never persisted in cleartext. No historical row changes.
CREATE TABLE public_booking_requests (
 assinatura_id BIGINT NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
 key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 appointment_id BIGINT NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (assinatura_id,key_hash)
);
CREATE INDEX public_booking_request_recovery ON public_booking_requests(key_hash,request_hash);

CREATE TABLE public_request_limits (
 key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
 window_start BIGINT NOT NULL,
 hits INTEGER NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (key_hash,window_start)
);
CREATE INDEX public_request_limits_expiry ON public_request_limits(expires_at);
