-- Additive conversational state only. No historical sessions or bookings copied.
-- Association identity survives process restarts and changes on reassociation.
-- A first installation may have just backfilled 018 in this same transaction.
-- Validate its deferred ownership events BEFORE DDL, without disabling guards.
-- Restore the runner's deferred mode immediately after flushing valid events.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE evolution_instance_owners ADD COLUMN conversation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION studiofy_conversation_owner_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
 IF ROW(NEW.instance_key,NEW.instance_name,NEW.model,NEW.source_schema,NEW.owner_id)
    IS DISTINCT FROM ROW(OLD.instance_key,OLD.instance_name,OLD.model,OLD.source_schema,OLD.owner_id) THEN
  NEW.conversation_epoch=gen_random_uuid();
 ELSIF NEW.conversation_epoch IS DISTINCT FROM OLD.conversation_epoch THEN
  RAISE EXCEPTION 'Conversation ownership epoch is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_conversation_owner_epoch BEFORE UPDATE ON evolution_instance_owners
 FOR EACH ROW EXECUTE FUNCTION studiofy_conversation_owner_epoch();

ALTER TABLE whatsapp_messages ADD COLUMN conversation_managed boolean NOT NULL DEFAULT false;
CREATE FUNCTION studiofy_conversation_response_marker() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
 IF NEW.conversation_managed IS DISTINCT FROM OLD.conversation_managed THEN
  RAISE EXCEPTION 'Conversation response marker is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_conversation_response_marker BEFORE UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION studiofy_conversation_response_marker();

CREATE TABLE whatsapp_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 assinatura_id bigint NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
 instance_key text NOT NULL,
 owner_epoch uuid NOT NULL,
 sender text NOT NULL CHECK(sender ~ '^55[1-9]{2}([2-5][0-9]{7}|9[0-9]{8})$'),
 state jsonb NOT NULL DEFAULT '{"step":"MENU"}' CHECK(jsonb_typeof(state)='object'),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 reference text NOT NULL CHECK(reference ~ '^[a-f0-9]{16}$'),
 last_response_id bigint REFERENCES whatsapp_messages(id) DEFERRABLE INITIALLY DEFERRED,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(assinatura_id,instance_key,sender),
 UNIQUE(assinatura_id,id)
);
CREATE INDEX whatsapp_conversations_expiry ON whatsapp_conversations(expires_at);

CREATE TABLE whatsapp_conversation_responses (
 delivery_id bigint PRIMARY KEY REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
 assinatura_id bigint NOT NULL,
 conversation_id uuid NOT NULL,
 owner_epoch uuid NOT NULL,
 reference text NOT NULL,
 provider_message_id text CHECK(length(provider_message_id) BETWEEN 1 AND 200),
 FOREIGN KEY(assinatura_id,conversation_id) REFERENCES whatsapp_conversations(assinatura_id,id)
   ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- Keep durable deduplication receipts even when a draft expires/restarts.
-- Instance + provider ID is also unique across ownership generations, preventing
-- a delayed old event from being replayed against a newly associated tenant.
CREATE TABLE whatsapp_conversation_inbox (
 instance_key text NOT NULL,
 message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 200),
 assinatura_id bigint NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
 owner_epoch uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL,
 received_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 sender text,
 conversation_id uuid,
 expected_version bigint,
 expected_reference text,
 expected_response_id bigint,
 expected_step text,
 event_timestamp bigint,
 pending_event jsonb,
 pending_at timestamptz,
 completed_at timestamptz,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (pending_event IS NULL OR (jsonb_typeof(pending_event)='object' AND decision='awaiting_delivery')),
 CHECK (decision<>'awaiting_delivery' OR (
   pending_event IS NOT NULL AND sender IS NOT NULL AND conversation_id IS NOT NULL
   AND expected_version IS NOT NULL AND expected_version>=0
   AND expected_reference ~ '^[a-f0-9]{16}$' AND expected_reference IS NOT NULL
   AND expected_response_id IS NOT NULL AND expected_step IS NOT NULL
   AND pending_at IS NOT NULL AND completed_at IS NULL)),
 PRIMARY KEY(instance_key,message_id)
);
-- Correlation snapshots intentionally have no cascading FK: retain deduplication
-- and terminal evidence if a draft or delivery is deleted. Payload is cleared
-- atomically when the pending input reaches a terminal decision.
CREATE INDEX whatsapp_conversation_inbox_pending ON whatsapp_conversation_inbox(received_order)
 WHERE decision='awaiting_delivery';

CREATE TABLE whatsapp_conversation_actions (
 id uuid PRIMARY KEY,
 assinatura_id bigint NOT NULL,
 conversation_id uuid NOT NULL,
 owner_epoch uuid NOT NULL,
 sender text NOT NULL,
 booking_key text NOT NULL UNIQUE CHECK(booking_key ~ '^[a-f0-9]{64}$'),
 booking_body jsonb NOT NULL CHECK(jsonb_typeof(booking_body)='object'),
 appointment_id bigint UNIQUE REFERENCES agendamentos(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(assinatura_id,conversation_id) REFERENCES whatsapp_conversations(assinatura_id,id)
   ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX whatsapp_conversation_action_identity ON whatsapp_conversation_actions(assinatura_id,sender,owner_epoch);
