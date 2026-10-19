-- Authorization of NEW 15m/5m claims and transport frontiers only.
-- No seed: an absent policy is disabled, including on a fresh installation.
CREATE FUNCTION studiofy_appointment_transport_policy(raw text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE policy jsonb; identifier jsonb; seen text[] := ARRAY[]::text[];
BEGIN
 IF raw IS NULL OR length(raw)>65536 THEN RETURN NULL; END IF;
 BEGIN policy:=raw::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
 IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(policy) AS keys(k))
   IS DISTINCT FROM ARRAY['assinatura_ids','enabled','scope','version']::text[]
  OR policy->'version' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(policy->'enabled') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(policy->'scope') IS DISTINCT FROM 'string'
  OR policy->>'scope' NOT IN ('allowlist','all')
  OR jsonb_typeof(policy->'assinatura_ids') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 FOR identifier IN SELECT value FROM jsonb_array_elements(policy->'assinatura_ids') LOOP
  IF jsonb_typeof(identifier) IS DISTINCT FROM 'string'
   OR (identifier #>> '{}') !~ '^[1-9][0-9]{0,15}$' THEN RETURN NULL; END IF;
  IF (identifier #>> '{}')::bigint>9007199254740991
   OR (identifier #>> '{}')=ANY(seen) THEN RETURN NULL; END IF;
  seen:=array_append(seen,identifier #>> '{}');
 END LOOP;
 IF policy->>'scope'='all' AND cardinality(seen)<>0 THEN RETURN NULL; END IF;
 RETURN policy;
END $$;

CREATE FUNCTION studiofy_appointment_transport_policy_allows(raw text,tenant bigint) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE policy jsonb:=studiofy_appointment_transport_policy(raw);
BEGIN
 IF policy IS NULL OR tenant IS NULL OR tenant<=0 OR tenant>9007199254740991
  OR policy->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
 RETURN policy->>'scope'='all' OR (policy->'assinatura_ids') ? tenant::text;
END $$;

CREATE FUNCTION studiofy_appointment_transport_allowed(tenant bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT studiofy_appointment_transport_policy_allows(valor,tenant)
  FROM configuracoes WHERE chave='appointment_reminder_transport_policy_v1'),false)
$$;

-- A preseeded active policy must not silently authorize the first deployment.
DO $$ DECLARE policy jsonb; BEGIN
 SELECT studiofy_appointment_transport_policy(valor) INTO policy FROM configuracoes
  WHERE chave='appointment_reminder_transport_policy_v1';
 IF policy->'enabled'='true'::jsonb AND (policy->>'scope'='all'
  OR jsonb_array_length(policy->'assinatura_ids')>0) THEN
  RAISE EXCEPTION 'Initial appointment reminder transport policy must be disabled' USING ERRCODE='23514';
 END IF;
END $$;

CREATE FUNCTION studiofy_appointment_transport_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authorize boolean; raw text;
BEGIN
 IF NEW.reminder_kind NOT IN ('reminder_15m','reminder_5m') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN authorize:=NEW.status='sending';
 ELSE authorize:=NEW.status='sending' AND (
  OLD.status IS DISTINCT FROM 'sending' OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
  OR (OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL)); END IF;
 IF NOT authorize THEN RETURN NEW; END IF;
 -- Order: delivery row -> policy, never policy -> delivery row. Policy writers
 -- update this key alone. NOWAIT prevents inverse waiting; the lock ends at
 -- the claim/frontier COMMIT, before any HTTP. Never gate finalization/recovery.
 SELECT valor INTO raw FROM configuracoes WHERE chave='appointment_reminder_transport_policy_v1'
  FOR SHARE NOWAIT;
 IF NOT coalesce(studiofy_appointment_transport_policy_allows(raw,NEW.assinatura_id),false) THEN
  RAISE EXCEPTION 'Appointment reminder transport is not authorized' USING ERRCODE='55P03';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER studiofy_appointment_transport_guard BEFORE INSERT OR UPDATE ON appointment_reminders
 FOR EACH ROW EXECUTE FUNCTION studiofy_appointment_transport_guard();

DO $$ DECLARE routine regprocedure; BEGIN
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=current_schema() AND p.proname IN ('studiofy_appointment_transport_policy',
   'studiofy_appointment_transport_policy_allows','studiofy_appointment_transport_allowed',
   'studiofy_appointment_transport_guard')
 LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp',routine,current_schema()); END LOOP;
END $$;
