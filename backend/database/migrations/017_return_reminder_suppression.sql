-- Bind identifiers to the runner's installation schema, never to a caller path.
DO $studiofy_install$
DECLARE installed_schema TEXT := pg_catalog.current_schema();
BEGIN
 EXECUTE pg_catalog.replace(pg_catalog.replace($studiofy_ddl$
-- Only persistence/suppression. No historical opportunity creation or delivery.
-- Lock protocol: acquire group BEFORE locking/updating its reminders. Never acquire
-- Agenda/global/appointment locks while holding this group lock in a future dispatcher.
-- A future dispatcher must retain the same exclusive session lock through durable
-- dispatch intent and HTTP result; this stage implements neither dispatcher nor HTTP.
CREATE FUNCTION @@SCHEMA@@.studiofy_return_group_key(tenant BIGINT, customer TEXT, service_key TEXT)
RETURNS BIGINT LANGUAGE plpgsql STABLE SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
BEGIN
 IF tenant IS NULL OR tenant<=0 OR customer IS NULL OR customer !~ '^[a-f0-9]{64}$'
   OR service_key IS NULL OR service_key !~ '^service:[1-9][0-9]*$' THEN
  RAISE EXCEPTION 'Invalid return group' USING ERRCODE='23514';
 END IF;
 RETURN hashtextextended(@@SCHEMA_LITERAL@@ || ':return-group:v1:' || tenant::text || ':' || customer || ':' || service_key,0);
END $$;
CREATE FUNCTION @@SCHEMA@@.studiofy_return_group_lock(tenant BIGINT, customer TEXT, service_key TEXT)
RETURNS VOID LANGUAGE plpgsql VOLATILE SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(@@SCHEMA@@.studiofy_return_group_key(tenant,customer,service_key));
END $$;
CREATE FUNCTION @@SCHEMA@@.studiofy_return_group_locked(tenant BIGINT, customer TEXT, service_key TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
DECLARE lock_key BIGINT;
BEGIN
 lock_key := @@SCHEMA@@.studiofy_return_group_key(tenant,customer,service_key);
 RETURN EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
   AND granted AND mode='ExclusiveLock' AND objsubid=1
   AND classid::bigint=((lock_key >> 32) & 4294967295::bigint)
   AND objid::bigint=(lock_key & 4294967295::bigint));
END $$;

CREATE FUNCTION @@SCHEMA@@.studiofy_return_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
BEGIN
 -- Never wait for a group lock from a row trigger: an uncoordinated writer fails
 -- immediately instead of introducing a reminder-row/group lock inversion.
 IF NOT @@SCHEMA@@.studiofy_return_group_locked(NEW.assinatura_id,NEW.customer_key,NEW.service_identity) THEN
  RAISE EXCEPTION 'Return group lock required before mutation' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  -- Allow the transition INTO a terminal state; freeze every persisted column
  -- thereafter, including claims, delivery evidence, retry counters and timestamps.
  IF OLD.status IN ('sent','suppressed','cancelled','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Terminal return record is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.status IN ('pending','processing') AND EXISTS (
  SELECT 1 FROM @@SCHEMA@@.return_reminders r WHERE r.assinatura_id=NEW.assinatura_id AND r.customer_key=NEW.customer_key
    AND r.service_identity=NEW.service_identity AND (r.completed_at,r.appointment_id)>(NEW.completed_at,NEW.appointment_id)
 ) THEN
  RAISE EXCEPTION 'Superseded return cannot become eligible' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_return_state_guard BEFORE INSERT OR UPDATE ON @@SCHEMA@@.return_reminders
FOR EACH ROW EXECUTE FUNCTION @@SCHEMA@@.studiofy_return_state_guard();

CREATE FUNCTION @@SCHEMA@@.studiofy_return_supersede_group(tenant BIGINT, customer TEXT, service_key TEXT)
RETURNS INTEGER LANGUAGE plpgsql VOLATILE SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
DECLARE latest_time TIMESTAMPTZ; latest_appointment BIGINT; changed INTEGER;
BEGIN
 PERFORM @@SCHEMA@@.studiofy_return_group_lock(tenant,customer,service_key);
 SELECT completed_at,appointment_id INTO latest_time,latest_appointment FROM @@SCHEMA@@.return_reminders
 WHERE assinatura_id=tenant AND customer_key=customer AND service_identity=service_key
 ORDER BY completed_at DESC,appointment_id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN 0; END IF;
 UPDATE @@SCHEMA@@.return_reminders SET
  status=CASE WHEN status='processing' AND dispatch_started_at IS NOT NULL THEN 'uncertain' ELSE 'suppressed' END,
  reason_code=CASE WHEN status='processing' AND dispatch_started_at IS NOT NULL THEN 'delivery_uncertain' ELSE 'newer_completion' END,
  claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
 WHERE assinatura_id=tenant AND customer_key=customer AND service_identity=service_key
   AND status IN ('pending','processing') AND (completed_at,appointment_id)<(latest_time,latest_appointment);
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed;
END $$;
CREATE FUNCTION @@SCHEMA@@.studiofy_return_supersede_insert() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
BEGIN
 PERFORM @@SCHEMA@@.studiofy_return_supersede_group(NEW.assinatura_id,NEW.customer_key,NEW.service_identity);
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_return_supersede_insert AFTER INSERT ON @@SCHEMA@@.return_reminders
FOR EACH ROW EXECUTE FUNCTION @@SCHEMA@@.studiofy_return_supersede_insert();

CREATE OR REPLACE FUNCTION @@SCHEMA@@.studiofy_return_opportunity_create() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
DECLARE phone TEXT; due TIMESTAMPTZ; customer TEXT; service_key TEXT;
BEGIN
 -- Legacy/missing catalog references and invalid contacts do not authorize a message.
 phone := @@SCHEMA@@.studiofy_return_phone(NEW.telefone);
 IF NEW.assinatura_id IS NULL OR NEW.studio_service_id IS NULL OR phone IS NULL
   OR NEW.nome_cliente IS NULL OR length(btrim(NEW.nome_cliente)) NOT BETWEEN 2 AND 100
   OR NEW.servico_nome IS NULL OR length(btrim(NEW.servico_nome)) NOT BETWEEN 1 AND 100
   OR NOT EXISTS (SELECT 1 FROM @@SCHEMA@@.servicos_assinatura WHERE id=NEW.studio_service_id AND assinatura_id=NEW.assinatura_id) THEN
  RETURN NEW;
 END IF;
 customer := @@SCHEMA@@.studiofy_return_customer_key(NEW.assinatura_id,phone);
 service_key := 'service:' || NEW.studio_service_id::text;
 PERFORM @@SCHEMA@@.studiofy_return_group_lock(NEW.assinatura_id,customer,service_key);
 due := ((NEW.completed_at AT TIME ZONE 'America/Sao_Paulo') + interval '7 days') AT TIME ZONE 'America/Sao_Paulo';
 INSERT INTO @@SCHEMA@@.return_reminders(assinatura_id,appointment_id,service_identity,customer_key,
   customer_name_snapshot,phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at)
 VALUES (NEW.assinatura_id,NEW.id,'service:' || NEW.studio_service_id::text,
   @@SCHEMA@@.studiofy_return_customer_key(NEW.assinatura_id,phone),NEW.nome_cliente,phone,NEW.servico_nome,NEW.completed_at,due,due)
 ON CONFLICT (assinatura_id,appointment_id) DO NOTHING;
 RETURN NEW;
END $$;

-- The administrative account deletion flow removes appointments before the account.
-- Check at COMMIT so its cascades work, but deleting/recreating an operational
-- reminder cannot erase idempotency evidence while its establishment survives.
CREATE FUNCTION @@SCHEMA@@.studiofy_return_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, @@SCHEMA@@, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM @@SCHEMA@@.assinaturas WHERE id=OLD.assinatura_id) THEN
  RAISE EXCEPTION 'Return history requires complete account deletion' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE CONSTRAINT TRIGGER studiofy_return_delete_guard AFTER DELETE ON @@SCHEMA@@.return_reminders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION @@SCHEMA@@.studiofy_return_delete_guard();

$studiofy_ddl$, '@@SCHEMA_LITERAL@@', pg_catalog.quote_literal(installed_schema)),
 '@@SCHEMA@@', pg_catalog.quote_ident(installed_schema));
END $studiofy_install$;
