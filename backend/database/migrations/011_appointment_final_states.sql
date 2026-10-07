-- Preserve finalized appointment facts even when an older writer bypasses the HTTP service.
-- Reminder delivery metadata may still change; account deletion remains a separate authorized flow.
CREATE FUNCTION studiofy_final_appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('concluido', 'cancelado', 'falta') AND
  ROW(NEW.assinatura_id, NEW.cliente_id, NEW.servico_id, NEW.nome_cliente, NEW.telefone,
      NEW.servico_nome, NEW.preco, NEW.data, NEW.hora, NEW.status,
      NEW.profissional_id, NEW.duracao, NEW.studio_service_id)
  IS DISTINCT FROM
  ROW(OLD.assinatura_id, OLD.cliente_id, OLD.servico_id, OLD.nome_cliente, OLD.telefone,
      OLD.servico_nome, OLD.preco, OLD.data, OLD.hora, OLD.status,
      OLD.profissional_id, OLD.duracao, OLD.studio_service_id) THEN
  RAISE EXCEPTION 'Finalized appointment cannot be changed' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER studiofy_final_appointment_guard
 BEFORE UPDATE ON agendamentos FOR EACH ROW
 EXECUTE FUNCTION studiofy_final_appointment_guard();
