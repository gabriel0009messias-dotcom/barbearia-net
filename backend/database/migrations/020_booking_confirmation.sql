-- Only new public bookings opt in. Historical rows remain NULL: no backfill.
-- The snapshot stores an immutable phone_state (routable/invalid/missing).
-- telefone is ONLY the canonical safe destination, otherwise JSON null.
ALTER TABLE public_booking_access ADD COLUMN confirmation_snapshot jsonb;
ALTER TABLE public_booking_access ADD COLUMN confirmation_materialized_at timestamptz;
ALTER TABLE public_booking_access ADD COLUMN confirmation_blocked_reason text
 CHECK (confirmation_blocked_reason IN ('invalid_phone','instance_not_configured','instance_invalid','invalid_snapshot','appointment_changed'));
ALTER TABLE public_booking_access ADD CONSTRAINT booking_confirmation_snapshot_shape
 CHECK (confirmation_snapshot IS NULL OR (jsonb_typeof(confirmation_snapshot)='object'
  AND confirmation_snapshot->>'appointment_id'=appointment_id::text
  AND confirmation_snapshot ?& ARRAY['appointment_id','assinatura_id','cliente','telefone','phone_state','servico','preco','data','hora','estabelecimento','instance']
  AND COALESCE((confirmation_snapshot->>'phone_state'='routable'
    AND jsonb_typeof(confirmation_snapshot->'telefone')='string'
    AND confirmation_snapshot->>'telefone' ~ '^55[1-9]{2}([2-5][0-9]{7}|9[0-9]{8})$')
   OR (confirmation_snapshot->>'phone_state' IN ('invalid','missing')
    AND confirmation_snapshot->'telefone'='null'::jsonb),false)));

-- A historical origin ID, retained even if a reservation/access capability is
-- removed. Deleting a capability must not delete an uncertain transport or its
-- reconciliation evidence. This is the existing outbox, not another queue.
ALTER TABLE whatsapp_messages ADD COLUMN booking_confirmation_appointment_id bigint
 CHECK (booking_confirmation_appointment_id>0);
CREATE UNIQUE INDEX booking_confirmation_once ON whatsapp_messages(booking_confirmation_appointment_id)
 WHERE booking_confirmation_appointment_id IS NOT NULL;
ALTER TABLE whatsapp_messages ADD CONSTRAINT booking_confirmation_logical_key
 CHECK (booking_confirmation_appointment_id IS NULL OR
  message_id='booking_confirmation:'||booking_confirmation_appointment_id::text);

CREATE FUNCTION studiofy_booking_confirmation_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.confirmation_snapshot IS NOT NULL AND NEW.confirmation_snapshot IS DISTINCT FROM OLD.confirmation_snapshot THEN
  RAISE EXCEPTION 'Booking confirmation snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.confirmation_materialized_at IS NOT NULL AND NEW.confirmation_materialized_at IS DISTINCT FROM OLD.confirmation_materialized_at THEN
  RAISE EXCEPTION 'Booking confirmation origin already materialized' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_booking_confirmation_snapshot_guard BEFORE UPDATE ON public_booking_access
 FOR EACH ROW EXECUTE FUNCTION studiofy_booking_confirmation_snapshot_guard();

CREATE FUNCTION studiofy_booking_confirmation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.booking_confirmation_appointment_id IS NOT NULL AND
  ROW(NEW.booking_confirmation_appointment_id,NEW.assinatura_id,NEW.instance,NEW.phone,NEW.message_id,NEW.response)
  IS DISTINCT FROM ROW(OLD.booking_confirmation_appointment_id,OLD.assinatura_id,OLD.instance,OLD.phone,OLD.message_id,OLD.response) THEN
  RAISE EXCEPTION 'Booking confirmation delivery identity is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.booking_confirmation_appointment_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.booking_confirmation_appointment_id IS NULL) AND NOT EXISTS (
  SELECT 1 FROM public_booking_access p JOIN agendamentos a ON a.id=p.appointment_id
  WHERE a.id=NEW.booking_confirmation_appointment_id AND a.assinatura_id=NEW.assinatura_id
   AND p.confirmation_snapshot->>'assinatura_id'=a.assinatura_id::text
   AND p.confirmation_snapshot->>'instance'=NEW.instance
   AND p.confirmation_snapshot->>'phone_state'='routable'
   AND p.confirmation_snapshot->>'telefone'=NEW.phone
 ) THEN
  RAISE EXCEPTION 'Booking confirmation owner mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_booking_confirmation_identity_guard BEFORE INSERT OR UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION studiofy_booking_confirmation_identity_guard();
