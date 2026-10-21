-- Receipt facts remain append-only; no existing delivery or receipt is changed.
-- This ALTER takes ACCESS EXCLUSIVE on the small receipts table, not the outbox.
-- Fail rather than wait indefinitely for a conflicting production transaction.
SET LOCAL lock_timeout = '2s';
ALTER TABLE evolution_delivery_reconciliations
 ADD COLUMN instance_name text,
 ADD COLUMN previous_last_error text,
 DROP CONSTRAINT evolution_delivery_reconciliations_outcome_check,
 ADD CONSTRAINT evolution_delivery_reconciliations_outcome_check
 CHECK(outcome IN ('accepted','rejected','not_accepted','abandoned_unknown')) NOT VALID,
 ADD CONSTRAINT evolution_delivery_unknown_instance_check
 CHECK(outcome <> 'abandoned_unknown' OR (instance_name IS NOT NULL AND length(instance_name)>0)) NOT VALID;
ALTER TABLE evolution_delivery_reconciliations
 VALIDATE CONSTRAINT evolution_delivery_reconciliations_outcome_check;
ALTER TABLE evolution_delivery_reconciliations
 VALIDATE CONSTRAINT evolution_delivery_unknown_instance_check;
-- The terminal administrative disposition is unique across all operation tokens
-- for this delivery; also supports the legacy/null-token resurrection check.
CREATE UNIQUE INDEX evolution_delivery_unknown_terminal
 ON evolution_delivery_reconciliations(delivery_kind,delivery_id,assinatura_id)
 WHERE outcome='abandoned_unknown';
