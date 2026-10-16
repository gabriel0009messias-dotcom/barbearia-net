-- Delivery facts are separate from global instance ownership (018).
ALTER TABLE whatsapp_messages ADD COLUMN claim_token uuid;
ALTER TABLE whatsapp_messages ADD COLUMN operation_token uuid;
ALTER TABLE whatsapp_messages ADD COLUMN claimed_at timestamptz;
ALTER TABLE whatsapp_messages ADD COLUMN last_error text;
ALTER TABLE whatsapp_messages ADD COLUMN dispatch_started_at timestamptz;
-- The old protocol had no durable transport frontier. Never infer no transport
-- from missing new fields on a legacy attempt.
-- Legacy attempts may already have been accepted. Never automatically replay them.
UPDATE whatsapp_messages SET dispatch_started_at=CURRENT_TIMESTAMP,
 status=CASE WHEN status='pending' AND attempts>0 THEN 'uncertain' ELSE status END,
 last_error=CASE WHEN status='pending' AND attempts>0 THEN 'Legacy delivery requires explicit reconciliation.' ELSE last_error END
 WHERE attempts>0 OR status IN ('sending','sent','failed','uncertain');
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_delivery_status
 CHECK(status IN ('pending','sending','sent','failed','uncertain'));
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_uncertain_evidence
 CHECK(status<>'uncertain' OR operation_token IS NOT NULL OR dispatch_started_at IS NOT NULL);
ALTER TABLE appointment_reminders DROP CONSTRAINT appointment_reminders_status_check;
ALTER TABLE appointment_reminders ADD CONSTRAINT appointment_reminders_status_check
 CHECK(status IN ('pending','sending','sent','failed','cancelled','uncertain','expired'));
ALTER TABLE appointment_reminders ADD COLUMN claim_token uuid;
ALTER TABLE appointment_reminders ADD COLUMN operation_token uuid;
ALTER TABLE appointment_reminders ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE appointment_reminders ADD COLUMN dispatch_started_at timestamptz;
UPDATE appointment_reminders SET dispatch_started_at=CURRENT_TIMESTAMP,
 status=CASE WHEN status='pending' AND attempts>0 THEN 'uncertain' ELSE status END,
 last_error=CASE WHEN status='pending' AND attempts>0 THEN 'Legacy delivery requires explicit reconciliation.' ELSE last_error END
 WHERE attempts>0 OR status IN ('sending','sent','failed','uncertain');
ALTER TABLE appointment_reminders ADD CONSTRAINT reminder_uncertain_evidence
 CHECK(status<>'uncertain' OR operation_token IS NOT NULL OR dispatch_started_at IS NOT NULL);

-- Internal reconciliation receipts survive new claims and make concurrent or
-- repeated reconciliation idempotent without releasing any later reservation.
CREATE TABLE evolution_delivery_reconciliations (
 receipt_key text PRIMARY KEY,
 operation_token uuid UNIQUE,
 delivery_kind text NOT NULL CHECK(delivery_kind IN ('whatsapp_messages','appointment_reminders')),
 delivery_id bigint NOT NULL CHECK(delivery_id > 0),
 assinatura_id bigint NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
 claim_token uuid,
 outcome text NOT NULL CHECK(outcome IN ('accepted','rejected','not_accepted')),
 reconciled_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION studiofy_delivery_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='uncertain' AND ROW(NEW.status,NEW.claim_token,NEW.operation_token,NEW.dispatch_started_at)
   IS DISTINCT FROM ROW(OLD.status,OLD.claim_token,OLD.operation_token,OLD.dispatch_started_at) AND
   current_setting('studiofy.delivery_reconciliation',true) IS DISTINCT FROM
    coalesce(OLD.claim_token::text,'legacy:'||TG_TABLE_NAME||':'||OLD.id::text) THEN
  RAISE EXCEPTION 'Uncertain delivery requires explicit reconciliation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_delivery_state_guard BEFORE UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION studiofy_delivery_state_guard();
CREATE TRIGGER studiofy_delivery_state_guard BEFORE UPDATE ON appointment_reminders
 FOR EACH ROW EXECUTE FUNCTION studiofy_delivery_state_guard();

-- Rescheduling/cancellation must never silently recycle an in-flight/uncertain attempt.
CREATE OR REPLACE FUNCTION studiofy_reminder_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='confirmado' THEN
  INSERT INTO appointment_reminders(appointment_id,assinatura_id,due_at)
   VALUES(NEW.id,NEW.assinatura_id,(NEW.data || ' ' || NEW.hora)::timestamp AT TIME ZONE 'America/Sao_Paulo' - interval '20 minutes')
  ON CONFLICT(appointment_id) DO UPDATE SET
   due_at=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.due_at ELSE EXCLUDED.due_at END,
   status=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.status
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN 'pending' ELSE appointment_reminders.status END,
   sent_at=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.sent_at
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.sent_at END,
   attempts=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.attempts
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN 0 ELSE appointment_reminders.attempts END,
   dispatch_started_at=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.dispatch_started_at
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.dispatch_started_at END,
   operation_token=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.operation_token
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.operation_token END,
   claim_token=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.claim_token
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.claim_token END,
   claimed_at=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.claimed_at
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.claimed_at END,
   next_attempt_at=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.next_attempt_at
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.next_attempt_at END,
   last_error=CASE WHEN appointment_reminders.status IN ('sending','uncertain') THEN appointment_reminders.last_error
    WHEN appointment_reminders.due_at<>EXCLUDED.due_at OR appointment_reminders.status='cancelled' THEN NULL ELSE appointment_reminders.last_error END;
 ELSE UPDATE appointment_reminders SET status='cancelled' WHERE appointment_id=NEW.id AND status IN ('pending','failed','expired'); END IF;
 RETURN NEW;
END $$;
