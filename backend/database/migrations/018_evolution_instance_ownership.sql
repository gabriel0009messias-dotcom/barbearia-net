-- One installation, one ownership namespace shared by both models.
-- Executed in the principal schema by either runner, in the same transaction.
DO $install$
DECLARE
 root text := current_schema();
 legacy text := coalesce(nullif(current_setting('studiofy.evolution_legacy_schema',true),''),'public');
 item record; sources text := ''; candidates text; collision boolean; invalid boolean; bound text;
BEGIN
 IF root !~ '^[a-z_][a-z0-9_]{0,62}$' OR legacy !~ '^[a-z_][a-z0-9_]{0,62}$' OR root=legacy THEN
  RAISE EXCEPTION 'Invalid Evolution ownership schema configuration' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext(root),0);
 -- Lock source tables before the registry. Normal writers lock a source row first.
 IF to_regclass(format('%I.assinaturas',root)) IS NOT NULL THEN
  EXECUTE format('LOCK TABLE %I.assinaturas IN SHARE ROW EXCLUSIVE MODE',root);
 END IF;
 IF to_regclass(format('%I.whatsapp_sessions',legacy)) IS NOT NULL THEN
  EXECUTE format('LOCK TABLE %I.whatsapp_sessions IN SHARE ROW EXCLUSIVE MODE',legacy);
 END IF;
 EXECUTE replace($ddl$
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_instance_key(value text) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT SET search_path TO pg_catalog AS $$
  SELECT nullif(translate(btrim(value,E' \t\r\n'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'')
 $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_instance_name(value text) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path TO pg_catalog AS $$
 DECLARE name text := nullif(btrim(value,E' \t\r\n'),'');
 BEGIN
  IF name IS NOT NULL AND (length(name)>100 OR name COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$') THEN
   RAISE EXCEPTION 'Invalid Evolution ownership instance name' USING ERRCODE='23514';
  END IF;
  RETURN name;
 END $$;
 CREATE TABLE IF NOT EXISTS @@ROOT@@.evolution_ownership_models (
  model text PRIMARY KEY CHECK(model IN ('principal','alternative')),
  source_schema text NOT NULL
 );
 CREATE TABLE IF NOT EXISTS @@ROOT@@.evolution_instance_owners (
  instance_key text COLLATE "C" PRIMARY KEY,
  instance_name text NOT NULL,
  model text NOT NULL REFERENCES @@ROOT@@.evolution_ownership_models(model),
  source_schema text NOT NULL,
  owner_id text NOT NULL,
  UNIQUE(model,source_schema,owner_id),
  CHECK(instance_key=@@ROOT@@.studiofy_evolution_instance_key(instance_name)),
  CHECK(instance_name=@@ROOT@@.studiofy_evolution_instance_name(instance_name)
    AND length(instance_name) BETWEEN 1 AND 100)
 );
 -- Durable operation fencing keeps ownership stable without holding SQL locks during I/O.
 ALTER TABLE @@ROOT@@.evolution_instance_owners ADD COLUMN IF NOT EXISTS operation_token uuid;
 ALTER TABLE @@ROOT@@.evolution_instance_owners ADD COLUMN IF NOT EXISTS operation_started_at timestamptz;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_operation_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.operation_token IS NOT NULL THEN
   IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Evolution ownership operation requires reconciliation' USING ERRCODE='23514';
   END IF;
   IF ROW(NEW.instance_key,NEW.instance_name,NEW.model,NEW.source_schema,NEW.owner_id)
     IS DISTINCT FROM ROW(OLD.instance_key,OLD.instance_name,OLD.model,OLD.source_schema,OLD.owner_id) THEN
    RAISE EXCEPTION 'Evolution ownership operation requires reconciliation' USING ERRCODE='23514';
   END IF;
   IF NEW.operation_token IS NOT NULL AND NEW.operation_token IS DISTINCT FROM OLD.operation_token THEN
    RAISE EXCEPTION 'Evolution ownership operation already reserved' USING ERRCODE='23514';
   END IF;
  END IF;
  IF TG_OP<>'DELETE' AND (NEW.operation_token IS NULL)<>(NEW.operation_started_at IS NULL) THEN
   RAISE EXCEPTION 'Invalid Evolution ownership operation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_assert_owner(kind text, installed text, owner text)
 RETURNS void LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 DECLARE actual text; target text; identity text; present boolean; registered text;
 BEGIN
  SELECT source_schema INTO registered FROM @@ROOT@@.evolution_ownership_models WHERE model=kind;
  IF registered IS DISTINCT FROM installed THEN
   RAISE EXCEPTION 'Evolution ownership source mismatch' USING ERRCODE='23514';
  END IF;
  IF kind='principal' THEN target:='assinaturas'; identity:='id';
  ELSIF kind='alternative' THEN target:='whatsapp_sessions'; identity:='salon_id';
  ELSE RAISE EXCEPTION 'Invalid Evolution ownership model' USING ERRCODE='23514'; END IF;
  IF to_regclass(format('%I.%I',installed,target)) IS NOT NULL THEN
   EXECUTE format('SELECT %I FROM %I.%I WHERE %I::text=$1',
    CASE WHEN kind='principal' THEN 'whatsapp_session' ELSE 'instance_name' END, installed,target,identity)
    INTO actual USING owner;
  END IF;
  IF @@ROOT@@.studiofy_evolution_instance_key(actual) IS NULL THEN
   IF EXISTS(SELECT 1 FROM @@ROOT@@.evolution_instance_owners WHERE model=kind AND source_schema=installed AND owner_id=owner) THEN
    RAISE EXCEPTION 'Orphan Evolution ownership is forbidden' USING ERRCODE='23514';
   END IF;
  ELSE
   SELECT EXISTS(SELECT 1 FROM @@ROOT@@.evolution_instance_owners WHERE model=kind
    AND source_schema=installed AND owner_id=owner AND instance_name=actual
    AND instance_key=@@ROOT@@.studiofy_evolution_instance_key(actual)) INTO present;
   IF NOT present THEN RAISE EXCEPTION 'Missing or inconsistent Evolution ownership' USING ERRCODE='23514'; END IF;
  END IF;
 END $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_owner_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
   PERFORM @@ROOT@@.studiofy_evolution_assert_owner(OLD.model,OLD.source_schema,OLD.owner_id);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
   PERFORM @@ROOT@@.studiofy_evolution_assert_owner(NEW.model,NEW.source_schema,NEW.owner_id);
  END IF;
  RETURN NULL;
 END $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_no_registry_truncate() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'Evolution ownership registry cannot be truncated' USING ERRCODE='23514'; END $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_source_normalize() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 BEGIN
  IF TG_ARGV[0]='principal' THEN NEW.whatsapp_session:=@@ROOT@@.studiofy_evolution_instance_name(NEW.whatsapp_session);
  ELSE NEW.instance_name:=@@ROOT@@.studiofy_evolution_instance_name(NEW.instance_name); END IF;
  RETURN NEW;
 END $$;
 CREATE OR REPLACE FUNCTION @@ROOT@@.studiofy_evolution_source_sync() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
 DECLARE kind text:=TG_ARGV[0]; previous_owner text; next_owner text; previous_name text; next_name text; registered text;
 BEGIN
  SELECT source_schema INTO registered FROM @@ROOT@@.evolution_ownership_models WHERE model=kind;
  IF registered IS DISTINCT FROM TG_TABLE_SCHEMA THEN
   RAISE EXCEPTION 'Evolution ownership source mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='TRUNCATE' THEN
   DELETE FROM @@ROOT@@.evolution_instance_owners WHERE model=kind AND source_schema=TG_TABLE_SCHEMA;
   RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
   IF kind='principal' THEN previous_owner:=OLD.id::text; previous_name:=OLD.whatsapp_session;
   ELSE previous_owner:=OLD.salon_id::text; previous_name:=OLD.instance_name; END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
   IF kind='principal' THEN
    next_owner:=NEW.id::text; next_name:=@@ROOT@@.studiofy_evolution_instance_name(NEW.whatsapp_session);
    NEW.whatsapp_session:=next_name;
   ELSE
    next_owner:=NEW.salon_id::text; next_name:=@@ROOT@@.studiofy_evolution_instance_name(NEW.instance_name);
    NEW.instance_name:=next_name;
   END IF;
   IF TG_OP='UPDATE' AND previous_owner=next_owner AND previous_name IS NOT DISTINCT FROM next_name THEN RETURN NEW; END IF;
  END IF;
  IF previous_owner IS NOT NULL THEN
   DELETE FROM @@ROOT@@.evolution_instance_owners WHERE model=kind AND source_schema=TG_TABLE_SCHEMA AND owner_id=previous_owner;
  END IF;
  IF next_name IS NOT NULL THEN
   INSERT INTO @@ROOT@@.evolution_instance_owners(instance_key,instance_name,model,source_schema,owner_id)
    VALUES (@@ROOT@@.studiofy_evolution_instance_key(next_name),next_name,kind,TG_TABLE_SCHEMA,next_owner);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END $$;
$ddl$, '@@ROOT@@',quote_ident(root));

 FOR item IN SELECT 'principal'::text kind,root installed,'assinaturas'::text tab,'id'::text identity,'whatsapp_session'::text field
  UNION ALL SELECT 'alternative',legacy,'whatsapp_sessions','salon_id','instance_name'
 LOOP
  EXECUTE format('SELECT source_schema FROM %I.evolution_ownership_models WHERE model=$1',root) INTO bound USING item.kind;
  IF bound IS NOT NULL AND bound<>item.installed THEN
   RAISE EXCEPTION 'Evolution ownership schema binding requires manual regularization' USING ERRCODE='23514';
  END IF;
  EXECUTE format('INSERT INTO %I.evolution_ownership_models(model,source_schema) VALUES ($1,$2) ON CONFLICT DO NOTHING',root)
   USING item.kind,item.installed;
  IF to_regclass(format('%I.%I',item.installed,item.tab)) IS NULL THEN CONTINUE; END IF;
  SELECT n.nspname INTO bound FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid=to_regclass(format('%I.%I',item.installed,item.tab)) AND t.tgname='studiofy_evolution_ownership_sync';
  IF bound IS NOT NULL AND bound<>root THEN
   RAISE EXCEPTION 'Evolution source already belongs to another ownership installation' USING ERRCODE='23514';
  END IF;
  IF sources<>'' THEN sources:=sources || ' UNION ALL '; END IF;
  sources:=sources || format('SELECT %L::text model,%L::text source_schema,%I::text owner_id,%I::text instance_name FROM %I.%I',
   item.kind,item.installed,item.identity,item.field,item.installed,item.tab);
 END LOOP;
 IF sources='' THEN sources:='SELECT NULL::text model,NULL::text source_schema,NULL::text owner_id,NULL::text instance_name WHERE false'; END IF;
 candidates:=format('SELECT model,source_schema,owner_id,instance_name,%I.studiofy_evolution_instance_key(instance_name) instance_key FROM (%s) s',root,sources);
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM (%s) c WHERE instance_key IS NOT NULL GROUP BY instance_key COLLATE "C" HAVING count(*)>1)',candidates) INTO collision;
 IF collision THEN RAISE EXCEPTION 'Evolution ownership collision: manual legacy regularization required' USING ERRCODE='23505'; END IF;
 EXECUTE format($q$SELECT EXISTS(SELECT 1 FROM (%s) c WHERE instance_key IS NOT NULL AND
  (instance_name<>btrim(instance_name,E' \t\r\n') OR length(instance_name)>100 OR instance_name COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'))$q$,candidates) INTO invalid;
 IF invalid THEN RAISE EXCEPTION 'Invalid legacy Evolution ownership: manual regularization required' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.evolution_instance_owners o WHERE NOT EXISTS(SELECT 1 FROM (%s) c WHERE c.model=o.model AND c.source_schema=o.source_schema AND c.owner_id=o.owner_id AND c.instance_name=o.instance_name AND c.instance_key=o.instance_key))',root,candidates) INTO invalid;
 IF invalid THEN RAISE EXCEPTION 'Evolution ownership registry diverges: manual regularization required' USING ERRCODE='23514'; END IF;
 EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_operation_guard ON %I.evolution_instance_owners',root);
 EXECUTE format('CREATE TRIGGER studiofy_evolution_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON %I.evolution_instance_owners FOR EACH ROW EXECUTE FUNCTION %I.studiofy_evolution_operation_guard()',root,root);
 EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_owner_guard ON %I.evolution_instance_owners',root);
 EXECUTE format('CREATE CONSTRAINT TRIGGER studiofy_evolution_owner_guard AFTER INSERT OR UPDATE OR DELETE ON %I.evolution_instance_owners DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION %I.studiofy_evolution_owner_guard()',root,root);
 EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_no_truncate ON %I.evolution_instance_owners',root);
 EXECUTE format('CREATE TRIGGER studiofy_evolution_no_truncate BEFORE TRUNCATE ON %I.evolution_instance_owners EXECUTE FUNCTION %I.studiofy_evolution_no_registry_truncate()',root,root);
 EXECUTE format('INSERT INTO %I.evolution_instance_owners(instance_key,instance_name,model,source_schema,owner_id) SELECT instance_key,instance_name,model,source_schema,owner_id FROM (%s) c WHERE instance_key IS NOT NULL ON CONFLICT DO NOTHING',root,candidates);
 FOR item IN SELECT 'principal'::text kind,root installed,'assinaturas'::text tab UNION ALL SELECT 'alternative',legacy,'whatsapp_sessions'
 LOOP
  IF to_regclass(format('%I.%I',item.installed,item.tab)) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_ownership_sync ON %I.%I',item.installed,item.tab);
  EXECUTE format('CREATE TRIGGER studiofy_evolution_ownership_sync AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.studiofy_evolution_source_sync(%L)',item.installed,item.tab,root,item.kind);
  EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_ownership_normalize ON %I.%I',item.installed,item.tab);
  EXECUTE format('CREATE TRIGGER studiofy_evolution_ownership_normalize BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.studiofy_evolution_source_normalize(%L)',item.installed,item.tab,root,item.kind);
  EXECUTE format('DROP TRIGGER IF EXISTS studiofy_evolution_ownership_truncate ON %I.%I',item.installed,item.tab);
  EXECUTE format('CREATE TRIGGER studiofy_evolution_ownership_truncate AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.studiofy_evolution_source_sync(%L)',item.installed,item.tab,root,item.kind);
 END LOOP;
END $install$;
