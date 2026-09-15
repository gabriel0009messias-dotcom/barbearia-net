-- Only pending standard-plan records with NO checkout/payment evidence qualify.
-- Even expired orders can have an approved payment whose webhook is still in transit.
-- Such records require reconciliation before repricing; never expire or clear them here.
ALTER TABLE assinaturas ALTER COLUMN valor_mensal SET DEFAULT 65;
ALTER TABLE assinaturas ALTER COLUMN valor_plano SET DEFAULT 65;

UPDATE assinaturas AS a
  SET valor_mensal = 65,
      valor_plano = 65,
      updated_at = CURRENT_TIMESTAMP
  WHERE lower(trim(a.plano)) = 'plano profissional'
    AND lower(trim(a.status)) = 'pendente'
    AND lower(trim(a.status_assinatura)) = 'pendente'
    AND a.valor_mensal IN (50, 60, 65)
    AND a.valor_plano IN (50, 60, 65)
    AND coalesce(trim(a.ultimo_pagamento), '') = ''
    AND coalesce(trim(a.payment_id), '') = ''
    AND coalesce(trim(a.subscription_id), '') = ''
    AND coalesce(trim(a.mercado_preapproval_id), '') = ''
    AND coalesce(trim(a.observacoes), '') = ''
    AND coalesce(trim(a.gateway_checkout_url), '') = ''
    AND coalesce(trim(a.gateway_external_reference), '') = ''
    AND coalesce(trim(a.mercado_last_payload), '') = ''
    AND coalesce(trim(a.notification_history), '') = ''
    AND lower(coalesce(trim(a.gateway_status), '')) IN ('', 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM mercado_pago_payments p WHERE p.assinatura_id = a.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM mercado_pago_orders o WHERE o.assinatura_id = a.id
    )
    AND (a.valor_mensal <> 65 OR a.valor_plano <> 65);
-- A direct second execution cannot touch corrected rows, timestamps or new checkouts.
-- All order/payment rows, IDs, URLs and expiration dates remain intact.
