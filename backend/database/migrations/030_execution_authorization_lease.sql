-- Additive Stage 2. Immutable 029 evidence and all legacy rows are untouched.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION studiofy_execution_lease_duration() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 seconds' $$;

CREATE TABLE evolution_execution_authorizations (
 execution_id uuid PRIMARY KEY REFERENCES evolution_operation_executions(execution_id),
 state text NOT NULL CHECK(state IN ('ACTIVE','UNKNOWN')),
 heartbeat_at timestamptz NOT NULL,
 lease_until timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(lease_until>heartbeat_at),
 CHECK((state='UNKNOWN')=(revoked_at IS NOT NULL))
);

CREATE FUNCTION studiofy_execution_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stamp timestamptz := clock_timestamp();
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN
  RAISE EXCEPTION 'Authorization history is retained' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF pg_trigger_depth()<2 THEN
   RAISE EXCEPTION 'Only new executions acquire authorization' USING ERRCODE='23514';
  END IF;
  NEW.state := 'ACTIVE'; NEW.heartbeat_at := stamp;
  NEW.lease_until := stamp+studiofy_execution_lease_duration();
  NEW.updated_at := stamp; NEW.revoked_at := NULL;
 ELSE
  IF NEW.execution_id IS DISTINCT FROM OLD.execution_id OR OLD.state<>'ACTIVE'
   OR NEW.state NOT IN ('ACTIVE','UNKNOWN') THEN
   RAISE EXCEPTION 'Authorization cannot be reassigned or resurrected' USING ERRCODE='23514';
  END IF;
  IF NEW.state='ACTIVE' AND OLD.lease_until<=stamp THEN NEW.state := 'UNKNOWN'; END IF;
  NEW.updated_at := stamp;
  IF NEW.state='UNKNOWN' THEN
   NEW.heartbeat_at := OLD.heartbeat_at; NEW.lease_until := OLD.lease_until; NEW.revoked_at := stamp;
  ELSE
   NEW.heartbeat_at := stamp; NEW.lease_until := stamp+studiofy_execution_lease_duration(); NEW.revoked_at := NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_authorization_guard BEFORE INSERT OR UPDATE OR DELETE ON evolution_execution_authorizations
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_authorization_guard();
CREATE TRIGGER execution_authorization_no_truncate BEFORE TRUNCATE ON evolution_execution_authorizations
 FOR EACH STATEMENT EXECUTE FUNCTION studiofy_execution_authorization_guard();

CREATE FUNCTION studiofy_execution_authorization_register() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO evolution_execution_authorizations(execution_id) VALUES(NEW.execution_id);
 RETURN NEW;
END $$;
CREATE TRIGGER execution_authorization_register AFTER INSERT ON evolution_operation_executions
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_authorization_register();

-- Effective authorization becomes UNKNOWN at database time even if its process
-- crashed and nobody is running a heartbeat. This is NOT evidence of death.
CREATE VIEW evolution_execution_authorization_status AS
 SELECT e.execution_id,
  CASE WHEN a.execution_id IS NULL THEN NULL
       WHEN a.state='ACTIVE' AND a.lease_until>clock_timestamp() THEN 'ACTIVE'
       ELSE 'UNKNOWN' END AS authorization_state,
  a.heartbeat_at,a.lease_until,a.revoked_at
 FROM evolution_operation_executions e LEFT JOIN evolution_execution_authorizations a USING(execution_id);

-- Defense at the durable frontier, in the SAME delivery update transaction.
-- Legacy reservations without Stage 2 authorization retain the existing guards.
CREATE FUNCTION studiofy_execution_authorization_frontier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted boolean; tracked boolean; authorization_state text; authorization_until timestamptz;
BEGIN
 IF NEW.status<>'sending' OR NOT (OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL) THEN RETURN NEW; END IF;
 SELECT true INTO tracked FROM evolution_operation_executions e
  JOIN evolution_execution_authorizations a USING(execution_id) WHERE e.operation_token=NEW.operation_token;
 IF tracked IS DISTINCT FROM true THEN RETURN NEW; END IF;
 SELECT true,a.state,a.lease_until INTO permitted,authorization_state,authorization_until FROM evolution_operation_executions e
  JOIN evolution_execution_authorizations a USING(execution_id)
  JOIN evolution_executors x USING(executor_id)
  JOIN evolution_instance_owners o ON o.operation_token=e.operation_token
  WHERE e.operation_token=NEW.operation_token AND e.assinatura_id=NEW.assinatura_id
   AND e.operation_kind=TG_TABLE_NAME AND e.delivery_id=NEW.id AND e.claim_token=NEW.claim_token
   AND e.instance_name=CASE WHEN TG_TABLE_NAME='whatsapp_messages' THEN to_jsonb(NEW)->>'instance' ELSE to_jsonb(NEW)->'snapshot'->>'instance' END
   AND o.model='principal' AND o.source_schema=TG_TABLE_SCHEMA AND o.owner_id=NEW.assinatura_id::text AND o.instance_name=e.instance_name
  FOR UPDATE OF a;
 -- Evaluate time AFTER acquiring the row lock, including any lock wait.
 IF permitted IS DISTINCT FROM true OR authorization_state<>'ACTIVE' OR authorization_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Execution authorization unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_authorization_frontier BEFORE UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_authorization_frontier();
CREATE TRIGGER execution_authorization_frontier BEFORE UPDATE ON appointment_reminders
 FOR EACH ROW EXECUTE FUNCTION studiofy_execution_authorization_frontier();
