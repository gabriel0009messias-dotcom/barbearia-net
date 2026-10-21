-- Stage 3B.1: dormant SQL foundation. No runtime issuer, backfill or recovery.
-- The migrator wraps this file in its transaction. Never edit 001-030.
SET LOCAL lock_timeout = '2s';

-- Bind every function to this migration's schema; never resolve caller objects.
DO $migration$
DECLARE ns text := quote_ident(current_schema());
BEGIN
EXECUTE replace(replace($ddl$
CREATE TABLE __NS__.evolution_supervisors (
 supervisor_id uuid PRIMARY KEY,
 supervisor_boot_id uuid NOT NULL UNIQUE,
 protocol_version integer NOT NULL CHECK(protocol_version=1),
 process_id integer NOT NULL CHECK(process_id>0),
 origin text NOT NULL CHECK(origin='local-parent-v1'),
 issuer_role name NOT NULL DEFAULT session_user,
 revision text CHECK(revision ~ '^[A-Za-z0-9_.-]{1,200}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE __NS__.evolution_executor_birth_bindings (
 executor_id uuid PRIMARY KEY REFERENCES __NS__.evolution_executors(executor_id),
 boot_id uuid NOT NULL UNIQUE,
 supervisor_id uuid NOT NULL REFERENCES __NS__.evolution_supervisors(supervisor_id),
 supervisor_boot_id uuid NOT NULL,
 spawn_id uuid NOT NULL UNIQUE,
 observed_pid integer NOT NULL CHECK(observed_pid>0),
 nonce_fingerprint text NOT NULL CHECK(nonce_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
 protocol_version integer NOT NULL CHECK(protocol_version=1),
 runtime_profile text NOT NULL CHECK(runtime_profile='evolution-single-process-v1'),
 instance_id text CHECK(instance_id ~ '^[A-Za-z0-9_.-]{1,200}$'),
 revision text CHECK(revision ~ '^[A-Za-z0-9_.-]{1,200}$'),
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 registration_hash text NOT NULL CHECK(registration_hash ~ '^sha256:[a-f0-9]{64}$'),
 UNIQUE(executor_id,boot_id)
);
CREATE INDEX execution_birth_supervisor ON __NS__.evolution_executor_birth_bindings(supervisor_id,recorded_at);
CREATE TABLE __NS__.evolution_executor_gates (
 executor_id uuid PRIMARY KEY,
 boot_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('BOOTSTRAPPING','OPEN','DRAINING','CLOSED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(executor_id,boot_id) REFERENCES __NS__.evolution_executor_birth_bindings(executor_id,boot_id)
);
CREATE TABLE __NS__.evolution_executor_closure_events (
 closure_event_id uuid PRIMARY KEY,
 proof_type text NOT NULL CHECK(proof_type IN ('COOPERATIVE_SCOPE_CLOSED','SUPERVISOR_PROCESS_EXIT')),
 protocol_version integer NOT NULL CHECK(protocol_version=1),
 executor_id uuid NOT NULL,
 boot_id uuid NOT NULL,
 supervisor_id uuid NOT NULL REFERENCES __NS__.evolution_supervisors(supervisor_id),
 supervisor_boot_id uuid NOT NULL,
 origin text NOT NULL CHECK(origin='supervisor-ipc-v1'),
 evidence_canonicalization_version text NOT NULL CHECK(evidence_canonicalization_version='pg-jsonb-v1'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8192),
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 semantic_content_hash text NOT NULL CHECK(semantic_content_hash ~ '^sha256:[a-f0-9]{64}$'),
 FOREIGN KEY(executor_id,boot_id) REFERENCES __NS__.evolution_executor_birth_bindings(executor_id,boot_id),
 UNIQUE(supervisor_id,idempotency_key),
 UNIQUE(executor_id,boot_id,proof_type),
 UNIQUE(closure_event_id,executor_id,boot_id)
);
CREATE TABLE __NS__.evolution_execution_stop_proofs (
 proof_id uuid PRIMARY KEY,
 proof_type text NOT NULL CHECK(proof_type IN ('COOPERATIVE_SCOPE_CLOSED','SUPERVISOR_PROCESS_EXIT')),
 protocol_version integer NOT NULL CHECK(protocol_version=1),
 closure_event_id uuid NOT NULL,
 executor_id uuid NOT NULL,
 boot_id uuid NOT NULL,
 execution_id uuid NOT NULL REFERENCES __NS__.evolution_operation_executions(execution_id),
 source_schema text NOT NULL,
 assinatura_id bigint NOT NULL CHECK(assinatura_id>0),
 instance_name text NOT NULL,
 operation_kind text NOT NULL,
 delivery_id bigint,
 claim_token uuid,
 operation_token_fingerprint text NOT NULL CHECK(operation_token_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
 supervisor_id uuid NOT NULL REFERENCES __NS__.evolution_supervisors(supervisor_id),
 supervisor_boot_id uuid NOT NULL,
 origin text NOT NULL CHECK(origin='supervisor-ipc-v1'),
 evidence_canonicalization_version text NOT NULL CHECK(evidence_canonicalization_version='pg-jsonb-v1'),
 evidence_hash text NOT NULL,
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 semantic_content_hash text NOT NULL,
 FOREIGN KEY(closure_event_id,executor_id,boot_id) REFERENCES __NS__.evolution_executor_closure_events(closure_event_id,executor_id,boot_id),
 UNIQUE(supervisor_id,idempotency_key),
 UNIQUE(closure_event_id,execution_id),
 UNIQUE(proof_id,execution_id)
);
CREATE INDEX execution_stop_proof_subject ON __NS__.evolution_execution_stop_proofs(execution_id,recorded_at);
CREATE INDEX execution_stop_proof_tenant ON __NS__.evolution_execution_stop_proofs(assinatura_id,instance_name,recorded_at);
CREATE TABLE __NS__.evolution_execution_stops (
 execution_id uuid PRIMARY KEY REFERENCES __NS__.evolution_operation_executions(execution_id),
 proof_id uuid NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(proof_id,execution_id) REFERENCES __NS__.evolution_execution_stop_proofs(proof_id,execution_id)
);

CREATE FUNCTION __NS__.studiofy_stop_hash(p jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
 SELECT 'sha256:'||encode(sha256(convert_to(p::text,'UTF8')),'hex') $f$;
CREATE FUNCTION __NS__.studiofy_stop_keys(p jsonb, allowed text[], required text[]) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16384 THEN
  RAISE EXCEPTION 'Invalid protocol object' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(allowed))
  OR EXISTS(SELECT 1 FROM unnest(required) k WHERE NOT p ? k OR p->k='null'::jsonb) THEN
  RAISE EXCEPTION 'Invalid protocol fields' USING ERRCODE='23514';
 END IF;
END $f$;
CREATE FUNCTION __NS__.studiofy_executor_gate_key(p_executor uuid) RETURNS bigint
 LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
 SELECT hashtextextended('__NS__.executor-gate-v1:'||p_executor::text,0) $f$;
CREATE FUNCTION __NS__.studiofy_execution_has_gate_ticket(p_executor uuid,p_exclusive boolean) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
  AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND classid=((__NS__.studiofy_executor_gate_key(p_executor)>>32)&4294967295)::oid
  AND objid=(__NS__.studiofy_executor_gate_key(p_executor)&4294967295)::oid AND objsubid=1 AND granted
  AND (mode='ExclusiveLock' OR (NOT p_exclusive AND mode='ShareLock'))) $f$;

-- Ticket + row gate are taken BEFORE authorization. Row triggers only CHECK
-- the ticket: they must never wait for a gate after UPDATE already locked auth.
CREATE FUNCTION __NS__.studiofy_execution_lock_gate(p_executor uuid,p_purpose text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g text;
BEGIN
 IF p_purpose NOT IN ('admission','boundary','renew','finalize','revoke') OR p_purpose IS NULL THEN
  RAISE EXCEPTION 'Invalid gate purpose' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_gates WHERE executor_id=p_executor) THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock_shared(__NS__.studiofy_executor_gate_key(p_executor));
 SELECT state INTO STRICT g FROM __NS__.evolution_executor_gates WHERE executor_id=p_executor FOR SHARE;
 IF g='BOOTSTRAPPING' OR g='CLOSED' OR (g='DRAINING' AND p_purpose NOT IN ('finalize','revoke')) THEN
  RAISE EXCEPTION 'Executor gate denies operation' USING ERRCODE='23514';
 END IF;
END $f$;
CREATE FUNCTION __NS__.studiofy_execution_require_gate(p_executor uuid,p_purpose text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g text;
BEGIN
 SELECT state INTO g FROM __NS__.evolution_executor_gates WHERE executor_id=p_executor;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT __NS__.studiofy_execution_has_gate_ticket(p_executor,false) THEN
  RAISE EXCEPTION 'Acquire executor gate before authorization' USING ERRCODE='23514';
 END IF;
 IF g='BOOTSTRAPPING' OR (g='CLOSED' AND p_purpose<>'proof')
  OR (g='DRAINING' AND p_purpose NOT IN ('finalize','revoke')) THEN
  RAISE EXCEPTION 'Executor gate denies operation' USING ERRCODE='23514';
 END IF;
END $f$;

CREATE FUNCTION __NS__.studiofy_register_supervisor(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE id uuid := (p->>'supervisor_id')::uuid; old __NS__.evolution_supervisors;
BEGIN
 PERFORM __NS__.studiofy_stop_keys(p,ARRAY['supervisor_id','supervisor_boot_id','protocol_version','process_id','origin','revision'],
  ARRAY['supervisor_id','supervisor_boot_id','protocol_version','process_id','origin']);
 INSERT INTO __NS__.evolution_supervisors(supervisor_id,supervisor_boot_id,protocol_version,process_id,origin,revision)
 VALUES(id,(p->>'supervisor_boot_id')::uuid,(p->>'protocol_version')::int,(p->>'process_id')::int,p->>'origin',p->>'revision')
 ON CONFLICT(supervisor_id) DO NOTHING;
 SELECT * INTO STRICT old FROM __NS__.evolution_supervisors WHERE supervisor_id=id;
 IF old.supervisor_boot_id IS DISTINCT FROM (p->>'supervisor_boot_id')::uuid OR old.protocol_version IS DISTINCT FROM (p->>'protocol_version')::int
  OR old.process_id IS DISTINCT FROM (p->>'process_id')::int OR old.origin IS DISTINCT FROM p->>'origin' OR old.revision IS DISTINCT FROM p->>'revision'
  OR old.issuer_role IS DISTINCT FROM session_user THEN
  RAISE EXCEPTION 'Conflicting supervisor identity' USING ERRCODE='23514';
 END IF;
 RETURN id;
END $f$;

-- Enrollment creates a NEW 029 identity, birth and BOOTSTRAPPING gate atomically.
-- There is deliberately no API for attaching a birth to an existing executor.
CREATE FUNCTION __NS__.studiofy_register_executor_birth(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE id uuid := (p->>'executor_id')::uuid; old __NS__.evolution_executor_birth_bindings;
BEGIN
 PERFORM __NS__.studiofy_stop_keys(p,ARRAY['executor_id','boot_id','supervisor_id','supervisor_boot_id','spawn_id','observed_pid','nonce_fingerprint',
  'protocol_version','runtime_profile','instance_id','revision','observed_at','started_at','service_id'],
  ARRAY['executor_id','boot_id','supervisor_id','supervisor_boot_id','spawn_id','observed_pid','nonce_fingerprint','protocol_version','runtime_profile','observed_at','started_at']);
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_supervisors WHERE supervisor_id=(p->>'supervisor_id')::uuid
  AND supervisor_boot_id=(p->>'supervisor_boot_id')::uuid AND protocol_version=(p->>'protocol_version')::int AND issuer_role=session_user) THEN
  RAISE EXCEPTION 'Supervisor birth mismatch' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(__NS__.studiofy_executor_gate_key(id));
 SELECT * INTO old FROM __NS__.evolution_executor_birth_bindings WHERE executor_id=id;
 IF FOUND THEN
  IF old.registration_hash<>__NS__.studiofy_stop_hash(p) THEN RAISE EXCEPTION 'Conflicting birth' USING ERRCODE='23514'; END IF;
  RETURN id;
 END IF;
 IF EXISTS(SELECT 1 FROM __NS__.evolution_executors WHERE executor_id=id OR boot_id=(p->>'boot_id')::uuid) THEN
  RAISE EXCEPTION 'Retroactive birth is forbidden' USING ERRCODE='23514';
 END IF;
 INSERT INTO __NS__.evolution_executors(executor_id,boot_id,process_id,started_at,service_id,instance_id,revision)
 VALUES(id,(p->>'boot_id')::uuid,(p->>'observed_pid')::int,(p->>'started_at')::timestamptz,p->>'service_id',p->>'instance_id',p->>'revision');
 INSERT INTO __NS__.evolution_executor_birth_bindings(executor_id,boot_id,supervisor_id,supervisor_boot_id,spawn_id,observed_pid,
  nonce_fingerprint,protocol_version,runtime_profile,instance_id,revision,observed_at,registration_hash)
 VALUES(id,(p->>'boot_id')::uuid,(p->>'supervisor_id')::uuid,(p->>'supervisor_boot_id')::uuid,(p->>'spawn_id')::uuid,(p->>'observed_pid')::int,
  p->>'nonce_fingerprint',(p->>'protocol_version')::int,p->>'runtime_profile',p->>'instance_id',p->>'revision',(p->>'observed_at')::timestamptz,__NS__.studiofy_stop_hash(p));
 INSERT INTO __NS__.evolution_executor_gates(executor_id,boot_id,state) VALUES(id,(p->>'boot_id')::uuid,'BOOTSTRAPPING');
 RETURN id;
END $f$;

CREATE FUNCTION __NS__.studiofy_executor_gate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Executor gate is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'BOOTSTRAPPING' THEN RAISE EXCEPTION 'Invalid initial gate' USING ERRCODE='23514'; END IF;
  NEW.recorded_at:=clock_timestamp(); NEW.updated_at:=NEW.recorded_at;
 ELSE
  IF NEW.executor_id IS DISTINCT FROM OLD.executor_id OR NEW.boot_id IS DISTINCT FROM OLD.boot_id OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
   OR NOT ((OLD.state='BOOTSTRAPPING' AND NEW.state IN ('OPEN','DRAINING','CLOSED'))
    OR (OLD.state='OPEN' AND NEW.state IN ('DRAINING','CLOSED')) OR (OLD.state='DRAINING' AND NEW.state='CLOSED')) THEN
   RAISE EXCEPTION 'Executor gate cannot regress or reopen' USING ERRCODE='23514';
  END IF;
  IF NOT __NS__.studiofy_execution_has_gate_ticket(OLD.executor_id,true) THEN
   RAISE EXCEPTION 'Gate transition requires exclusive ticket first' USING ERRCODE='23514';
  END IF;
  IF NEW.state='CLOSED' AND NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_closure_events WHERE executor_id=OLD.executor_id AND boot_id=OLD.boot_id) THEN
   RAISE EXCEPTION 'Gate closure requires accepted evidence' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER execution_gate_guard BEFORE INSERT OR UPDATE OR DELETE ON __NS__.evolution_executor_gates
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_executor_gate_guard();
CREATE TRIGGER execution_gate_no_truncate BEFORE TRUNCATE ON __NS__.evolution_executor_gates
 FOR EACH STATEMENT EXECUTE FUNCTION __NS__.studiofy_executor_gate_guard();

CREATE FUNCTION __NS__.studiofy_advance_executor_gate(p_executor uuid,p_boot uuid,p_supervisor uuid,p_state text) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE g __NS__.evolution_executor_gates;
BEGIN
 IF p_state IS NULL OR p_state NOT IN ('OPEN','DRAINING') THEN RAISE EXCEPTION 'Invalid gate transition' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_birth_bindings b JOIN __NS__.evolution_supervisors s USING(supervisor_id)
  WHERE b.executor_id=p_executor AND b.boot_id=p_boot AND b.supervisor_id=p_supervisor AND s.issuer_role=session_user) THEN
  RAISE EXCEPTION 'Birth mismatch' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(__NS__.studiofy_executor_gate_key(p_executor));
 SELECT * INTO STRICT g FROM __NS__.evolution_executor_gates WHERE executor_id=p_executor FOR UPDATE;
 IF g.state=p_state THEN RETURN p_state; END IF;
 UPDATE __NS__.evolution_executor_gates SET state=p_state WHERE executor_id=p_executor;
 RETURN p_state;
END $f$;

CREATE FUNCTION __NS__.studiofy_accept_executor_closure(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b __NS__.evolution_executor_birth_bindings; g text; old __NS__.evolution_executor_closure_events;
 ev jsonb := p->'evidence'; typ text := p->>'proof_type'; id uuid := (p->>'closure_event_id')::uuid; h text;
BEGIN
 PERFORM __NS__.studiofy_stop_keys(p,ARRAY['closure_event_id','proof_type','protocol_version','executor_id','boot_id','supervisor_id','supervisor_boot_id',
  'origin','evidence_canonicalization_version','evidence','observed_at','idempotency_key'],
  ARRAY['closure_event_id','proof_type','protocol_version','executor_id','boot_id','supervisor_id','supervisor_boot_id',
  'origin','evidence_canonicalization_version','evidence','observed_at','idempotency_key']);
 SELECT * INTO STRICT b FROM __NS__.evolution_executor_birth_bindings WHERE executor_id=(p->>'executor_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_supervisors WHERE supervisor_id=b.supervisor_id AND issuer_role=session_user) THEN
  RAISE EXCEPTION 'Closure issuer mismatch' USING ERRCODE='23514';
 END IF;
 IF b.boot_id IS DISTINCT FROM (p->>'boot_id')::uuid OR b.supervisor_id IS DISTINCT FROM (p->>'supervisor_id')::uuid
  OR b.supervisor_boot_id IS DISTINCT FROM (p->>'supervisor_boot_id')::uuid OR b.protocol_version IS DISTINCT FROM (p->>'protocol_version')::int THEN
  RAISE EXCEPTION 'Closure birth mismatch' USING ERRCODE='23514';
 END IF;
 IF typ='COOPERATIVE_SCOPE_CLOSED' THEN
  PERFORM __NS__.studiofy_stop_keys(ev,ARRAY['seal_id','admission_closed','scope_closed','active_tasks','active_descendants','active_transports',
   'pending_callbacks','pending_correlations','pending_sql','unresolved_sql','runtime_profile'],
   ARRAY['seal_id','admission_closed','scope_closed','active_tasks','active_descendants','active_transports',
   'pending_callbacks','pending_correlations','pending_sql','unresolved_sql','runtime_profile']);
  PERFORM (ev->>'seal_id')::uuid;
  IF ev->'admission_closed'<>'true'::jsonb OR ev->'scope_closed'<>'true'::jsonb
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['active_tasks','active_descendants','active_transports','pending_callbacks','pending_correlations','pending_sql','unresolved_sql']) k WHERE ev->k<>'0'::jsonb)
   OR ev->>'runtime_profile'<>b.runtime_profile THEN RAISE EXCEPTION 'Scope is not sealed and empty' USING ERRCODE='23514'; END IF;
 ELSIF typ='SUPERVISOR_PROCESS_EXIT' THEN
  PERFORM __NS__.studiofy_stop_keys(ev,ARRAY['exit_observed','exit_code','exit_signal','descendants_closed','sql_fenced','spawn_id'],
   ARRAY['exit_observed','descendants_closed','sql_fenced','spawn_id']);
  IF ev->'exit_observed'<>'true'::jsonb OR ev->'descendants_closed'<>'true'::jsonb OR ev->'sql_fenced'<>'true'::jsonb
   OR (ev->>'spawn_id')::uuid<>b.spawn_id OR ((ev->>'exit_code' IS NULL)=(ev->>'exit_signal' IS NULL))
   OR (ev->>'exit_code' IS NOT NULL AND (jsonb_typeof(ev->'exit_code')<>'number' OR (ev->>'exit_code')::int NOT BETWEEN 0 AND 255))
   OR (ev->>'exit_signal' IS NOT NULL AND ev->>'exit_signal' !~ '^SIG[A-Z0-9]{1,20}$') THEN
   RAISE EXCEPTION 'Insufficient process exit evidence' USING ERRCODE='23514';
  END IF;
 ELSE RAISE EXCEPTION 'Unsupported proof type' USING ERRCODE='23514'; END IF;
 h:=__NS__.studiofy_stop_hash(p);
 PERFORM pg_advisory_xact_lock(__NS__.studiofy_executor_gate_key(b.executor_id));
 SELECT state INTO STRICT g FROM __NS__.evolution_executor_gates WHERE executor_id=b.executor_id FOR UPDATE;
 SELECT * INTO old FROM __NS__.evolution_executor_closure_events WHERE supervisor_id=b.supervisor_id AND idempotency_key=p->>'idempotency_key';
 IF FOUND THEN
  IF old.semantic_content_hash<>h THEN RAISE EXCEPTION 'Closure idempotency conflict' USING ERRCODE='23514'; END IF;
  RETURN old.closure_event_id;
 END IF;
 IF typ='COOPERATIVE_SCOPE_CLOSED' AND g<>'DRAINING' THEN RAISE EXCEPTION 'Cooperative closure requires draining' USING ERRCODE='23514'; END IF;
 INSERT INTO __NS__.evolution_executor_closure_events(closure_event_id,proof_type,protocol_version,executor_id,boot_id,supervisor_id,supervisor_boot_id,
  origin,evidence_canonicalization_version,evidence,evidence_hash,observed_at,idempotency_key,semantic_content_hash)
 VALUES(id,typ,b.protocol_version,b.executor_id,b.boot_id,b.supervisor_id,b.supervisor_boot_id,p->>'origin',p->>'evidence_canonicalization_version',
  ev,__NS__.studiofy_stop_hash(ev),(p->>'observed_at')::timestamptz,p->>'idempotency_key',h)
 ON CONFLICT(supervisor_id,idempotency_key) DO NOTHING;
 SELECT * INTO STRICT old FROM __NS__.evolution_executor_closure_events WHERE supervisor_id=b.supervisor_id AND idempotency_key=p->>'idempotency_key';
 IF old.semantic_content_hash<>h THEN RAISE EXCEPTION 'Closure idempotency conflict' USING ERRCODE='23514'; END IF;
 IF g<>'CLOSED' THEN UPDATE __NS__.evolution_executor_gates SET state='CLOSED' WHERE executor_id=b.executor_id; END IF;
 RETURN old.closure_event_id;
END $f$;

CREATE FUNCTION __NS__.studiofy_accept_execution_stop(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c __NS__.evolution_executor_closure_events; e __NS__.evolution_operation_executions;
 old __NS__.evolution_execution_stop_proofs; id uuid := (p->>'proof_id')::uuid; h text; g text; fingerprint text;
BEGIN
 PERFORM __NS__.studiofy_stop_keys(p,ARRAY['proof_id','proof_type','protocol_version','closure_event_id','executor_id','boot_id','execution_id','source_schema',
  'assinatura_id','instance_name','operation_kind','delivery_id','claim_token','operation_token_fingerprint','supervisor_id','supervisor_boot_id',
  'evidence_canonicalization_version','evidence_hash','idempotency_key'],
  ARRAY['proof_id','proof_type','protocol_version','closure_event_id','executor_id','boot_id','execution_id','source_schema',
  'assinatura_id','instance_name','operation_kind','operation_token_fingerprint','supervisor_id','supervisor_boot_id','evidence_canonicalization_version','evidence_hash','idempotency_key']);
 SELECT * INTO STRICT c FROM __NS__.evolution_executor_closure_events WHERE closure_event_id=(p->>'closure_event_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_supervisors WHERE supervisor_id=c.supervisor_id AND issuer_role=session_user) THEN
  RAISE EXCEPTION 'Proof issuer mismatch' USING ERRCODE='23514';
 END IF;
 SELECT * INTO STRICT e FROM __NS__.evolution_operation_executions WHERE execution_id=(p->>'execution_id')::uuid;
 fingerprint:='sha256:'||encode(sha256(convert_to('studiofy.operation-token.v1:'||e.operation_token::text,'UTF8')),'hex');
 IF e.executor_id IS DISTINCT FROM c.executor_id OR c.executor_id IS DISTINCT FROM (p->>'executor_id')::uuid
  OR c.boot_id IS DISTINCT FROM (p->>'boot_id')::uuid OR c.supervisor_id IS DISTINCT FROM (p->>'supervisor_id')::uuid
  OR c.supervisor_boot_id IS DISTINCT FROM (p->>'supervisor_boot_id')::uuid OR c.proof_type IS DISTINCT FROM p->>'proof_type'
  OR c.protocol_version IS DISTINCT FROM (p->>'protocol_version')::int OR p->>'source_schema' IS DISTINCT FROM '__SCHEMA__'
  OR e.assinatura_id IS DISTINCT FROM (p->>'assinatura_id')::bigint OR e.instance_name IS DISTINCT FROM p->>'instance_name'
  OR e.operation_kind IS DISTINCT FROM p->>'operation_kind' OR e.delivery_id IS DISTINCT FROM (p->>'delivery_id')::bigint
  OR e.claim_token IS DISTINCT FROM (p->>'claim_token')::uuid OR fingerprint IS DISTINCT FROM p->>'operation_token_fingerprint'
  OR c.evidence_hash IS DISTINCT FROM p->>'evidence_hash' OR c.evidence_canonicalization_version IS DISTINCT FROM p->>'evidence_canonicalization_version' THEN
  RAISE EXCEPTION 'Proof subject or evidence mismatch' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(__NS__.studiofy_executor_gate_key(e.executor_id));
 SELECT state INTO STRICT g FROM __NS__.evolution_executor_gates WHERE executor_id=e.executor_id FOR UPDATE;
 IF g<>'CLOSED' THEN RAISE EXCEPTION 'Proof requires CLOSED gate' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM __NS__.evolution_execution_authorizations WHERE execution_id=e.execution_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Proof requires tracked authorization' USING ERRCODE='23514'; END IF;
 h:=__NS__.studiofy_stop_hash(p);
 INSERT INTO __NS__.evolution_execution_stop_proofs(proof_id,proof_type,protocol_version,closure_event_id,executor_id,boot_id,execution_id,source_schema,
  assinatura_id,instance_name,operation_kind,delivery_id,claim_token,operation_token_fingerprint,supervisor_id,supervisor_boot_id,origin,
  evidence_canonicalization_version,evidence_hash,observed_at,idempotency_key,semantic_content_hash)
 VALUES(id,c.proof_type,c.protocol_version,c.closure_event_id,e.executor_id,c.boot_id,e.execution_id,'__SCHEMA__',e.assinatura_id,e.instance_name,
  e.operation_kind,e.delivery_id,e.claim_token,fingerprint,c.supervisor_id,c.supervisor_boot_id,c.origin,c.evidence_canonicalization_version,
  c.evidence_hash,c.observed_at,p->>'idempotency_key',h) ON CONFLICT(supervisor_id,idempotency_key) DO NOTHING;
 SELECT * INTO STRICT old FROM __NS__.evolution_execution_stop_proofs WHERE supervisor_id=c.supervisor_id AND idempotency_key=p->>'idempotency_key';
 IF old.semantic_content_hash<>h THEN RAISE EXCEPTION 'Proof idempotency conflict' USING ERRCODE='23514'; END IF;
 INSERT INTO __NS__.evolution_execution_stops(execution_id,proof_id) VALUES(e.execution_id,old.proof_id) ON CONFLICT(execution_id) DO NOTHING;
 UPDATE __NS__.evolution_execution_authorizations SET state='UNKNOWN' WHERE execution_id=e.execution_id AND state='ACTIVE';
 RETURN old.proof_id;
END $f$;

CREATE FUNCTION __NS__.studiofy_execution_protocol_registration() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM __NS__.studiofy_execution_lock_gate(NEW.executor_id,'admission');
 RETURN NEW;
END $f$;
-- Runs AFTER the 029 BEFORE trigger acquired business locks.
CREATE TRIGGER execution_zz_protocol_registration BEFORE INSERT ON __NS__.evolution_operation_executions
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_registration();
CREATE FUNCTION __NS__.studiofy_execution_protocol_authorization() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ex uuid; purpose text;
BEGIN
 SELECT executor_id INTO STRICT ex FROM __NS__.evolution_operation_executions WHERE execution_id=NEW.execution_id;
 purpose:=CASE WHEN TG_OP='INSERT' THEN 'admission' WHEN NEW.state='ACTIVE' THEN 'renew' ELSE 'revoke' END;
 -- Proof revocation has already acquired the exclusive gate, and never renews.
 IF TG_OP='UPDATE' AND NEW.state='UNKNOWN' AND EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=NEW.execution_id) THEN purpose:='proof'; END IF;
 PERFORM __NS__.studiofy_execution_require_gate(ex,purpose);
 IF (TG_OP='INSERT' OR NEW.state='ACTIVE') AND EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=NEW.execution_id) THEN
  RAISE EXCEPTION 'STOPPED cannot acquire or renew authorization' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER execution_3b_authorization BEFORE INSERT OR UPDATE ON __NS__.evolution_execution_authorizations
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_authorization();

CREATE FUNCTION __NS__.studiofy_execution_protocol_delivery() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE e __NS__.evolution_operation_executions; purpose text;
BEGIN
 SELECT * INTO e FROM __NS__.evolution_operation_executions WHERE operation_token=OLD.operation_token;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_gates WHERE executor_id=e.executor_id) THEN RETURN NEW; END IF;
 purpose:=CASE WHEN OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL AND NEW.status='sending' THEN 'boundary' ELSE 'finalize' END;
 PERFORM __NS__.studiofy_execution_lock_gate(e.executor_id,purpose);
 PERFORM 1 FROM __NS__.evolution_execution_authorizations WHERE execution_id=e.execution_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=e.execution_id) THEN
  RAISE EXCEPTION 'STOPPED cannot mutate delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $f$;
-- Alphabetically before the 030 frontier trigger (which locks authorization).
CREATE TRIGGER execution_3b_delivery BEFORE UPDATE ON __NS__.whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_delivery();
CREATE TRIGGER execution_3b_delivery BEFORE UPDATE ON __NS__.appointment_reminders
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_delivery();

CREATE FUNCTION __NS__.studiofy_execution_lock_finalization(p_token uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE e __NS__.evolution_operation_executions;
BEGIN
 SELECT * INTO e FROM __NS__.evolution_operation_executions WHERE operation_token=p_token;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_gates WHERE executor_id=e.executor_id) THEN RETURN; END IF;
 IF e.operation_kind='whatsapp_messages' THEN
  PERFORM 1 FROM __NS__.whatsapp_messages WHERE id=e.delivery_id FOR UPDATE;
  PERFORM 1 FROM __NS__.whatsapp_conversation_responses WHERE delivery_id=e.delivery_id AND assinatura_id=e.assinatura_id ORDER BY delivery_id FOR UPDATE;
 ELSIF e.operation_kind='appointment_reminders' THEN
  PERFORM 1 FROM __NS__.appointment_reminders WHERE id=e.delivery_id FOR UPDATE;
 END IF;
 PERFORM __NS__.studiofy_execution_lock_gate(e.executor_id,'finalize');
 PERFORM 1 FROM __NS__.evolution_execution_authorizations WHERE execution_id=e.execution_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=e.execution_id) THEN
  RAISE EXCEPTION 'STOPPED cannot finalize or release ownership' USING ERRCODE='23514';
 END IF;
END $f$;

CREATE FUNCTION __NS__.studiofy_execution_protocol_owner() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE e __NS__.evolution_operation_executions;
BEGIN
 IF OLD.operation_token IS NULL OR NEW.operation_token IS NOT DISTINCT FROM OLD.operation_token THEN RETURN NEW; END IF;
 SELECT * INTO e FROM __NS__.evolution_operation_executions WHERE operation_token=OLD.operation_token;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM __NS__.evolution_executor_gates WHERE executor_id=e.executor_id) THEN RETURN NEW; END IF;
 -- Releasing an enrolled reservation requires business locks/gate/auth first.
 PERFORM __NS__.studiofy_execution_require_gate(e.executor_id,'finalize');
 IF EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=e.execution_id) THEN
  RAISE EXCEPTION 'STOPPED does not release reservation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER execution_3b_owner BEFORE UPDATE ON __NS__.evolution_instance_owners
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_owner();

CREATE FUNCTION __NS__.studiofy_execution_protocol_correlation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE e __NS__.evolution_operation_executions;
BEGIN
 IF NEW.provider_message_id IS NOT DISTINCT FROM OLD.provider_message_id THEN RETURN NEW; END IF;
 FOR e IN SELECT x.* FROM __NS__.evolution_operation_executions x JOIN __NS__.evolution_executor_gates g USING(executor_id)
  WHERE x.operation_kind='whatsapp_messages' AND x.delivery_id=OLD.delivery_id AND x.assinatura_id=OLD.assinatura_id ORDER BY x.execution_id LOOP
  PERFORM __NS__.studiofy_execution_lock_gate(e.executor_id,'finalize');
  PERFORM 1 FROM __NS__.evolution_execution_authorizations WHERE execution_id=e.execution_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM __NS__.evolution_execution_stops WHERE execution_id=e.execution_id) THEN
   RAISE EXCEPTION 'STOPPED correlation requires independent historical flow' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $f$;
CREATE TRIGGER execution_3b_correlation BEFORE UPDATE ON __NS__.whatsapp_conversation_responses
 FOR EACH ROW EXECUTE FUNCTION __NS__.studiofy_execution_protocol_correlation();

CREATE VIEW __NS__.evolution_execution_lifecycle_status AS
 SELECT e.execution_id,
 CASE WHEN s.execution_id IS NOT NULL THEN 'STOPPED'
  WHEN a.state='ACTIVE' AND a.lease_until>clock_timestamp() AND (g.executor_id IS NULL OR g.state='OPEN') THEN 'ACTIVE' ELSE 'UNKNOWN' END AS lifecycle_state,
 s.proof_id,s.recorded_at AS stopped_recorded_at
 FROM __NS__.evolution_operation_executions e
 LEFT JOIN __NS__.evolution_execution_authorizations a USING(execution_id)
 LEFT JOIN __NS__.evolution_executor_gates g ON g.executor_id=e.executor_id
 LEFT JOIN __NS__.evolution_execution_stops s USING(execution_id);

-- SQL invariants also apply to direct INSERT, even by the migration owner.
-- Administrative ALTER/DISABLE TRIGGER remains outside the ordinary-role model.
CREATE FUNCTION __NS__.studiofy_stop_record_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE matched boolean; executor uuid; g text;
BEGIN
 NEW.recorded_at:=clock_timestamp();
 IF TG_TABLE_NAME='evolution_supervisors' THEN
  NEW.issuer_role:=session_user;
 ELSIF TG_TABLE_NAME='evolution_executor_birth_bindings' THEN
  SELECT true INTO matched FROM __NS__.evolution_executors x JOIN __NS__.evolution_supervisors s ON s.supervisor_id=NEW.supervisor_id
   WHERE x.executor_id=NEW.executor_id AND x.boot_id=NEW.boot_id AND x.process_id=NEW.observed_pid
    AND x.instance_id IS NOT DISTINCT FROM NEW.instance_id AND x.revision IS NOT DISTINCT FROM NEW.revision
    AND s.supervisor_boot_id=NEW.supervisor_boot_id AND s.protocol_version=NEW.protocol_version
    AND x.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text
    AND NOT EXISTS(SELECT 1 FROM __NS__.evolution_operation_executions WHERE executor_id=x.executor_id);
  IF matched IS DISTINCT FROM true THEN RAISE EXCEPTION 'Birth must bind a new identity in the same transaction' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='evolution_executor_closure_events' THEN
  SELECT true INTO matched FROM __NS__.evolution_executor_birth_bindings b WHERE b.executor_id=NEW.executor_id AND b.boot_id=NEW.boot_id
   AND b.supervisor_id=NEW.supervisor_id AND b.supervisor_boot_id=NEW.supervisor_boot_id AND b.protocol_version=NEW.protocol_version;
  SELECT state INTO g FROM __NS__.evolution_executor_gates WHERE executor_id=NEW.executor_id;
  IF matched IS DISTINCT FROM true OR NOT __NS__.studiofy_execution_has_gate_ticket(NEW.executor_id,true)
   OR NEW.evidence_hash IS DISTINCT FROM __NS__.studiofy_stop_hash(NEW.evidence)
   OR (NEW.proof_type='COOPERATIVE_SCOPE_CLOSED' AND g IS DISTINCT FROM 'DRAINING') THEN
   RAISE EXCEPTION 'Closure identity, evidence or gate mismatch' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='evolution_execution_stop_proofs' THEN
  SELECT true INTO matched FROM __NS__.evolution_operation_executions e
   JOIN __NS__.evolution_executor_closure_events c ON c.closure_event_id=NEW.closure_event_id
   JOIN __NS__.evolution_executor_gates g ON g.executor_id=e.executor_id AND g.state='CLOSED'
   JOIN __NS__.evolution_execution_authorizations a ON a.execution_id=e.execution_id
   WHERE e.execution_id=NEW.execution_id AND e.executor_id=NEW.executor_id AND c.executor_id=e.executor_id AND c.boot_id=NEW.boot_id
    AND c.supervisor_id=NEW.supervisor_id AND c.supervisor_boot_id=NEW.supervisor_boot_id AND c.proof_type=NEW.proof_type
    AND c.protocol_version=NEW.protocol_version AND NEW.source_schema='__SCHEMA__'
    AND e.assinatura_id=NEW.assinatura_id AND e.instance_name=NEW.instance_name AND e.operation_kind=NEW.operation_kind
    AND e.delivery_id IS NOT DISTINCT FROM NEW.delivery_id AND e.claim_token IS NOT DISTINCT FROM NEW.claim_token
    AND NEW.operation_token_fingerprint='sha256:'||encode(sha256(convert_to('studiofy.operation-token.v1:'||e.operation_token::text,'UTF8')),'hex')
    AND c.origin=NEW.origin AND c.evidence_canonicalization_version=NEW.evidence_canonicalization_version
    AND c.evidence_hash=NEW.evidence_hash AND c.observed_at=NEW.observed_at;
  IF matched IS DISTINCT FROM true OR NOT __NS__.studiofy_execution_has_gate_ticket(NEW.executor_id,true) THEN
   RAISE EXCEPTION 'Proof identity or closed gate mismatch' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='evolution_execution_stops' THEN
  SELECT executor_id INTO executor FROM __NS__.evolution_execution_stop_proofs WHERE proof_id=NEW.proof_id AND execution_id=NEW.execution_id;
  IF executor IS NULL OR NOT __NS__.studiofy_execution_has_gate_ticket(executor,true) THEN
   RAISE EXCEPTION 'STOPPED must derive from a locked valid proof' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $f$;
$ddl$, '__NS__',ns), '__SCHEMA__',current_schema());
END $migration$;

-- No grants to an application issuer in 3B.1. The migration owner remains
-- privileged; actual credential/role separation requires operational activation.
DO $protection$
DECLARE ns text := quote_ident(current_schema()); name text; routine regprocedure; grantee text;
BEGIN
 FOREACH name IN ARRAY ARRAY['evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_closure_events',
  'evolution_execution_stop_proofs','evolution_execution_stops'] LOOP
  EXECUTE format('CREATE TRIGGER stop_evidence_insert BEFORE INSERT ON %s.%I FOR EACH ROW EXECUTE FUNCTION %s.studiofy_stop_record_guard()',ns,name,ns);
  EXECUTE format('CREATE TRIGGER stop_evidence_immutable BEFORE UPDATE OR DELETE ON %s.%I FOR EACH ROW EXECUTE FUNCTION %s.studiofy_execution_foundation_immutable()',ns,name,ns);
  EXECUTE format('CREATE TRIGGER stop_evidence_no_truncate BEFORE TRUNCATE ON %s.%I FOR EACH STATEMENT EXECUTE FUNCTION %s.studiofy_execution_foundation_immutable()',ns,name,ns);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_gates',
  'evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops','evolution_execution_lifecycle_status'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s.%I FROM PUBLIC',ns,name);
  -- Remove grants inherited from deployment-specific default ACLs as well.
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
   WHERE n.nspname=current_schema() AND c.relname=name AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s.%I FROM %I',ns,name,grantee);
  END LOOP;
 END LOOP;
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=current_schema() AND p.proname=ANY(ARRAY['studiofy_stop_hash','studiofy_stop_keys','studiofy_executor_gate_key',
   'studiofy_execution_lock_gate','studiofy_execution_require_gate','studiofy_register_supervisor','studiofy_register_executor_birth',
   'studiofy_executor_gate_guard','studiofy_advance_executor_gate','studiofy_accept_executor_closure','studiofy_accept_execution_stop',
   'studiofy_execution_protocol_registration','studiofy_execution_protocol_authorization','studiofy_execution_protocol_delivery',
   'studiofy_execution_lock_finalization','studiofy_execution_protocol_owner','studiofy_execution_protocol_correlation',
   'studiofy_execution_has_gate_ticket','studiofy_stop_record_guard']) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
   WHERE p.oid=routine::oid AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,grantee);
  END LOOP;
 END LOOP;
END $protection$;
