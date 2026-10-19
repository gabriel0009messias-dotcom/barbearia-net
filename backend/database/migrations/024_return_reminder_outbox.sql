-- Return business facts stay in return_reminders. Only whatsapp_messages owns delivery.
-- No historical name backfill, delivery replay, or modification of the shared delivery protocol.
ALTER TABLE agendamentos ADD COLUMN return_history_snapshot jsonb;
ALTER TABLE return_reminders ADD COLUMN transport_protocol text NOT NULL DEFAULT 'legacy_simulated'
 CHECK(transport_protocol IN ('legacy_simulated','outbox_v1'));
ALTER TABLE return_reminders ADD COLUMN historical_snapshot_status text NOT NULL DEFAULT 'unavailable_legacy'
 CHECK(historical_snapshot_status IN ('unavailable_legacy','unavailable_at_completion','captured'));
ALTER TABLE return_reminders ADD COLUMN historical_snapshot_at timestamptz;
ALTER TABLE return_reminders ADD COLUMN snapshot_version smallint;
ALTER TABLE return_reminders ADD COLUMN superseded_at timestamptz;
ALTER TABLE return_reminders ADD COLUMN establishment_name_snapshot text;
ALTER TABLE return_reminders ADD COLUMN materialized_at timestamptz;
ALTER TABLE return_reminders ADD CONSTRAINT return_tenant_identity UNIQUE(assinatura_id,id);
ALTER TABLE return_reminders ADD CONSTRAINT return_outbox_source_shape CHECK(
 (transport_protocol='legacy_simulated' AND historical_snapshot_status='unavailable_legacy'
  AND establishment_name_snapshot IS NULL AND materialized_at IS NULL) OR
 (transport_protocol='outbox_v1' AND historical_snapshot_at IS NOT NULL AND snapshot_version IS NOT NULL AND snapshot_version=1
  AND ((historical_snapshot_status='captured' AND establishment_name_snapshot IS NOT NULL AND length(btrim(establishment_name_snapshot)) BETWEEN 1 AND 200)
   OR (historical_snapshot_status='unavailable_at_completion' AND establishment_name_snapshot IS NULL))
  AND status IN ('pending','suppressed','cancelled') AND attempts=0
  AND claim_token IS NULL AND claimed_at IS NULL AND lease_until IS NULL
  AND dispatch_started_at IS NULL AND provider_message_id IS NULL AND sent_at IS NULL));

ALTER TABLE whatsapp_messages ADD COLUMN return_reminder_id bigint;
ALTER TABLE whatsapp_messages ADD COLUMN return_owner_epoch uuid;
ALTER TABLE whatsapp_messages ADD COLUMN return_cancel_requested_at timestamptz;
ALTER TABLE whatsapp_messages ADD CONSTRAINT return_outbox_source_fk
 FOREIGN KEY(assinatura_id,return_reminder_id) REFERENCES return_reminders(assinatura_id,id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX return_outbox_once ON whatsapp_messages(return_reminder_id) WHERE return_reminder_id IS NOT NULL;
ALTER TABLE whatsapp_messages ADD CONSTRAINT return_outbox_identity CHECK(
 (return_reminder_id IS NULL AND return_owner_epoch IS NULL AND return_cancel_requested_at IS NULL AND message_id NOT LIKE 'return_reminder:%') OR
 (return_reminder_id IS NOT NULL AND return_reminder_id>0 AND return_owner_epoch IS NOT NULL AND NOT conversation_managed
  AND booking_confirmation_appointment_id IS NULL AND message_id='return_reminder:'||return_reminder_id::text));
CREATE INDEX return_outbox_materialization ON return_reminders(next_attempt_at,id)
 WHERE transport_protocol='outbox_v1' AND status='pending' AND materialized_at IS NULL;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM configuracoes WHERE chave='return_outbox_delivery_enabled' AND valor IS DISTINCT FROM 'false') THEN
  RAISE EXCEPTION 'Return delivery activation requires explicit post-installation approval';
 END IF;
END $$;
-- Missing configuration is deliberately FALSE. Do not seed another catalog row:
-- the legacy importer must still recognize a newly migrated, empty destination.
-- Activation requires explicitly persisting this key with valor='true'.

CREATE FUNCTION studiofy_return_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT clock_timestamp()$$;
CREATE FUNCTION studiofy_return_delivery_open() RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM configuracoes WHERE chave='return_outbox_delivery_enabled' AND valor='true')
 AND (studiofy_return_now() AT TIME ZONE 'America/Sao_Paulo')::time >= time '09:00'
 AND (studiofy_return_now() AT TIME ZONE 'America/Sao_Paulo')::time < time '18:00'
$$;
CREATE FUNCTION studiofy_return_plain(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT left(btrim(regexp_replace(regexp_replace(value,
  '[<>[:cntrl:]'||chr(8234)||'-'||chr(8238)||chr(8294)||'-'||chr(8297)||']',' ','g'),'\s+',' ','g')),200)
$$;
-- Single canonical template: both producer and frontier consume this function.
CREATE FUNCTION studiofy_return_message_text(r return_reminders) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT 'Olá, '||studiofy_return_plain(r.customer_name_snapshot)||'! 😊'||chr(10)||chr(10)||
 'Já faz 7 dias desde seu atendimento de '||studiofy_return_plain(r.service_name_snapshot)||' no '||
 studiofy_return_plain(r.establishment_name_snapshot)||'.'||chr(10)||chr(10)||'Que tal agendar novamente?'
$$;

CREATE OR REPLACE FUNCTION studiofy_return_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE moment timestamptz; establishment text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.completed_at IS NOT NULL OR NEW.return_history_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Completion facts are server controlled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.assinatura_id IS DISTINCT FROM NEW.assinatura_id THEN
  RAISE EXCEPTION 'Appointment owner is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.return_history_snapshot IS DISTINCT FROM OLD.return_history_snapshot THEN
  RAISE EXCEPTION 'Completion snapshot is server controlled' USING ERRCODE='23514';
 END IF;
 IF NEW.status='concluido' AND OLD.status='confirmado' THEN
  moment:=clock_timestamp();
  IF NEW.data IS NULL OR NEW.hora IS NULL OR NEW.data !~ '^\d{4}-\d{2}-\d{2}$'
   OR NEW.hora !~ '^([01]\d|2[0-3]):[0-5]\d$'
   OR ((NEW.data||' '||NEW.hora)::timestamp AT TIME ZONE 'America/Sao_Paulo')>moment THEN
   RAISE EXCEPTION 'Future or invalid appointment cannot be completed' USING ERRCODE='23514';
  END IF;
  NEW.completed_at:=moment;
  SELECT barbearia_nome INTO establishment FROM assinaturas WHERE id=NEW.assinatura_id;
  IF establishment IS NULL OR length(btrim(establishment)) NOT BETWEEN 1 AND 200 THEN establishment:=NULL;END IF;
   NEW.return_history_snapshot:=jsonb_build_object('assinatura_id',NEW.assinatura_id::text,
    'appointment_id',NEW.id::text,'cliente',NEW.nome_cliente,'telefone',studiofy_return_phone(NEW.telefone),
    'service_id',NEW.studio_service_id::text,'servico',NEW.servico_nome,'estabelecimento',establishment,'completed_at',moment);
 ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
  RAISE EXCEPTION 'Completion timestamp is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION studiofy_return_opportunity_create() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phone text; due timestamptz; customer text; service_key text; snap jsonb;
BEGIN
 snap:=NEW.return_history_snapshot;phone:=studiofy_return_phone(NEW.telefone);
 IF snap IS NULL OR NEW.assinatura_id IS NULL OR NEW.studio_service_id IS NULL OR phone IS NULL
  OR NEW.nome_cliente IS NULL OR length(btrim(NEW.nome_cliente)) NOT BETWEEN 2 AND 100
  OR NEW.servico_nome IS NULL OR length(btrim(NEW.servico_nome)) NOT BETWEEN 1 AND 100
  OR NOT EXISTS(SELECT 1 FROM servicos_assinatura WHERE id=NEW.studio_service_id AND assinatura_id=NEW.assinatura_id) THEN RETURN NEW;END IF;
 customer:=studiofy_return_customer_key(NEW.assinatura_id,phone);service_key:='service:'||NEW.studio_service_id::text;
 PERFORM studiofy_return_group_lock(NEW.assinatura_id,customer,service_key);
 due:=((NEW.completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days') AT TIME ZONE 'America/Sao_Paulo';
 INSERT INTO return_reminders(assinatura_id,appointment_id,service_identity,customer_key,
  customer_name_snapshot,phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at,
  transport_protocol,historical_snapshot_status,establishment_name_snapshot,historical_snapshot_at,snapshot_version)
 VALUES(NEW.assinatura_id,NEW.id,service_key,customer,NEW.nome_cliente,phone,NEW.servico_nome,NEW.completed_at,due,due,
  'outbox_v1',CASE WHEN snap->>'estabelecimento' IS NULL THEN 'unavailable_at_completion' ELSE 'captured' END,
  snap->>'estabelecimento',NEW.completed_at,1) ON CONFLICT(assinatura_id,appointment_id) DO NOTHING;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION studiofy_return_opportunity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source agendamentos%ROWTYPE;phone text;snap jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.assinatura_id,NEW.appointment_id,NEW.service_identity,NEW.customer_key,NEW.customer_name_snapshot,
   NEW.phone_snapshot,NEW.service_name_snapshot,NEW.completed_at,NEW.eligible_at,NEW.transport_protocol,
   NEW.historical_snapshot_status,NEW.establishment_name_snapshot,NEW.historical_snapshot_at,NEW.snapshot_version)
   IS DISTINCT FROM ROW(OLD.assinatura_id,OLD.appointment_id,OLD.service_identity,OLD.customer_key,OLD.customer_name_snapshot,
   OLD.phone_snapshot,OLD.service_name_snapshot,OLD.completed_at,OLD.eligible_at,OLD.transport_protocol,
   OLD.historical_snapshot_status,OLD.establishment_name_snapshot,OLD.historical_snapshot_at,OLD.snapshot_version) THEN
   RAISE EXCEPTION 'Return opportunity facts are immutable' USING ERRCODE='23514';END IF;
  IF (OLD.materialized_at IS NOT NULL AND NEW.materialized_at IS DISTINCT FROM OLD.materialized_at)
   OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
   RAISE EXCEPTION 'Return materialization or supersession cannot be recycled' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO source FROM agendamentos WHERE id=NEW.appointment_id AND assinatura_id=NEW.assinatura_id;
 phone:=studiofy_return_phone(source.telefone);snap:=source.return_history_snapshot;
 IF source.id IS NULL OR source.status<>'concluido' OR source.completed_at IS NULL
  OR source.studio_service_id IS NULL OR phone IS NULL
  OR NEW.completed_at IS DISTINCT FROM source.completed_at
  OR NEW.service_identity IS DISTINCT FROM ('service:'||source.studio_service_id::text)
  OR NEW.customer_key IS DISTINCT FROM studiofy_return_customer_key(source.assinatura_id,phone)
  OR NEW.customer_name_snapshot IS DISTINCT FROM source.nome_cliente
  OR NEW.phone_snapshot IS DISTINCT FROM phone OR NEW.service_name_snapshot IS DISTINCT FROM source.servico_nome THEN
  RAISE EXCEPTION 'Return opportunity does not match completed appointment' USING ERRCODE='23514';
 END IF;
 IF NEW.transport_protocol='outbox_v1' THEN
  IF NEW.historical_snapshot_at IS DISTINCT FROM NEW.completed_at OR NEW.snapshot_version IS DISTINCT FROM 1
   OR NEW.historical_snapshot_status IS DISTINCT FROM (CASE WHEN snap->>'estabelecimento' IS NULL THEN 'unavailable_at_completion' ELSE 'captured' END)
   OR snap IS NULL OR snap->>'assinatura_id' IS DISTINCT FROM NEW.assinatura_id::text
   OR snap->>'appointment_id' IS DISTINCT FROM NEW.appointment_id::text
   OR snap->>'cliente' IS DISTINCT FROM NEW.customer_name_snapshot OR snap->>'telefone' IS DISTINCT FROM NEW.phone_snapshot
   OR snap->>'service_id' IS DISTINCT FROM source.studio_service_id::text OR snap->>'servico' IS DISTINCT FROM NEW.service_name_snapshot
   OR (snap->>'completed_at')::timestamptz IS DISTINCT FROM NEW.completed_at
   OR snap->>'estabelecimento' IS DISTINCT FROM NEW.establishment_name_snapshot THEN
   RAISE EXCEPTION 'Historical return snapshot mismatch' USING ERRCODE='23514';
  END IF;
 ELSIF TG_OP='INSERT' AND snap IS NOT NULL THEN
  RAISE EXCEPTION 'New completion cannot adopt legacy protocol' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.dispatch_started_at IS NOT NULL
  OR NEW.sent_at IS NOT NULL OR NEW.provider_message_id IS NOT NULL OR NEW.materialized_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Return opportunity must start pending' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- The group is always acquired before source rows. Never acquire it from an outbox trigger.
CREATE OR REPLACE FUNCTION studiofy_return_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT studiofy_return_group_locked(NEW.assinatura_id,NEW.customer_key,NEW.service_identity) THEN
  RAISE EXCEPTION 'Return group lock required before mutation' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('sent','suppressed','cancelled','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Terminal return record is immutable' USING ERRCODE='23514';END IF;
 IF NEW.status IN ('pending','processing') AND (NEW.transport_protocol<>'outbox_v1' OR NEW.materialized_at IS NULL)
  AND EXISTS(SELECT 1 FROM return_reminders n WHERE n.assinatura_id=NEW.assinatura_id AND n.customer_key=NEW.customer_key
   AND n.service_identity=NEW.service_identity AND (n.completed_at,n.appointment_id)>(NEW.completed_at,NEW.appointment_id)) THEN
  RAISE EXCEPTION 'Superseded return cannot become eligible' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION studiofy_return_supersede_group(tenant bigint,customer text,service_key text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE latest_time timestamptz;latest_appointment bigint;r return_reminders%ROWTYPE;m whatsapp_messages%ROWTYPE;changed integer:=0;
BEGIN
 PERFORM studiofy_return_group_lock(tenant,customer,service_key);
 SELECT completed_at,appointment_id INTO latest_time,latest_appointment FROM return_reminders
  WHERE assinatura_id=tenant AND customer_key=customer AND service_identity=service_key
  ORDER BY completed_at DESC,appointment_id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN 0;END IF;
 FOR r IN SELECT * FROM return_reminders WHERE assinatura_id=tenant AND customer_key=customer AND service_identity=service_key
  AND status IN ('pending','processing') AND superseded_at IS NULL
  AND (completed_at,appointment_id)<(latest_time,latest_appointment) ORDER BY id FOR UPDATE LOOP
  IF r.transport_protocol='legacy_simulated' THEN
   UPDATE return_reminders SET status=CASE WHEN r.status='processing' AND r.dispatch_started_at IS NOT NULL THEN 'uncertain' ELSE 'suppressed' END,
    reason_code=CASE WHEN r.status='processing' AND r.dispatch_started_at IS NOT NULL THEN 'delivery_uncertain' ELSE 'newer_completion' END,
    claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=r.id;
  ELSE
   SELECT * INTO m FROM whatsapp_messages WHERE return_reminder_id=r.id FOR UPDATE;
   IF m.id IS NOT NULL THEN
    UPDATE whatsapp_messages SET return_cancel_requested_at=coalesce(return_cancel_requested_at,clock_timestamp()),
     status=CASE WHEN m.status='pending' AND m.operation_token IS NULL AND m.dispatch_started_at IS NULL THEN 'failed' ELSE status END,
     last_error=CASE WHEN m.status='pending' AND m.operation_token IS NULL AND m.dispatch_started_at IS NULL THEN 'Return superseded before transport.' ELSE last_error END
     WHERE id=m.id;
   END IF;
   UPDATE return_reminders SET superseded_at=clock_timestamp(),
    status=CASE WHEN m.dispatch_started_at IS NOT NULL OR m.status IN ('sent','uncertain') THEN status ELSE 'suppressed' END,
    reason_code=CASE WHEN m.dispatch_started_at IS NOT NULL OR m.status IN ('sent','uncertain') THEN reason_code ELSE 'newer_completion' END,
    updated_at=clock_timestamp() WHERE id=r.id;
  END IF;
  changed:=changed+1;
 END LOOP;
 RETURN changed;
END $$;

CREATE FUNCTION studiofy_return_rule_ready(r return_reminders) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT r.transport_protocol='outbox_v1' AND r.historical_snapshot_status='captured' AND r.status='pending'
 AND r.superseded_at IS NULL AND r.eligible_at<=studiofy_return_now() AND r.next_attempt_at<=studiofy_return_now()
 AND NOT EXISTS(SELECT 1 FROM return_reminders n WHERE n.assinatura_id=r.assinatura_id AND n.customer_key=r.customer_key
  AND n.service_identity=r.service_identity AND (n.completed_at,n.appointment_id)>(r.completed_at,r.appointment_id))
$$;
CREATE FUNCTION studiofy_return_outbox_ready(m whatsapp_messages) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN m.return_reminder_id IS NULL THEN true ELSE m.return_cancel_requested_at IS NULL AND studiofy_return_delivery_open() AND EXISTS(
  SELECT 1 FROM return_reminders r WHERE r.id=m.return_reminder_id AND r.assinatura_id=m.assinatura_id
   AND studiofy_return_rule_ready(r)) END
$$;

CREATE FUNCTION studiofy_return_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r return_reminders%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.return_reminder_id,NEW.return_owner_epoch) IS DISTINCT FROM ROW(OLD.return_reminder_id,OLD.return_owner_epoch) THEN
   RAISE EXCEPTION 'Return outbox binding is immutable' USING ERRCODE='23514';END IF;
  IF OLD.return_reminder_id IS NULL THEN RETURN NEW;END IF;
  IF ROW(NEW.assinatura_id,NEW.instance,NEW.phone,NEW.message_id,NEW.response) IS DISTINCT FROM
   ROW(OLD.assinatura_id,OLD.instance,OLD.phone,OLD.message_id,OLD.response) THEN
   RAISE EXCEPTION 'Return outbox payload is immutable' USING ERRCODE='23514';END IF;
  IF OLD.return_cancel_requested_at IS NOT NULL AND NEW.return_cancel_requested_at IS DISTINCT FROM OLD.return_cancel_requested_at THEN
   RAISE EXCEPTION 'Return cancellation latch is immutable' USING ERRCODE='23514';END IF;
  IF OLD.status IN ('sent','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
   RAISE EXCEPTION 'Terminal return delivery cannot be recycled' USING ERRCODE='23514';END IF;
  IF OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL AND NEW.status='sending' THEN
   IF NEW.return_cancel_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Return superseded before transport frontier' USING ERRCODE='23514';END IF;
   IF NOT studiofy_return_delivery_open() THEN RAISE EXCEPTION 'Return delivery deferred' USING ERRCODE='55P03';END IF;
   -- Ownership is already durably reserved. This read acquires no ownership/source row lock.
   IF NOT EXISTS(SELECT 1 FROM evolution_instance_owners o WHERE o.instance_key=lower(NEW.instance) COLLATE "C"
    AND o.instance_name=NEW.instance AND o.model='principal' AND o.source_schema=TG_TABLE_SCHEMA
    AND o.owner_id=NEW.assinatura_id::text AND o.conversation_epoch=NEW.return_owner_epoch
    AND o.operation_token=NEW.operation_token AND NEW.operation_token IS NOT NULL) THEN
    RAISE EXCEPTION 'Return ownership changed' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.return_reminder_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO r FROM return_reminders WHERE id=NEW.return_reminder_id AND assinatura_id=NEW.assinatura_id;
 IF NOT FOUND OR r.transport_protocol<>'outbox_v1' OR r.historical_snapshot_status<>'captured'
  OR NEW.phone IS DISTINCT FROM r.phone_snapshot OR NEW.response IS DISTINCT FROM studiofy_return_message_text(r)
  OR NOT studiofy_return_group_locked(r.assinatura_id,r.customer_key,r.service_identity)
  OR NOT studiofy_return_rule_ready(r) OR NOT studiofy_return_delivery_open()
  OR NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.claim_token IS NOT NULL OR NEW.operation_token IS NOT NULL
  OR NEW.claimed_at IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.return_cancel_requested_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM evolution_instance_owners o JOIN assinaturas a ON a.id=r.assinatura_id
   WHERE o.instance_key=lower(NEW.instance) COLLATE "C" AND o.instance_name=NEW.instance AND a.whatsapp_session=NEW.instance
    AND o.model='principal' AND o.source_schema=TG_TABLE_SCHEMA AND o.owner_id=r.assinatura_id::text
    AND o.conversation_epoch=NEW.return_owner_epoch) THEN
  RAISE EXCEPTION 'Return materialization identity or historical payload mismatch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_return_outbox_guard BEFORE INSERT OR UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION studiofy_return_outbox_guard();

CREATE FUNCTION studiofy_return_outbox_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.return_reminder_id IS NOT NULL AND EXISTS(SELECT 1 FROM assinaturas WHERE id=OLD.assinatura_id) THEN
  RAISE EXCEPTION 'Return outbox history requires complete account deletion' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE CONSTRAINT TRIGGER studiofy_return_outbox_delete_guard AFTER DELETE ON whatsapp_messages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studiofy_return_outbox_delete_guard();


-- End-of-transaction equivalence, not two independently durable writes.
CREATE FUNCTION studiofy_return_materialization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin_id bigint; tenant bigint; marked boolean; exists_message boolean;
BEGIN
 IF TG_TABLE_NAME='whatsapp_messages' THEN origin_id:=NEW.return_reminder_id;tenant:=NEW.assinatura_id;
 ELSE origin_id:=NEW.id;tenant:=NEW.assinatura_id;END IF;
 IF origin_id IS NULL THEN RETURN NEW;END IF;
 SELECT materialized_at IS NOT NULL INTO marked FROM return_reminders WHERE id=origin_id AND assinatura_id=tenant;
 IF NOT FOUND THEN RETURN NEW;END IF;
 SELECT EXISTS(SELECT 1 FROM whatsapp_messages WHERE return_reminder_id=origin_id AND assinatura_id=tenant) INTO exists_message;
 IF marked IS DISTINCT FROM exists_message THEN
  RAISE EXCEPTION 'Return source and outbox must materialize atomically' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER studiofy_return_materialization_guard AFTER INSERT OR UPDATE ON return_reminders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studiofy_return_materialization_guard();
CREATE CONSTRAINT TRIGGER studiofy_return_materialization_guard AFTER INSERT ON whatsapp_messages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studiofy_return_materialization_guard();

CREATE FUNCTION studiofy_return_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM return_reminders r JOIN assinaturas a ON a.id=r.assinatura_id WHERE r.materialized_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Return outbox history cannot be truncated' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER studiofy_return_truncate_guard BEFORE TRUNCATE ON whatsapp_messages
 FOR EACH STATEMENT EXECUTE FUNCTION studiofy_return_truncate_guard();
CREATE TRIGGER studiofy_return_truncate_guard BEFORE TRUNCATE ON return_reminders
 FOR EACH STATEMENT EXECUTE FUNCTION studiofy_return_truncate_guard();

-- Preserve terminal rows and legacy facts. Pin all new/replaced routines to this installation.
DO $$ DECLARE routine regprocedure;BEGIN
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=current_schema() AND p.proname IN ('studiofy_return_now','studiofy_return_delivery_open',
   'studiofy_return_plain','studiofy_return_message_text','studiofy_return_completion_guard','studiofy_return_opportunity_create',
   'studiofy_return_opportunity_guard','studiofy_return_supersede_group','studiofy_return_rule_ready',
   'studiofy_return_outbox_ready','studiofy_return_outbox_guard','studiofy_return_outbox_delete_guard',
   'studiofy_return_state_guard','studiofy_return_materialization_guard','studiofy_return_truncate_guard')
 LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp',routine,current_schema());END LOOP;
END $$;

CREATE VIEW return_reminder_delivery AS SELECT r.*,m.id AS outbox_id,m.status AS delivery_status,
 m.sent_at AS delivery_sent_at,m.last_error AS delivery_error
 FROM return_reminders r LEFT JOIN whatsapp_messages m ON m.return_reminder_id=r.id AND m.assinatura_id=r.assinatura_id;
