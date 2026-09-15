-- Enforce ownership for future writes, including writes racing with account deletion.
-- NOT VALID preserves imported historical data; no existing rows are deleted or rewritten.
DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['mercado_pago_orders', 'mercado_pago_payments', 'whatsapp_messages']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = target_table::regclass AND conname = target_table || '_account_fk'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (assinatura_id) REFERENCES assinaturas(id) DEFERRABLE INITIALLY DEFERRED NOT VALID',
        target_table, target_table || '_account_fk');
    END IF;
  END LOOP;
END $$;
