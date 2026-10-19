-- Extend the official customer model. Global legacy rows remain unassigned.
ALTER TABLE clientes ADD COLUMN assinatura_id bigint REFERENCES assinaturas(id) ON DELETE CASCADE;
ALTER TABLE clientes ADD COLUMN created_at timestamptz;
ALTER TABLE clientes ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE clientes ADD COLUMN updated_at timestamptz;
ALTER TABLE clientes ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE clientes ADD CONSTRAINT customer_tenant_phone CHECK (assinatura_id IS NULL OR
 (telefone IS NOT NULL AND telefone ~ '^55[1-9]{2}([2-5][0-9]{7}|9[0-9]{8})$'));
CREATE UNIQUE INDEX customer_tenant_phone_once ON clientes(assinatura_id,telefone) WHERE assinatura_id IS NOT NULL;

ALTER TABLE agendamentos ADD COLUMN origem text CHECK(origem IS NULL OR origem='whatsapp');
ALTER TABLE agendamentos ADD COLUMN observacao text CHECK(observacao IS NULL OR length(observacao)<=500);

CREATE FUNCTION studiofy_customer_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.assinatura_id IS NOT NULL AND ROW(NEW.assinatura_id,NEW.telefone) IS DISTINCT FROM ROW(OLD.assinatura_id,OLD.telefone) THEN
  RAISE EXCEPTION 'Customer identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_customer_identity_guard BEFORE UPDATE ON clientes
 FOR EACH ROW EXECUTE FUNCTION studiofy_customer_identity_guard();

CREATE FUNCTION studiofy_appointment_customer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant bigint;
BEGIN
 IF NEW.cliente_id IS NOT NULL THEN
  SELECT assinatura_id INTO tenant FROM clientes WHERE id=NEW.cliente_id;
  IF tenant IS NOT NULL AND tenant IS DISTINCT FROM NEW.assinatura_id THEN
   RAISE EXCEPTION 'Appointment customer tenant mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('concluido','cancelado','falta')
  AND ROW(NEW.origem,NEW.observacao) IS DISTINCT FROM ROW(OLD.origem,OLD.observacao) THEN
  RAISE EXCEPTION 'Final appointment metadata is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_appointment_customer_guard BEFORE INSERT OR UPDATE ON agendamentos
 FOR EACH ROW EXECUTE FUNCTION studiofy_appointment_customer_guard();
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION studiofy_appointment_customer_guard() SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;
