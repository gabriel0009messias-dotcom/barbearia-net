-- One durable checkout intention per account; historical orders are preserved.
CREATE UNIQUE INDEX mercado_pago_order_account_reference ON mercado_pago_orders(assinatura_id, reference);
CREATE TABLE mercado_pago_checkout_intents (
  assinatura_id BIGINT PRIMARY KEY REFERENCES assinaturas(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('sending', 'uncertain', 'ready')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assinatura_id, order_reference)
    REFERENCES mercado_pago_orders(assinatura_id, reference) ON DELETE CASCADE
);

-- Immutable application identity and evidence of the credited period.
ALTER TABLE mercado_pago_payments ADD COLUMN period_base TEXT;
ALTER TABLE mercado_pago_payments ADD COLUMN period_ends TEXT;
CREATE FUNCTION mercado_pago_payment_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.order_reference IS DISTINCT FROM OLD.order_reference
     OR NEW.assinatura_id IS DISTINCT FROM OLD.assinatura_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR (OLD.credited_at IS NOT NULL AND (
       NEW.credited_at IS DISTINCT FROM OLD.credited_at
       OR NEW.period_base IS DISTINCT FROM OLD.period_base
       OR NEW.period_ends IS DISTINCT FROM OLD.period_ends)) THEN
    RAISE EXCEPTION 'Payment identity and credited period are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mercado_pago_payment_identity_guard BEFORE UPDATE ON mercado_pago_payments
  FOR EACH ROW EXECUTE FUNCTION mercado_pago_payment_identity_guard();
