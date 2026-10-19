-- Reminder-only evolution; the published delivery protocol remains intact.
ALTER TABLE appointment_reminders DROP CONSTRAINT appointment_reminders_appointment_id_key;
ALTER TABLE appointment_reminders ADD COLUMN reminder_kind text NOT NULL DEFAULT 'legacy_20m'
 CHECK (reminder_kind IN ('legacy_20m','reminder_15m','reminder_5m'));
ALTER TABLE appointment_reminders ADD COLUMN schedule_revision bigint;
ALTER TABLE appointment_reminders ADD COLUMN starts_at timestamptz;
ALTER TABLE appointment_reminders ADD COLUMN expires_at timestamptz;
ALTER TABLE appointment_reminders ADD COLUMN snapshot jsonb;
ALTER TABLE appointment_reminders ADD COLUMN destination text;
ALTER TABLE appointment_reminders ADD CONSTRAINT reminder_tenant_appointment
 FOREIGN KEY (assinatura_id,appointment_id) REFERENCES agendamentos(assinatura_id,id) ON DELETE CASCADE;
ALTER TABLE appointment_reminders ADD CONSTRAINT reminder_window_shape CHECK (reminder_kind='legacy_20m' OR (
 schedule_revision IS NOT NULL AND schedule_revision>0 AND starts_at IS NOT NULL AND expires_at IS NOT NULL
 AND snapshot IS NOT NULL AND jsonb_typeof(snapshot)='object'
 AND due_at=starts_at-CASE reminder_kind WHEN 'reminder_15m' THEN interval '15 minutes' ELSE interval '5 minutes' END
 AND expires_at=due_at+interval '1 minute'));
CREATE UNIQUE INDEX reminder_revision_identity ON appointment_reminders
 (assinatura_id,appointment_id,reminder_kind,schedule_revision) WHERE reminder_kind<>'legacy_20m';
-- A lifetime budget. Uncertainty consumes it until explicit reconciliation.
CREATE UNIQUE INDEX reminder_lifetime_budget ON appointment_reminders(assinatura_id,appointment_id,reminder_kind)
 WHERE reminder_kind<>'legacy_20m' AND status IN ('sending','sent','uncertain');
CREATE INDEX reminder_ready ON appointment_reminders(due_at,id) WHERE status='pending' AND reminder_kind<>'legacy_20m';
CREATE INDEX reminder_recovery ON appointment_reminders(claimed_at,id) WHERE status='sending';
CREATE INDEX reminder_legacy_recovery ON appointment_reminders(id)
 WHERE (status='pending' AND (dispatch_started_at IS NOT NULL OR (attempts>0 AND claim_token IS NULL)))
 OR (status='sending' AND claim_token IS NULL);
CREATE TABLE appointment_reminder_origins (
 assinatura_id bigint NOT NULL, appointment_id bigint NOT NULL,
 schedule_revision bigint NOT NULL CHECK(schedule_revision>0), snapshot jsonb NOT NULL, starts_at timestamptz,
 PRIMARY KEY(assinatura_id,appointment_id),
 FOREIGN KEY(assinatura_id,appointment_id) REFERENCES agendamentos(assinatura_id,id) ON DELETE CASCADE
);
CREATE FUNCTION studiofy_reminder_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$;
CREATE FUNCTION studiofy_reminder_destination(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 WITH v AS (SELECT btrim(value) AS original,regexp_replace(value,'[^0-9]','','g') AS digits),
 n AS (SELECT *,CASE WHEN length(digits) IN (12,13) AND left(digits,2)='55' THEN substring(digits FROM 3) ELSE digits END AS national FROM v)
 SELECT CASE WHEN original ~ '^[+]?[0-9 ()-]+$'
 AND (left(original,1)<>'+' OR (left(digits,2)='55' AND length(digits) IN (12,13)))
 AND national ~ '^[1-9]{2}([2-5][0-9]{7}|9[0-9]{8})$' THEN '55'||national ELSE NULL END FROM n
$$;
CREATE FUNCTION studiofy_reminder_snapshot(tenant bigint,appointment bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('appointment_id',a.id,'assinatura_id',a.assinatura_id,
  'cliente',a.nome_cliente,'telefone',a.telefone,'destination',studiofy_reminder_destination(a.telefone),
  'servico',a.servico_nome,'service_id',a.studio_service_id,'profissional_id',a.profissional_id,'profissional',p.nome,
  'data',a.data,'hora',a.hora,'duracao',a.duracao,'status',a.status,
  'estabelecimento',s.barbearia_nome,'instance',s.whatsapp_session)
 FROM agendamentos a JOIN assinaturas s ON s.id=a.assinatura_id
 LEFT JOIN profissionais p ON p.id=a.profissional_id AND p.assinatura_id=a.assinatura_id
 WHERE a.id=appointment AND a.assinatura_id=tenant
$$;
CREATE FUNCTION studiofy_reminder_refresh(tenant bigint,appointment bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE snap jsonb; origin appointment_reminder_origins%ROWTYPE; start_time timestamptz;
BEGIN
 PERFORM 1 FROM agendamentos WHERE id=appointment AND assinatura_id=tenant FOR UPDATE NOWAIT;
 snap:=studiofy_reminder_snapshot(tenant,appointment);
 IF snap IS NULL THEN RETURN; END IF;
 BEGIN
  IF snap->>'data' ~ '^\d{4}-\d{2}-\d{2}$' AND snap->>'hora' ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
   start_time:=((snap->>'data')||' '||(snap->>'hora'))::timestamp AT TIME ZONE 'America/Sao_Paulo';
  END IF;
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN start_time:=NULL;
 END;
 INSERT INTO appointment_reminder_origins(assinatura_id,appointment_id,schedule_revision,snapshot,starts_at)
 VALUES(tenant,appointment,1,snap,start_time)
 ON CONFLICT(assinatura_id,appointment_id) DO UPDATE SET
  schedule_revision=appointment_reminder_origins.schedule_revision+1,snapshot=EXCLUDED.snapshot,starts_at=EXCLUDED.starts_at
 WHERE appointment_reminder_origins.snapshot IS DISTINCT FROM EXCLUDED.snapshot;
 SELECT * INTO origin FROM appointment_reminder_origins WHERE assinatura_id=tenant AND appointment_id=appointment;
 -- Never rewrite evidence of in-flight, uncertain or completed attempts.
 UPDATE appointment_reminders SET status='cancelled',last_error='Appointment context superseded.'
 WHERE assinatura_id=tenant AND appointment_id=appointment AND reminder_kind<>'legacy_20m'
 AND status='pending' AND (schedule_revision<>origin.schedule_revision OR snap->>'status'<>'confirmado');
 IF snap->>'status'='confirmado' AND start_time IS NOT NULL THEN
  INSERT INTO appointment_reminders(assinatura_id,appointment_id,reminder_kind,schedule_revision,starts_at,due_at,expires_at,snapshot,destination)
  SELECT tenant,appointment,k,origin.schedule_revision,start_time,start_time-offset_time,
   start_time-offset_time+interval '1 minute',snap,snap->>'destination'
  FROM (VALUES('reminder_15m',interval '15 minutes'),('reminder_5m',interval '5 minutes')) AS kinds(k,offset_time)
  WHERE NOT EXISTS(SELECT 1 FROM appointment_reminders sent WHERE sent.assinatura_id=tenant
   AND sent.appointment_id=appointment AND sent.reminder_kind=k AND sent.status='sent')
  ON CONFLICT DO NOTHING;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION studiofy_reminder_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM studiofy_reminder_refresh(NEW.assinatura_id,NEW.id);
 RETURN NEW;
END $$;
-- Guard the SAME statement that persists transport intent. NOWAIT prevents
-- reminder->appointment lock inversion. No appointment lock survives into HTTP.
CREATE FUNCTION studiofy_reminder_window_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap jsonb; revision bigint; current_start timestamptz; instant timestamptz;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.assinatura_id,NEW.appointment_id,NEW.reminder_kind,NEW.schedule_revision,NEW.starts_at,NEW.due_at,NEW.expires_at,NEW.snapshot,NEW.destination)
   IS DISTINCT FROM ROW(OLD.assinatura_id,OLD.appointment_id,OLD.reminder_kind,OLD.schedule_revision,OLD.starts_at,OLD.due_at,OLD.expires_at,OLD.snapshot,OLD.destination) THEN
   RAISE EXCEPTION 'Reminder context is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='sent' AND NEW.status<>'sent' THEN
   RAISE EXCEPTION 'Sent reminder cannot be recycled' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.reminder_kind='legacy_20m' THEN
  IF TG_OP='INSERT' OR (OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL AND NEW.status='sending') THEN
   RAISE EXCEPTION 'Legacy reminder scheduling is disabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL AND NEW.status='sending' THEN
  PERFORM 1 FROM agendamentos WHERE id=NEW.appointment_id AND assinatura_id=NEW.assinatura_id FOR SHARE NOWAIT;
  PERFORM 1 FROM assinaturas WHERE id=NEW.assinatura_id FOR SHARE NOWAIT;
  PERFORM 1 FROM profissionais WHERE assinatura_id=NEW.assinatura_id AND id=(
   SELECT profissional_id FROM agendamentos WHERE id=NEW.appointment_id AND assinatura_id=NEW.assinatura_id) FOR SHARE NOWAIT;
  snap:=studiofy_reminder_snapshot(NEW.assinatura_id,NEW.appointment_id);
  SELECT schedule_revision,starts_at INTO revision,current_start FROM appointment_reminder_origins
   WHERE assinatura_id=NEW.assinatura_id AND appointment_id=NEW.appointment_id;
  instant:=studiofy_reminder_now();
  IF snap IS NULL OR snap IS DISTINCT FROM NEW.snapshot OR revision IS DISTINCT FROM NEW.schedule_revision
   OR current_start IS DISTINCT FROM NEW.starts_at
   OR snap->>'status'<>'confirmado' OR NEW.destination IS NULL
   OR NEW.destination IS DISTINCT FROM studiofy_reminder_destination(snap->>'telefone')
   OR instant<NEW.due_at OR instant>=NEW.expires_at OR instant>=NEW.starts_at THEN
   RAISE EXCEPTION 'Reminder no longer eligible' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_reminder_window_guard BEFORE INSERT OR UPDATE ON appointment_reminders
 FOR EACH ROW EXECUTE FUNCTION studiofy_reminder_window_guard();
-- Pin relation/function resolution to this installation, never pg_temp/public.
DO $$ DECLARE routine regprocedure; BEGIN
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=current_schema() AND p.proname IN ('studiofy_reminder_now','studiofy_reminder_destination',
   'studiofy_reminder_snapshot','studiofy_reminder_refresh','studiofy_reminder_sync','studiofy_reminder_window_guard')
 LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp',routine,current_schema()); END LOOP;
END $$;
-- Retire only provably unstarted legacy work; keep all delivery evidence.
UPDATE appointment_reminders SET status='cancelled',last_error='Replaced by 15m/5m reminder windows.'
 WHERE status='pending' AND attempts=0 AND dispatch_started_at IS NULL;
SELECT studiofy_reminder_refresh(assinatura_id,id) FROM agendamentos WHERE assinatura_id IS NOT NULL AND status='confirmado';
