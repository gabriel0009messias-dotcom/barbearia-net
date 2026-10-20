-- Preserve exact provider PN digits and all existing rows; no alias conversion.
-- Drain deferred correlation checks before DDL in the migration transaction.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$
DECLARE previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
PERFORM set_config('lock_timeout', '3s', true);
ALTER TABLE whatsapp_conversations DROP CONSTRAINT whatsapp_conversations_sender_check;
ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_sender_check
 CHECK(sender ~ '^55[1-9]{2}([2-9][0-9]{7}|9[0-9]{8})$');
ALTER TABLE clientes DROP CONSTRAINT customer_tenant_phone;
ALTER TABLE clientes ADD CONSTRAINT customer_tenant_phone CHECK (assinatura_id IS NULL OR
 (telefone IS NOT NULL AND telefone ~ '^55[1-9]{2}([2-9][0-9]{7}|9[0-9]{8})$'));
-- Public snapshots remain strict; the provider branch carries a durable action.
ALTER TABLE public_booking_access DROP CONSTRAINT booking_confirmation_snapshot_shape;
ALTER TABLE public_booking_access ADD CONSTRAINT booking_confirmation_snapshot_shape
 CHECK (confirmation_snapshot IS NULL OR (jsonb_typeof(confirmation_snapshot)='object'
  AND confirmation_snapshot->>'appointment_id'=appointment_id::text
  AND confirmation_snapshot ?& ARRAY['appointment_id','assinatura_id','cliente','telefone','phone_state','servico','preco','data','hora','estabelecimento','instance']
  AND COALESCE((confirmation_snapshot->>'phone_state'='routable'
    AND jsonb_typeof(confirmation_snapshot->'telefone')='string'
    AND (confirmation_snapshot->>'telefone' ~ '^55[1-9]{2}([2-5][0-9]{7}|9[0-9]{8})$'
     OR (confirmation_snapshot->>'phone_identity'='whatsapp'
      AND confirmation_snapshot->>'conversation_action_id' ~ '^[a-f0-9-]{36}$'
      AND confirmation_snapshot->>'telefone' ~ '^55[1-9]{2}([2-9][0-9]{7}|9[0-9]{8})$')))
   OR (confirmation_snapshot->>'phone_state' IN ('invalid','missing')
    AND confirmation_snapshot->'telefone'='null'::jsonb),false)));
PERFORM set_config('lock_timeout', previous_lock_timeout, true);
END $$;
