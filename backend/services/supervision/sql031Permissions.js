const { invalid, text } = require('./sql031Payloads');

const ledgers = Object.freeze(['evolution_supervisors', 'evolution_executor_birth_bindings', 'evolution_executor_gates',
  'evolution_executor_closure_events', 'evolution_execution_stop_proofs', 'evolution_execution_stops']);
const issuerFunctions = Object.freeze(['studiofy_register_supervisor(jsonb)', 'studiofy_register_executor_birth(jsonb)',
  'studiofy_advance_executor_gate(uuid,uuid,uuid,text)', 'studiofy_accept_executor_closure(jsonb)', 'studiofy_accept_execution_stop(jsonb)']);
// PostgreSQL internal allocation entrypoints, independent of SQL aliases/test objects.
const largeObjectAllocators = Object.freeze(['be_lo_creat', 'be_lo_create', 'be_lo_from_bytea', 'be_lo_import', 'be_lo_import_with_oid']);
// Scope: supervised delivery/outbox/reminder runtime, not every SaaS administration route.
const executorTables = Object.freeze(Object.fromEntries([
  ...['schema_migrations', 'configuracoes', 'assinaturas', 'agendamentos', 'clientes_saas', 'servicos_assinatura',
    'profissionais', 'profissional_servicos', 'business_types', 'evolution_ownership_models',
    'evolution_executors', 'evolution_execution_authorization_status', 'evolution_execution_lifecycle_status',
    'return_reminder_delivery'].map(n => [n, Object.freeze(['SELECT'])]),
  ...['appointment_reminder_origins', 'whatsapp_messages', 'appointment_reminders', 'return_reminders', 'whatsapp_conversations', 'whatsapp_conversation_responses',
    'whatsapp_conversation_inbox', 'whatsapp_conversation_actions', 'whatsapp_conversation_captures'].map(n => [n, Object.freeze(['SELECT', 'INSERT', 'UPDATE'])]),
  ['evolution_instance_owners', Object.freeze(['SELECT', 'UPDATE'])],
  ['evolution_operation_executions', Object.freeze(['SELECT', 'INSERT'])],
  ['evolution_execution_authorizations', Object.freeze(['SELECT', 'INSERT', 'UPDATE'])],
  ['evolution_delivery_reconciliations', Object.freeze(['SELECT', 'INSERT'])],
]));
const executorFunctions = Object.freeze([
  'studiofy_execution_lock_gate(uuid,text)', 'studiofy_execution_lock_finalization(uuid)',
  'studiofy_execution_lease_duration()', 'studiofy_evolution_instance_key(text)', 'studiofy_evolution_instance_name(text)',
  'studiofy_evolution_assert_owner(text,text,text)', 'studiofy_reminder_now()', 'studiofy_reminder_destination(text)',
  'studiofy_reminder_snapshot(bigint,bigint)', 'studiofy_reminder_refresh(bigint,bigint)',
  'studiofy_appointment_transport_policy(text)', 'studiofy_appointment_transport_policy_allows(text,bigint)',
  'studiofy_appointment_transport_allowed(bigint)', 'studiofy_return_now()', 'studiofy_return_delivery_open()',
  'studiofy_return_plain(text)', 'studiofy_return_phone(text)', 'studiofy_return_customer_key(bigint,text)',
  'studiofy_return_group_key(bigint,text,text)', 'studiofy_return_group_lock(bigint,text,text)',
  'studiofy_return_group_locked(bigint,text,text)', 'studiofy_return_supersede_group(bigint,text,text)',
  'studiofy_return_message_text(return_reminders)', 'studiofy_return_rule_ready(return_reminders)',
  'studiofy_return_outbox_ready(whatsapp_messages)',
]);
const issuerTables = Object.freeze(Object.fromEntries([...ledgers, 'evolution_executors', 'evolution_operation_executions',
  'evolution_execution_authorizations', 'evolution_execution_lifecycle_status'].map(n => [n, Object.freeze(['SELECT'])])));
const login = v => text(v, /^[a-z_][a-z0-9_]{0,62}$/);
function distinctLogins({ migratorLogin, issuerLogin, executorLogin }) {
  const names = [migratorLogin, issuerLogin, executorLogin].map(login);
  if (new Set(names).size !== 3) throw invalid();
  return Object.freeze(names);
}
// Preserve the existing issuer runner's exact fail-closed identity contract.
function assertIssuerIdentity(rows, issuerLogin, database) {
  const row = rows[0];
  if (rows.length !== 1 || row.session_user !== issuerLogin || row.current_user !== issuerLogin || row.database_name !== database ||
    ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'owns_schema', 'schema_create',
      'owns_database', 'ledger_write', 'migrator_member', 'executor_member'].some(k => row[k] !== false)) throw invalid();
}
const identitySql = `SELECT session_user::text AS login,current_user::text AS effective,current_database() AS database,
 current_schema() AS schema,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
 EXISTS(SELECT 1 FROM pg_roles o WHERE o.oid<>r.oid AND o.rolname<>'pg_database_owner'
   AND pg_has_role(r.oid,o.oid,'MEMBER')) AS membership,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE
   pg_has_role(r.oid,n.nspowner,'MEMBER') OR has_schema_privilege(r.oid,n.oid,'CREATE')) AS ddl_schema,
 has_database_privilege(session_user,current_database(),'CREATE') AS ddl_database,
 has_database_privilege(session_user,current_database(),'TEMP') AS ddl_temp,
 pg_has_role(r.oid,d.datdba,'MEMBER') AS owns_database,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE pg_has_role(r.oid,c.relowner,'MEMBER')) AS owns_relation,
 EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE pg_has_role(r.oid,p.proowner,'MEMBER')) AS owns_function,
 EXISTS(SELECT 1 FROM pg_type t WHERE pg_has_role(r.oid,t.typowner,'MEMBER')) AS owns_type
 FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=session_user`;
const relationsSql = `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
 array(SELECT v FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
   WHERE has_table_privilege(session_user,c.oid,v)) AS table_privileges,
 array(SELECT v FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
   WHERE has_table_privilege(session_user,c.oid,v) OR (v=ANY(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])
     AND has_any_column_privilege(session_user,c.oid,v))) AS privileges,
 (EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
   WHERE has_table_privilege(session_user,c.oid,v||' WITH GRANT OPTION')) OR
  EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(a.attacl)>0 THEN a.attacl END) acl
    WHERE a.attrelid=c.oid AND acl.is_grantable AND
     (acl.grantee=0 OR pg_has_role(session_user,acl.grantee,'USAGE')))) AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','v','m','p','f')
 AND NOT (c.oid<16384 AND n.nspname IN ('pg_catalog','information_schema'))`;
const functionsSql = `SELECT n.nspname AS schema,p.proname AS name,
 replace(pg_get_function_identity_arguments(p.oid),' ','') AS arguments,
 oidvectortypes(p.proargtypes) AS types,
 has_function_privilege(session_user,p.oid,'EXECUTE') AS executable,
 has_function_privilege(session_user,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE NOT (p.oid<16384 AND n.nspname IN ('pg_catalog','information_schema'))`;
const sequencesSql = `SELECT n.nspname AS schema,c.relname AS name,t.relname AS table_name,
 has_sequence_privilege(session_user,c.oid,'USAGE') AS usage,
 has_sequence_privilege(session_user,c.oid,'SELECT') AS readable,
 has_sequence_privilege(session_user,c.oid,'UPDATE') AS writable,
 has_sequence_privilege(session_user,c.oid,'USAGE WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
 LEFT JOIN pg_class t ON t.oid=d.refobjid
 WHERE c.relkind='S' AND NOT (c.oid<16384 AND n.nspname IN ('pg_catalog','information_schema'))`;

// Inspect ACL-bearing classes across ALL namespaces, including system objects.
// Only bootstrap objects (reserved OIDs in built-in schemas) may use their initial
// PUBLIC ACL as a baseline. pg_init_privs preserves initdb revocations such as
// restricted server-file APIs; acldefault alone would incorrectly permit those.
// Extensions/new objects do not become trusted just by using a system namespace.
const excessAclSql = `WITH objects AS (
 SELECT 'pg_class'::regclass AS classid,c.oid AS objid,0 AS subid,c.relowner AS owner,
  n.nspname AS schema,c.relname AS name,CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'relation' END AS kind,
  c.relacl AS acl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner) AS defaults,
  NULL::text AS signature,t.relname AS table_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_depend d ON c.relkind='S' AND d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
 LEFT JOIN pg_class t ON t.oid=d.refobjid WHERE c.relkind IN ('r','v','m','p','f','S')
 UNION ALL
 SELECT 'pg_class'::regclass,c.oid,a.attnum,c.relowner,n.nspname,c.relname,'column',a.attacl,
  '{}'::aclitem[],NULL::text,NULL::text
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
 UNION ALL
 SELECT 'pg_proc'::regclass,p.oid,0,p.proowner,n.nspname,p.proname,'routine',p.proacl,
  acldefault('f',p.proowner),p.proname||'('||replace(oidvectortypes(p.proargtypes),' ','')||')',NULL::text
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 UNION ALL
 SELECT 'pg_namespace'::regclass,n.oid,0,n.nspowner,n.nspname,n.nspname,'schema',n.nspacl,
  acldefault('n',n.nspowner),NULL::text,NULL::text FROM pg_namespace n
 UNION ALL
 SELECT 'pg_type'::regclass,t.oid,0,t.typowner,n.nspname,t.typname,'type',t.typacl,
  acldefault('T',t.typowner),NULL::text,NULL::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 UNION ALL
 SELECT 'pg_database'::regclass,d.oid,0,d.datdba,''::text,d.datname,'database',d.datacl,
  acldefault('d',d.datdba),NULL::text,NULL::text FROM pg_database d WHERE d.datname=current_database()
 UNION ALL
 SELECT 'pg_tablespace'::regclass,t.oid,0,t.spcowner,''::text,t.spcname,'tablespace',t.spcacl,
  acldefault('t',t.spcowner),NULL::text,NULL::text FROM pg_tablespace t
 UNION ALL
 SELECT 'pg_language'::regclass,l.oid,0,l.lanowner,''::text,l.lanname,
  CASE WHEN l.lanpltrusted THEN 'trusted_language' ELSE 'untrusted_language' END,l.lanacl,
  CASE WHEN l.lanpltrusted THEN acldefault('l',l.lanowner) ELSE NULL::aclitem[] END,NULL::text,NULL::text FROM pg_language l
 UNION ALL
 SELECT 'pg_foreign_data_wrapper'::regclass,w.oid,0,w.fdwowner,''::text,w.fdwname,'fdw',w.fdwacl,
  acldefault('F',w.fdwowner),NULL::text,NULL::text FROM pg_foreign_data_wrapper w
 UNION ALL
 SELECT 'pg_foreign_server'::regclass,s.oid,0,s.srvowner,''::text,s.srvname,'foreign_server',s.srvacl,
  acldefault('S',s.srvowner),NULL::text,NULL::text FROM pg_foreign_server s
 UNION ALL
 SELECT 'pg_largeobject_metadata'::regclass,l.oid,0,l.lomowner,''::text,l.oid::text,'large_object',l.lomacl,
  acldefault('L',l.lomowner),NULL::text,NULL::text FROM pg_largeobject_metadata l
 UNION ALL
 SELECT 'pg_parameter_acl'::regclass,p.oid,0,NULL::oid,''::text,p.parname,'parameter',p.paracl,
  NULL::aclitem[],NULL::text,NULL::text FROM pg_parameter_acl p
), expanded AS (
 SELECT o.*,a.grantor,a.grantee,a.privilege_type,a.is_grantable,
  (o.objid<16384 AND o.schema IN ('pg_catalog','information_schema')) AS builtin,
  coalesce(i.initprivs,o.defaults) AS initial_acl
 FROM objects o CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(coalesce(o.acl,o.defaults))>0 THEN coalesce(o.acl,o.defaults) END) a
 LEFT JOIN pg_init_privs i ON i.classoid=o.classid AND i.objoid=o.objid AND i.objsubid=o.subid AND i.privtype='i'
 WHERE CASE WHEN a.grantee=0 THEN true ELSE pg_has_role(session_user,a.grantee,'USAGE') END
 AND (o.kind<>'parameter' OR has_parameter_privilege(session_user,o.name,a.privilege_type))
)
SELECT schema,name,kind,subid,grantor::text,grantee::text,privilege_type,is_grantable FROM expanded e
WHERE e.is_grantable OR NOT (
 (e.kind IN ('schema','type') AND e.privilege_type='USAGE')
 OR (e.kind='database' AND e.privilege_type='CONNECT')
 OR (e.kind='trusted_language' AND e.privilege_type='USAGE')
 OR (e.kind='parameter' AND e.privilege_type='SET' AND EXISTS(
       SELECT 1 FROM pg_settings g WHERE g.name=e.name AND g.context='user'))
 OR (e.builtin AND e.schema='information_schema' AND e.kind IN ('relation','column') AND e.privilege_type='SELECT')
 OR (e.builtin AND EXISTS(SELECT 1 FROM aclexplode(CASE WHEN cardinality(e.initial_acl)>0 THEN e.initial_acl END) b
      WHERE b.grantee=0 AND b.privilege_type=e.privilege_type AND NOT b.is_grantable))
 OR (e.schema=$1 AND e.kind IN ('relation','column') AND coalesce(($2::jsonb->e.name) ? e.privilege_type,false))
 OR (e.schema=$1 AND e.kind='routine' AND e.privilege_type='EXECUTE' AND e.signature=ANY($3::text[]))
 OR (e.schema=$1 AND e.kind='sequence' AND e.privilege_type='USAGE' AND coalesce(($2::jsonb->e.table_name) ? 'INSERT',false))
)
UNION ALL
SELECT schema,name,kind,subid,owner::text,owner::text,'OWNERSHIP',false FROM objects o
 WHERE o.owner IS NOT NULL AND pg_has_role(session_user,o.owner,'MEMBER')
UNION ALL
SELECT ''::text,m.srvname,'user_mapping',0,NULL::text,m.umuser::text,'USAGE',false
 FROM pg_user_mappings m
 WHERE has_server_privilege(session_user,m.srvid,'USAGE')
 AND CASE WHEN m.umuser=0 THEN true ELSE pg_has_role(session_user,m.umuser,'MEMBER') END
UNION ALL
SELECT ''::text,p.proname,'large_object_allocator',0,NULL::text,session_user::text,'EXECUTE',false
 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
 WHERE p.pronamespace='pg_catalog'::regnamespace AND l.lanname='internal'
 AND p.prosrc=ANY($4::text[])
 AND has_function_privilege(session_user,p.oid,'EXECUTE')
UNION ALL
SELECT ''::text,s.classid::regclass::text||':'||s.objid::text,'dependent_object',s.objsubid,
 s.refobjid::text,s.refobjid::text,'OWNERSHIP',false FROM pg_shdepend s
 WHERE s.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
 AND s.deptype='o' AND s.refclassid='pg_authid'::regclass
 AND s.classid<>'pg_default_acl'::regclass
 AND pg_has_role(session_user,s.refobjid,'MEMBER')`;
function assertProfile({ identity, relations, functions, sequences, excessAcl }, { profile, expectedLogin, schema, database }) {
  login(expectedLogin);
  text(schema, /^test_[a-f0-9]{32}$/); text(database, /^test_[a-zA-Z0-9_]+$/);
  if (!['MIGRATOR', 'ISSUER', 'EXECUTOR'].includes(profile) || identity.login !== expectedLogin || identity.effective !== expectedLogin ||
      identity.database !== database || identity.schema !== schema ||
      ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'membership'].some(k => identity[k] !== false)) throw invalid();
  if (profile === 'MIGRATOR') {
    if (identity.owns_database !== true || identity.ddl_schema !== true) throw invalid();
    return Object.freeze({ profile, login: expectedLogin });
  }
  if (['ddl_schema', 'ddl_database', 'ddl_temp', 'owns_database', 'owns_relation', 'owns_function', 'owns_type'].some(k => identity[k] !== false) ||
      !Array.isArray(excessAcl) || excessAcl.length) throw invalid();
  const tables = profile === 'EXECUTOR' ? executorTables : issuerTables;
  const apis = profile === 'EXECUTOR' ? executorFunctions : issuerFunctions;
  for (const row of relations) {
    const allowed = row.schema === schema ? tables[row.name] || [] : [];
    if (row.grantable !== false || row.privileges.some(v => !allowed.includes(v))) throw invalid();
  }
  for (const row of functions) {
    const signature = row.name + '(' + row.types.replaceAll(' ', '') + ')';
    if (row.grantable !== false || (row.executable && (row.schema !== schema || !apis.includes(signature)))) throw invalid();
  }
  for (const row of sequences) {
    if (row.writable || row.readable || row.grantable || (row.usage &&
      (row.schema !== schema || !tables[row.table_name]?.includes('INSERT')))) throw invalid();
  }
  // Required capabilities, not merely the absence of excessive grants.
  for (const [name, privileges] of Object.entries(tables)) {
    const row = relations.find(r => r.schema === schema && r.name === name);
    if (!row || !Array.isArray(row.table_privileges) || privileges.some(v => !row.table_privileges.includes(v))) throw invalid();
  }
  for (const signature of apis) if (!functions.some(r => r.schema === schema && r.executable &&
    r.name + '(' + r.types.replaceAll(' ', '') + ')' === signature)) throw invalid();
  return Object.freeze({ profile, login: expectedLogin });
}
async function validatePermissions(client, options) {
  const { rows } = await client.query(identitySql);
  if (rows.length !== 1) throw invalid();
  const identity = rows[0];
  const resolved = { profile: options.profile, expectedLogin: options.expectedLogin || client.connectionParameters?.user,
    schema: options.schema || identity.schema, database: options.database || client.connectionParameters?.database };
  if (options.logins) distinctLogins(options.logins);
  const relations = (await client.query(relationsSql)).rows;
  const functions = (await client.query(functionsSql)).rows;
  const sequences = (await client.query(sequencesSql)).rows;
  const tables = options.profile === 'ISSUER' ? issuerTables : executorTables;
  const apis = options.profile === 'ISSUER' ? issuerFunctions : executorFunctions;
  const excessAcl = (await client.query(excessAclSql, [resolved.schema, JSON.stringify(tables), apis, largeObjectAllocators])).rows;
  return assertProfile({ identity, relations, functions, sequences, excessAcl }, resolved);
}
module.exports = { ledgers, issuerFunctions, issuerTables, executorTables, executorFunctions, largeObjectAllocators, distinctLogins,
  assertIssuerIdentity, assertProfile, validatePermissions };
