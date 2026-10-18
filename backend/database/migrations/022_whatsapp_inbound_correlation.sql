-- Conversation-only admission and logical question identity. 020/021 unchanged.
ALTER TABLE whatsapp_conversations ADD COLUMN question_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE whatsapp_conversations ADD COLUMN question_started_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE whatsapp_conversations ADD COLUMN input_guard jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK (jsonb_typeof(input_guard)='object');
ALTER TABLE whatsapp_conversations ADD COLUMN clarification jsonb
 CHECK (clarification IS NULL OR jsonb_typeof(clarification)='object');
ALTER TABLE whatsapp_conversation_responses ADD COLUMN question_id uuid;
CREATE INDEX whatsapp_conversation_responses_question ON whatsapp_conversation_responses
 (assinatura_id,conversation_id,owner_epoch,question_id);

ALTER TABLE whatsapp_conversation_inbox ADD COLUMN capture_context jsonb
 CHECK (capture_context IS NULL OR jsonb_typeof(capture_context)='object');
ALTER TABLE whatsapp_conversation_inbox ADD COLUMN captured_event jsonb
 CHECK (captured_event IS NULL OR jsonb_typeof(captured_event)='object');
ALTER TABLE whatsapp_conversation_inbox ADD CONSTRAINT conversation_capture_shape CHECK (
 decision<>'captured' OR (capture_context IS NOT NULL AND captured_event IS NOT NULL AND sender IS NOT NULL));
CREATE INDEX whatsapp_conversation_inbox_captured ON whatsapp_conversation_inbox(received_order)
 WHERE decision='captured';

-- Admission cannot acquire a FK KEY SHARE lock on the account: processing
-- already holds that account FOR UPDATE. Authority is frozen from the registry
-- here, then revalidated when materializing the normal tenant-owned inbox.
CREATE TABLE whatsapp_conversation_captures (
 instance_key text NOT NULL,
 message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 200),
 assinatura_id bigint NOT NULL,
 owner_epoch uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL DEFAULT 'captured',
 sender text NOT NULL,
 event_timestamp bigint,
 received_at timestamptz NOT NULL,
 received_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 capture_context jsonb NOT NULL CHECK(jsonb_typeof(capture_context)='object'),
 captured_event jsonb CHECK(captured_event IS NULL OR jsonb_typeof(captured_event)='object'),
 CHECK(decision<>'captured' OR captured_event IS NOT NULL),
 PRIMARY KEY(instance_key,message_id)
);
CREATE INDEX whatsapp_conversation_captures_pending ON whatsapp_conversation_captures(received_order)
 WHERE decision='captured';

-- A replay cannot refresh the question observed by the original admission.
-- Payload is transient, but the immutable observation/digest survives cleanup.
CREATE FUNCTION studiofy_conversation_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.capture_context IS NOT NULL AND (
  ROW(NEW.instance_key,NEW.message_id,NEW.assinatura_id,NEW.owner_epoch,NEW.sender,
      NEW.fingerprint,NEW.received_order,NEW.received_at,NEW.event_timestamp,NEW.capture_context)
  IS DISTINCT FROM
  ROW(OLD.instance_key,OLD.message_id,OLD.assinatura_id,OLD.owner_epoch,OLD.sender,
      OLD.fingerprint,OLD.received_order,OLD.received_at,OLD.event_timestamp,OLD.capture_context)
  OR (NEW.captured_event IS NOT NULL AND NEW.captured_event IS DISTINCT FROM OLD.captured_event)) THEN
  RAISE EXCEPTION 'Conversation admission is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.capture_context IS NOT NULL AND NEW.decision IN ('captured','awaiting_delivery') AND NEW.captured_event IS NULL THEN
  RAISE EXCEPTION 'Active admission requires its original event' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_conversation_capture_guard BEFORE UPDATE ON whatsapp_conversation_inbox
 FOR EACH ROW EXECUTE FUNCTION studiofy_conversation_capture_guard();
CREATE TRIGGER studiofy_conversation_admission_guard BEFORE UPDATE ON whatsapp_conversation_captures
 FOR EACH ROW EXECUTE FUNCTION studiofy_conversation_capture_guard();

-- Backfill only after DDL: populated 021 tables have deferred FK triggers.
UPDATE whatsapp_conversations SET question_started_at=updated_at;
UPDATE whatsapp_conversation_responses r SET question_id=c.question_id
 FROM whatsapp_conversations c WHERE c.last_response_id=r.delivery_id AND c.id=r.conversation_id
 AND c.assinatura_id=r.assinatura_id AND c.owner_epoch=r.owner_epoch;
