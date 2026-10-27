const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { hrtime, pid: diagnosticProcessPid } = require('node:process');
const { setTimeout, clearTimeout } = require('node:timers');
const { Pool } = require('pg');
const policy = require('../../services/supervision/sql031Permissions');
const { createControlSqlRunner } = require('../../services/supervision/sql031Transactions');
const { createSql031Authority } = require('../../services/supervision/sql031Authority');

// Error text/stack can contain SQL values, credentials or URLs. Only allowlisted
// metadata and fixed summaries go to TAP; original errors stay in .errors.
function cleanupDiagnostic(fixtureId, phase, resourceClass, error) {
  const read = key => { try { return error?.[key]; } catch { return undefined; } };
  const names = ['Error', 'TypeError', 'RangeError', 'AssertionError', 'AggregateError', 'DatabaseError', 'error'];
  const name = read('name'), code = read('code');
  const postgresCode = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const summaries = {
    '57P01': 'PostgreSQL administrative connection termination.',
    '57P02': 'PostgreSQL crash shutdown.', '57P03': 'PostgreSQL cannot accept connections.',
    '2BP01': 'PostgreSQL dependent objects prevent removal.',
    '55006': 'PostgreSQL resource is in use.', '42501': 'PostgreSQL insufficient privilege.',
    '40P01': 'PostgreSQL deadlock detected.', '40001': 'PostgreSQL serialization failure.',
    '53300': 'PostgreSQL connection limit reached.', '08006': 'PostgreSQL connection failure.',
  };
  return { phase, fixtureId, timestamp: new Date().toISOString(),
    errorName: names.includes(name) ? name : 'Error', postgresCode, resourceClass,
    message: code === 'CLIENT_TERMINAL_TIMEOUT' ? 'Fixture-owned clients did not emit end before the cleanup deadline.' :
      summaries[postgresCode] || 'Cleanup operation failed; original details redacted.' };
}
function createClientTerminalBarrier() {
  // Track object identity until end, independently of the bounded diagnostic ring.
  const pending = new Set(), observed = new WeakSet(), waiters = new Set();
  const state = () => ({ pendingClientCount: pending.size, pendingBackendPids: [...pending]
    .map(client => client.processID).filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 64) });
  return {
    track(client) {
      if (observed.has(client)) return;
      observed.add(client); pending.add(client);
      client.once('end', () => { pending.delete(client); for (const notify of waiters) notify(); });
    },
    wait(trace, resourceClass) {
      const timeoutMs = 5000;
      const record = (event, extra = {}) => trace.record(event, { resourceClass, ...state(), terminalWaitTimeoutMs: timeoutMs, ...extra });
      record('CLIENT_TERMINAL_WAIT_BEGIN');
      if (!pending.size) { record('CLIENT_TERMINAL_ALREADY_SATISFIED'); return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        let timer;
        const notify = () => {
          if (pending.size) return;
          clearTimeout(timer); waiters.delete(notify);
          record('CLIENT_TERMINAL_WAIT_RESOLVED'); resolve();
        };
        waiters.add(notify);
        timer = setTimeout(() => {
          waiters.delete(notify);
          const error = Object.assign(new Error('Fixture-owned clients did not emit end before the cleanup deadline.'), { code: 'CLIENT_TERMINAL_TIMEOUT' });
          record('CLIENT_TERMINAL_WAIT_TIMEOUT', { error }); reject(error);
        }, timeoutMs);
        notify(); // Recheck after subscribing; an already observed end is never lost.
      });
    },
  };
}
const terminationHistory = [];
const traceProcess = randomUUID().replaceAll('-', ''); let traceSequence = 0;
let diagnosticInstanceSequence = 0n;
function correlateTermination(events, receiver) {
  if (!Number.isSafeInteger(receiver.backendPid) || receiver.ownerKnown !== true || receiver.postgresCode !== '57P01') return { origin: 'UNKNOWN' };
  const precedes = (a, b) => a.processFingerprint === b.processFingerprint && Number.isSafeInteger(a.eventOrder) && Number.isSafeInteger(b.eventOrder) ?
    a.eventOrder < b.eventOrder : a.timestamp < b.timestamp;
  const matches = events.filter(e => e.event === 'DATABASE_DROP_BEGIN' && /^[a-f0-9]{32}$/.test(e.operationId || '') && e.clusterFingerprint === receiver.clusterFingerprint &&
    e.targetDatabase === receiver.database && e.targetPids?.includes(receiver.backendPid) && precedes(e, receiver) &&
    events.some(end => end.event === 'DATABASE_DROP_END' && end.operationId === e.operationId && end.fixtureId === e.fixtureId &&
      end.clusterFingerprint === e.clusterFingerprint && end.targetDatabase === e.targetDatabase &&
      end.targetPids?.includes(receiver.backendPid) && precedes(receiver, end)));
  return matches.length === 1 ? { origin: 'MATCHED', fixtureId: matches[0].fixtureId,
    operationId: matches[0].operationId, targetDatabase: matches[0].targetDatabase, backendPid: receiver.backendPid } : { origin: 'UNKNOWN' };
}
function connectionTrace(fixtureId, clusterId, history = terminationHistory) {
  if (!/^[a-f0-9]{32}$/.test(fixtureId)) throw Error('Random fixture identity required');
  // Logical fixture IDs may repeat; each trace instance still owns its artifact.
  const diagnosticRunId = traceProcess + '-' + diagnosticProcessPid + '-' + (++diagnosticInstanceSequence).toString();
  const events = [], clients = new Map(), database = 'test_sql031_' + fixtureId;
  const clusterFingerprint = createHash('sha256').update(String(clusterId)).digest('hex');
  const observedPools = new Map(), poolStates = new Map(), identities = new Map();
  // Opt-in, exclusive, bounded transport. Never write diagnostics into the tree.
  let diagnosticFd, diagnosticRows = 0;
  if (process.env.STUDIOFY_DIAGNOSTIC_DIR) {
    const directory = fs.realpathSync(process.env.STUDIOFY_DIAGNOSTIC_DIR);
    const relative = path.relative(path.resolve(__dirname, '../../..'), directory);
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('Diagnostic directory must be outside the repository');
    diagnosticFd = fs.openSync(path.join(directory, 'sql031-' + diagnosticRunId + '-' + fixtureId + '.jsonl'), 'wx', 0o600);
  }
  function persist(row) {
    if (diagnosticFd === undefined) return;
    try {
      if (diagnosticRows < 4096) fs.writeSync(diagnosticFd, JSON.stringify(row) + '\n');
      else if (diagnosticRows === 4096) fs.writeSync(diagnosticFd, JSON.stringify({ event: 'DIAGNOSTIC_LIMIT', fixtureId, diagnosticRunId, diagnosticProcessPid, limit: 4096 }) + '\n');
      diagnosticRows++;
    } catch { process.stderr.write('SQL031 diagnostic side-channel write failed.\n'); try { fs.closeSync(diagnosticFd); } catch {} diagnosticFd = undefined; }
  }
  const classes = ['admin', 'catalog_admin', 'migrator', 'issuer', 'executor', 'database', 'fixture'];
  const allowed = new Set(['POOL_CREATED', 'CLIENT_CONNECTED', 'CLIENT_ACQUIRED', 'CLIENT_RELEASED', 'CLIENT_END',
    'CLIENT_REMOVE', 'CLIENT_ERROR', 'POOL_END_REQUESTED', 'POOL_END_BEGIN', 'POOL_END_RESOLVED', 'POOL_END_COMPLETE', 'POOL_END_ERROR',
    'ROLE_DROP_BEGIN', 'ROLE_DROP_END', 'ROLE_DROP_ERROR',
    'CLIENT_TERMINAL_WAIT_BEGIN', 'CLIENT_TERMINAL_ALREADY_SATISFIED', 'CLIENT_TERMINAL_WAIT_RESOLVED', 'CLIENT_TERMINAL_WAIT_TIMEOUT',
    'DATABASE_DROP_BLOCKED',
    'DATABASE_DROP_BEGIN', 'DATABASE_DROP_END', 'DATABASE_DROP_ERROR', 'FIXTURE_CLEANUP_BEGIN', 'FIXTURE_CLEANUP_END']);
  function record(event, fields = {}) {
    if (!allowed.has(event)) throw Error('Unknown diagnostic event');
    const backendPid = Number.isSafeInteger(fields.backendPid) && fields.backendPid > 0 ? fields.backendPid : null;
    const resourceClass = classes.includes(fields.resourceClass) ? fields.resourceClass : 'fixture';
    if (event.startsWith('POOL_END_')) poolStates.set(resourceClass, event);
    const pool = observedPools.get(resourceClass);
    const row = { event, fixtureId, diagnosticRunId, diagnosticProcessPid, clusterFingerprint, database: resourceClass === 'admin' ? null : database,
      roleName: ['migrator', 'issuer', 'executor'].includes(resourceClass) ? 'test_' + resourceClass + '_' + fixtureId : null,
      processFingerprint: traceProcess, eventOrder: ++traceSequence,
      timestamp: new Date().toISOString(), resourceClass, backendPid };
    row.monotonicNs = hrtime.bigint().toString();
    Object.assign(row, identities.get(resourceClass));
    row.poolLifecycleState = poolStates.get(resourceClass) || 'OPEN';
    row.poolCounts = pool ? Object.fromEntries(['totalCount', 'idleCount', 'waitingCount'].map(key =>
      [key, Number.isSafeInteger(pool[key]) ? pool[key] : null])) : null;
    row.trackedBackendPids = [...clients.values()].filter(c => c.resourceClass === resourceClass && !c.ended).map(c => c.backendPid).slice(0, 64);
    if (Number.isSafeInteger(fields.pendingClientCount) && fields.pendingClientCount >= 0) row.pendingClientCount = fields.pendingClientCount;
    if (Array.isArray(fields.pendingBackendPids)) row.pendingBackendPids = fields.pendingBackendPids.filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 64);
    if (fields.terminalWaitTimeoutMs === 5000) row.terminalWaitTimeoutMs = 5000;
    if (event.startsWith('DATABASE_DROP_')) { row.operationCategory = 'DROP_DATABASE_FORCE'; row.targetPidEvidence = 'TRACKED_CLIENTS_NOT_SERVER_VERIFIED'; }
    if (event.startsWith('ROLE_DROP_')) {
      row.phase = 'ROLE_DROP'; row.operationCategory = 'DROP_ROLE';
      row.targetRole = ['migrator', 'issuer', 'executor'].includes(resourceClass) ? 'test_' + resourceClass + '_' + fixtureId : null;
    }
    if (event.startsWith('DATABASE_DROP_')) row.phase = 'DATABASE_DROP';
    if (typeof fields.operationId === 'string' && /^[a-f0-9]{32}$/.test(fields.operationId)) row.operationId = fields.operationId;
    if (typeof fields.targetDatabase === 'string' && /^test_sql031_[a-f0-9]{32}$/.test(fields.targetDatabase)) row.targetDatabase = fields.targetDatabase;
    if (Array.isArray(fields.targetPids)) row.targetPids = fields.targetPids.filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 64);
    if (fields.error) {
      const safe = cleanupDiagnostic(fixtureId, event, row.resourceClass, fields.error);
      Object.assign(row, { errorName: safe.errorName, postgresCode: safe.postgresCode, message: safe.message });
      if (!row.phase) row.phase = event === 'CLIENT_ERROR' ? 'ASYNC_POOL_ERROR' : event;
    }
    events.push(row); if (events.length > 128) events.shift();
    persist(row);
    if (event.startsWith('DATABASE_DROP_')) { history.push(row); if (history.length > 256) history.shift(); }
    return row;
  }
  return { record, observePool(resourceClass, pool) {
    observedPools.set(resourceClass, pool);
    const url = pool.options?.connectionString ? new URL(pool.options.connectionString) : null;
    const fingerprint = value => createHash('sha256').update(String(value || '')).digest('hex');
    identities.set(resourceClass, { databaseFingerprint: fingerprint(url?.pathname || pool.options?.database),
      roleFingerprint: fingerprint(url?.username || pool.options?.user) });
  },
    connected(client, resourceClass) {
      resourceClass = classes.includes(resourceClass) ? resourceClass : 'fixture';
      const pid = client.processID;
      if (!Number.isSafeInteger(pid) || pid < 1) return;
      if (clients.size >= 64 && !clients.has(pid)) clients.delete(clients.keys().next().value);
      clients.set(pid, { backendPid: pid, resourceClass, ended: false });
      record('CLIENT_CONNECTED', { backendPid: pid, resourceClass });
      client.once('end', () => { const c = clients.get(pid); if (c) c.ended = true; record('CLIENT_END', { backendPid: pid, resourceClass }); });
    },
    beginDrop() { return record('DATABASE_DROP_BEGIN', { operationId: randomUUID().replaceAll('-', ''), resourceClass: 'database',
      backendPid: [...clients.values()].find(c => c.resourceClass === 'admin' && !c.ended)?.backendPid,
      targetDatabase: database, targetPids: [...clients.values()].filter(c => c.resourceClass !== 'admin' && !c.ended).map(c => c.backendPid) }); },
    snapshot() {
      const receivers = events.filter(e => e.event === 'CLIENT_ERROR');
      const related = history.filter(e => receivers.some(c => e.targetPids?.includes(c.backendPid) && e.targetDatabase === c.database)).slice(-32);
      return { owners: [...clients.values()].map(c => ({ ...c, fixtureId, database: c.resourceClass === 'admin' ? null : database, clusterFingerprint })), events: [...events],
        relatedTerminations: related, correlations: receivers.map(c => ({ backendPid: c.backendPid,
          ...correlateTermination(related, { ...c, ownerKnown: clients.has(c.backendPid) }) })) };
    },
  };
}
function cleanupFailure(errors, diagnostics, trace) {
  const lifecycle = trace.snapshot();
  const error = new AggregateError(errors, 'Local permission fixture cleanup failed. ' + JSON.stringify(diagnostics) + ' lifecycle=' + JSON.stringify(lifecycle));
  error.cleanupDiagnostics = diagnostics;
  error.lifecycleTrace = lifecycle;
  return error;
}

function localTestUrl(raw) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^test_[a-zA-Z0-9_]+$/.test(url.pathname.slice(1)) ||
      url.search || url.hash) throw Error('Exclusive loopback test database required.');
  return url;
}
async function permissionFixture(t) {
  // Validate BEFORE constructing any pool, including the provisioning connection.
  const url = localTestUrl(process.env.TEST_DATABASE_URL);
  const clusterDir = process.env.SQL031_ISOLATED_CLUSTER_DIR, clusterId = process.env.SQL031_ISOLATED_CLUSTER_ID;
  if (!clusterDir || !/^\d+$/.test(clusterId || '')) throw Error('Explicit isolated test cluster identity required.');
  const suffix = randomUUID().replaceAll('-', ''), schema = 'test_' + suffix, database = 'test_sql031_' + suffix;
  const roles = Object.fromEntries(['migrator', 'issuer', 'executor'].map(k => [k, 'test_' + k + '_' + suffix]));
  const logins = { migratorLogin: roles.migrator, issuerLogin: roles.issuer, executorLogin: roles.executor };
  policy.distinctLogins(logins);
  const trace = connectionTrace(suffix, clusterId);
  const admin = new Pool({ connectionString: url.toString(), max: 1 }), pools = [], created = [];
  const poolClasses = new WeakMap(), clientBarriers = new WeakMap(), asynchronousDiagnostics = [];
  const asynchronousErrors = [];
  const observe = (pool, poolClass) => {
    poolClasses.set(pool, poolClass);
    trace.observePool(poolClass, pool);
    const barrier = poolClass === 'admin' ? null : createClientTerminalBarrier();
    if (barrier) clientBarriers.set(pool, barrier);
    trace.record('POOL_CREATED', { resourceClass: poolClass });
    pool.on('connect', client => { trace.connected(client, poolClass); barrier?.track(client); });
    for (const [name, event] of [['acquire', 'CLIENT_ACQUIRED'], ['remove', 'CLIENT_REMOVE']])
      pool.on(name, client => trace.record(event, { resourceClass: poolClass, backendPid: client.processID }));
    pool.on('release', (_error, client) => trace.record('CLIENT_RELEASED', { resourceClass: poolClass, backendPid: client.processID }));
    pool.on('error', (e, client) => {
      asynchronousErrors.push(e);
      asynchronousDiagnostics.push(cleanupDiagnostic(suffix, 'ASYNC_POOL_ERROR', poolClass, e));
      trace.record('CLIENT_ERROR', { resourceClass: poolClass, backendPid: client?.processID, error: e });
    });
  };
  observe(admin, 'admin');
  let databaseCreated = false;
  let autoConfHash;
  const s = '"' + schema + '"';
  t.after(async () => {
    trace.record('FIXTURE_CLEANUP_BEGIN');
    const failures = [], diagnostics = [];
    const capture = (phase, resourceClass, e) => {
      failures.push(e); diagnostics.push(cleanupDiagnostic(suffix, phase, resourceClass, e));
    };
    let clientsTerminal = true;
    for (const pool of pools) {
      const resourceClass = poolClasses.get(pool);
      trace.record('POOL_END_REQUESTED', { resourceClass }); trace.record('POOL_END_BEGIN', { resourceClass });
      try { await pool.end(); trace.record('POOL_END_RESOLVED', { resourceClass }); trace.record('POOL_END_COMPLETE', { resourceClass }); }
      catch (e) { trace.record('POOL_END_ERROR', { resourceClass, error: e }); capture('POOL_CLOSE', resourceClass, e); }
      try { await clientBarriers.get(pool).wait(trace, resourceClass); }
      catch (e) { clientsTerminal = false; capture('CLIENT_TERMINAL_WAIT', resourceClass, e); }
    }
    let phase = 'DATABASE_DROP', resourceClass = 'database';
    try {
      if (clientsTerminal) {
        if (databaseCreated) {
          const drop = trace.beginDrop();
          await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
          trace.record('DATABASE_DROP_END', { resourceClass: 'database', operationId: drop.operationId,
            backendPid: drop.backendPid, targetDatabase: database, targetPids: drop.targetPids });
        }
        phase = 'ROLE_DROP';
        for (const role of created.reverse()) {
          resourceClass = Object.keys(roles).find(kind => roles[kind] === role);
          trace.record('ROLE_DROP_BEGIN', { resourceClass });
          try { await admin.query('DROP ROLE "' + role + '"'); trace.record('ROLE_DROP_END', { resourceClass }); }
          catch (e) { trace.record('ROLE_DROP_ERROR', { resourceClass, error: e }); throw e; }
        }
        phase = 'DATABASE_ABSENCE_CHECK'; resourceClass = 'database';
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
        phase = 'ROLE_ABSENCE_CHECK'; resourceClass = 'roles';
        assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [Object.values(roles)])).rowCount, 0);
        phase = 'AUTO_CONF_HASH_CHECK'; resourceClass = 'auto_conf';
        if (autoConfHash) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(clusterDir, 'postgresql.auto.conf'))).digest('hex'), autoConfHash);
      } else trace.record('DATABASE_DROP_BLOCKED', { resourceClass: 'database' });
    } catch (e) { if (phase === 'DATABASE_DROP') trace.record('DATABASE_DROP_ERROR', { resourceClass: 'database', error: e }); capture(phase, resourceClass, e); }
    finally {
      trace.record('POOL_END_REQUESTED', { resourceClass: 'admin' });
      trace.record('POOL_END_BEGIN', { resourceClass: 'admin' });
      try { await admin.end(); trace.record('POOL_END_RESOLVED', { resourceClass: 'admin' }); trace.record('POOL_END_COMPLETE', { resourceClass: 'admin' }); }
      catch (e) {
        trace.record('POOL_END_ERROR', { resourceClass: 'admin', error: e });
        capture('ADMIN_POOL_CLOSE', 'admin', e);
        trace.record('FIXTURE_CLEANUP_END');
        throw cleanupFailure([...failures, ...asynchronousErrors], [...diagnostics, ...asynchronousDiagnostics], trace);
      }
    }
    failures.push(...asynchronousErrors);
    trace.record('FIXTURE_CLEANUP_END');
    if (failures.length) throw cleanupFailure(failures, [...diagnostics, ...asynchronousDiagnostics], trace);
  });
  const info = (await admin.query("SELECT current_setting('data_directory') AS directory,(SELECT system_identifier::text FROM pg_control_system()) AS id")).rows[0];
  assert.equal(path.resolve(info.directory), path.resolve(clusterDir)); assert.equal(info.id, clusterId);
  assert.equal(fs.readFileSync(path.join(clusterDir, 'PG_VERSION'), 'utf8').trim(), '18');
  const databases = (await admin.query('SELECT datname FROM pg_database')).rows;
  assert.ok(databases.every(r => ['postgres', 'template0', 'template1'].includes(r.datname) || /^test_/.test(r.datname)), 'Non-test workload in cluster');
  autoConfHash = createHash('sha256').update(fs.readFileSync(path.join(clusterDir, 'postgresql.auto.conf'))).digest('hex');
  const urls = {};
  for (const [kind, role] of Object.entries(roles)) {
    const password = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE "' + role + '" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'' + password + '\'');
    created.push(role);
    const connection = new URL(url); connection.pathname = '/' + database; connection.username = role; connection.password = password;
    urls[kind] = connection.toString();
  }
  await admin.query('CREATE DATABASE "' + database + '" OWNER "' + roles.migrator + '"'); databaseCreated = true;
  // System-object ACL fault injection must be confined to THIS disposable DB.
  const catalogUrl = new URL(url); catalogUrl.pathname = '/' + database;
  const catalogAdmin = new Pool({ connectionString: localTestUrl(catalogUrl.toString()).toString(), max: 1 });
  observe(catalogAdmin, 'catalog_admin'); pools.push(catalogAdmin);
  function poolFor(kind) {
    const pool = new Pool({ connectionString: urls[kind], max: 5, options: '-c search_path=' + schema + ',public', query_timeout: 0 });
    observe(pool, kind); pools.push(pool); return pool;
  }
  const migrator = poolFor('migrator'), issuer = poolFor('issuer'), executor = poolFor('executor');
  await require('../../database/migrate').migrate(migrator, schema);
  // Large-object allocation is outside the delivery manifest, even via PUBLIC.
  const allocators = (await catalogAdmin.query(`SELECT format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='pg_catalog' AND l.lanname='internal' AND p.prosrc=ANY($1::text[])`, [policy.largeObjectAllocators])).rows;
  for (const row of allocators) await catalogAdmin.query('REVOKE EXECUTE ON FUNCTION ' + row.signature + ' FROM PUBLIC');
  await migrator.query('REVOKE CREATE,TEMP ON DATABASE "' + database + '" FROM PUBLIC');
  await migrator.query('GRANT USAGE ON SCHEMA ' + s + ' TO "' + roles.executor + '","' + roles.issuer + '"');
  const routines = (await migrator.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [schema])).rows;
  for (const row of routines) await migrator.query('REVOKE EXECUTE ON FUNCTION ' + row.signature + ' FROM PUBLIC');
  for (const [kind, tables, functions] of [
    ['executor', policy.executorTables, policy.executorFunctions], ['issuer', policy.issuerTables, policy.issuerFunctions],
  ]) {
    for (const [table, privileges] of Object.entries(tables)) await migrator.query('GRANT ' + privileges.join(',') + ' ON ' + s + '."' + table + '" TO "' + roles[kind] + '"');
    for (const signature of functions) await migrator.query('GRANT EXECUTE ON FUNCTION ' + s + '.' + signature + ' TO "' + roles[kind] + '"');
  }
  const sequences = (await migrator.query(`SELECT c.oid::regclass::text AS sequence,t.relname AS table_name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid=d.refobjid WHERE c.relkind='S' AND n.nspname=$1`, [schema])).rows;
  for (const row of sequences) if (policy.executorTables[row.table_name]?.includes('INSERT'))
    await migrator.query('GRANT USAGE ON SEQUENCE ' + row.sequence + ' TO "' + roles.executor + '"');
  async function validate(kind, extra = {}) {
    const client = await ({ migrator, issuer, executor }[kind]).connect();
    try { return await policy.validatePermissions(client, { profile: kind.toUpperCase(), expectedLogin: roles[kind], schema, database, logins, ...extra }); }
    finally { client.release(); }
  }
  function authority(identity) {
    return createSql031Authority({ transactionRunner: createControlSqlRunner({ pool: issuer, authority: 'SUPERVISOR_PROOF_ISSUER',
      ...logins, schema, database, localTestOnly: true }), issuerIdentity: identity });
  }
  function supervisionAuthority({ beforeBirth = async () => {} } = {}) {
    let control;
    const confirmed = result => { assert.equal(result.outcome, 'CONFIRMED'); return result; };
    return { localTestOnly: true,
      async enrollBirth(session) {
        await beforeBirth();
        control = authority({ supervisor_id: session.supervisor_id, supervisor_boot_id: session.supervisor_boot_id });
        confirmed(await control.registerSupervisor({ supervisor_id: session.supervisor_id, supervisor_boot_id: session.supervisor_boot_id,
          protocol_version: 1, process_id: process.pid, origin: 'local-parent-v1' }));
        confirmed(await control.registerExecutorBirth({ executor_id: session.executor_id, boot_id: session.boot_id,
          supervisor_id: session.supervisor_id, supervisor_boot_id: session.supervisor_boot_id, spawn_id: session.spawn_id,
          observed_pid: session.observed_pid, session_challenge: session.challenge, protocol_version: 1,
          runtime_profile: session.runtime_profile, observed_at: new Date().toISOString(), started_at: session.started_at }));
      },
      async openGate(session) { confirmed(await control.openExecutorGate({ executor_id: session.executor_id, boot_id: session.boot_id })); },
      async beginDraining(session) { if (control) confirmed(await control.beginExecutorDraining({ executor_id: session.executor_id, boot_id: session.boot_id })); },
    };
  }
  async function noStop() {
    for (const name of ['evolution_executor_closure_events', 'evolution_execution_stop_proofs', 'evolution_execution_stops'])
      assert.equal((await migrator.query('SELECT count(*)::int AS n FROM ' + s + '.' + name)).rows[0].n, 0);
  }
  return { schema, database, roles, logins, urls, migrator, issuer, executor, s, validate, authority, supervisionAuthority, noStop,
    // Only isolated test fixtures may manipulate role membership/grants.
    admin, catalogAdmin, asynchronousErrors };
}
function runLocalScript(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-'], { cwd: path.join(__dirname, '../..'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(Error('Local child failed: ' + stderr)));
    child.stdin.end(source);
  });
}
module.exports = { localTestUrl, permissionFixture, runLocalScript, connectionTrace, correlateTermination, createClientTerminalBarrier };
