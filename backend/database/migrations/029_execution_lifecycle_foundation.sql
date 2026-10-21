-- Stage 1: new structures only. No legacy backfill or changes to reservations.
SET LOCAL lock_timeout = '2s';

CREATE TABLE evolution_executors (
 executor_id uuid PRIMARY KEY,
 boot_id uuid NOT NULL UNIQUE,
 process_id integer NOT NULL CHECK(process_id>0),
 started_at timestamptz NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 service_id text CHECK(length(service_id) BETWEEN 1 AND 200),
 deployment_id text CHECK(length(deployment_id) BETWEEN 1 AND 200),
 instance_id text CHECK(length(instance_id) BETWEEN 1 AND 200),
 revision text CHECK(length(revision) BETWEEN 1 AND 200)
);
CREATE TABLE evolution_operation_executions (
 execution_id uuid PRIMARY KEY,
 executor_id uuid NOT NULL REFERENCES evolution_executors(executor_id),
 operation_token uuid NOT NULL UNIQUE,
 assinatura_id bigint NOT NULL CHECK(assinatura_id>0),
 instance_name text NOT NULL CHECK(instance_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'),
 operation_kind text NOT NULL CHECK(operation_kind IN ('instance_operation','whatsapp_messages','appointment_reminders')),
 delivery_id bigint CHECK(delivery_id>0),
 claim_token uuid,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','STOPPED','UNKNOWN')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 heartbeat_at timestamptz,
 lease_until timestamptz,
 stopped_at timestamptz,
 CHECK((operation_kind='instance_operation' AND delivery_id IS NULL AND claim_token IS NULL)
    OR (operation_kind<>'instance_operation' AND delivery_id IS NOT NULL AND claim_token IS NOT NULL)),
 CHECK((state='STOPPED')=(stopped_at IS NOT NULL)),
 CHECK(heartbeat_at IS NULL OR heartbeat_at>=started_at),
 CHECK(lease_until IS NULL OR (heartbeat_at IS NOT NULL AND lease_until>=heartbeat_at))
);
CREATE INDEX evolution_execution_executor ON evolution_operation_executions(executor_id,started_at);
CREATE INDEX evolution_execution_delivery ON evolution_operation_executions(assinatura_id,operation_kind,delivery_id);

-- These audit identities survive normal deletion of the business objects.
-- Avoid FKs/ALTERs/DDL locks on historical deliveries and ownership tables.
CREATE FUNCTION studiofy_execution_foundation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Execution foundation evidence is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER execution_executor_immutable BEFORE UPDATE OR DELETE ON evolution_executors
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_foundation_immutable();
CREATE TRIGGER execution_executor_no_truncate BEFORE TRUNCATE ON evolution_executors
 FOR EACH STATEMENT EXECUTE FUNCTION studiofy_execution_foundation_immutable();
CREATE TRIGGER execution_identity_immutable BEFORE UPDATE OR DELETE ON evolution_operation_executions
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_foundation_immutable();
CREATE TRIGGER execution_identity_no_truncate BEFORE TRUNCATE ON evolution_operation_executions
 FOR EACH STATEMENT EXECUTE FUNCTION studiofy_execution_foundation_immutable();

CREATE FUNCTION studiofy_execution_registration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 -- Future states/lease fields are reserved, never fabricated by Stage 1.
 IF NEW.operation_kind NOT IN ('instance_operation','whatsapp_messages','appointment_reminders')
  OR NEW.state<>'ACTIVE' OR NEW.heartbeat_at IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.stopped_at IS NOT NULL THEN
  RAISE EXCEPTION 'Only initial execution evidence can be registered' USING ERRCODE='23514';
 END IF;
 EXECUTE format('SELECT true FROM %I.evolution_instance_owners WHERE model=''principal'' AND source_schema=$1
  AND owner_id=$2 AND instance_name=$3 AND operation_token=$4 FOR UPDATE',TG_TABLE_SCHEMA)
  INTO matched USING TG_TABLE_SCHEMA,NEW.assinatura_id::text,NEW.instance_name,NEW.operation_token;
 IF matched IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Execution reservation mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.operation_kind<>'instance_operation' THEN
  EXECUTE format('SELECT true FROM %I.%I WHERE id=$1 AND assinatura_id=$2 AND claim_token=$3 AND operation_token=$4
    AND status=''sending'' AND dispatch_started_at IS NULL AND %s=$5 FOR UPDATE',TG_TABLE_SCHEMA,NEW.operation_kind,
    CASE WHEN NEW.operation_kind='whatsapp_messages' THEN 'instance' ELSE 'snapshot->>''instance''' END)
   INTO matched USING NEW.delivery_id,NEW.assinatura_id,NEW.claim_token,NEW.operation_token,NEW.instance_name;
  IF matched IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Execution delivery mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_registration_guard BEFORE INSERT ON evolution_operation_executions
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_registration_guard();
