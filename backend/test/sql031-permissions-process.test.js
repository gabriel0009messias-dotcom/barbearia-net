const { test } = require('node:test');
const assert = require('node:assert/strict');
const { permissionFixture, runLocalScript } = require('./helpers/sql031PermissionFixture');
const { executorEnvironment } = require('../services/supervision/environment');
const { startSupervisor } = require('../supervisor');
test('B3: real child receives only executor login and cannot close authority', { timeout: 60000 }, async t => {
  const f = await permissionFixture(t);
  const env = executorEnvironment({ NODE_ENV: 'test', DATABASE_SCHEMA: f.schema, DATABASE_URL: f.urls.migrator,
    ISSUER_DATABASE_URL: f.urls.issuer, MIGRATOR_DATABASE_URL: f.urls.migrator, CONTROL_SECRET: 'synthetic-only' }, { executorDatabaseUrl: f.urls.executor });
  const output = await runLocalScript(`
    const assert=require('node:assert/strict');
    const {Pool}=require('pg');
    assert.equal(process.env.ISSUER_DATABASE_URL,undefined);assert.equal(process.env.MIGRATOR_DATABASE_URL,undefined);
    assert.equal(process.env.CONTROL_SECRET,undefined);
    const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.env.DATABASE_SCHEMA+',public'});
    (async()=>{try{
      await require('./services/supervision/preparedSchema').verifyPreparedSchema(pool);
      const row=(await pool.query('SELECT session_user,current_user')).rows[0];
      assert.equal(row.session_user,new URL(process.env.DATABASE_URL).username);assert.equal(row.current_user,row.session_user);
      await assert.rejects(pool.query("SELECT studiofy_accept_executor_closure('{}'::jsonb)"),{code:'42501'});
      await assert.rejects(pool.query("SELECT studiofy_accept_execution_stop('{}'::jsonb)"),{code:'42501'});
      console.log('RESTRICTED_CHILD_PASS');
    }finally{await pool.end();}})().catch(()=>{process.exitCode=1;console.error('Restricted child failed');});`, env);
  assert.match(output, /RESTRICTED_CHILD_PASS/); await f.noStop();
});
test('B3: privileged database credential fails the real prepared-schema boundary', { timeout: 60000 }, async t => {
  const f = await permissionFixture(t);
  for (const kind of ['migrator', 'issuer']) {
    const output = await runLocalScript(`
      const assert=require('node:assert/strict'),{Pool}=require('pg');
      const p=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.env.DATABASE_SCHEMA+',public'});
      (async()=>{try{await assert.rejects(require('./services/supervision/preparedSchema').verifyPreparedSchema(p),e=>['SQL031_INPUT_INVALID','42501'].includes(e.code));
      console.log('EXCESS_REJECTED');}finally{await p.end();}})().catch(()=>{process.exitCode=1;console.error('Privilege boundary failed');});`,
    executorEnvironment({ NODE_ENV: 'test', DATABASE_SCHEMA: f.schema }, { executorDatabaseUrl: f.urls[kind] }));
    assert.match(output, /EXCESS_REJECTED/);
  }
  await f.noStop();
});
test('B3: subprocess exit, signals, timeout and IPC loss cannot create SQL031 STOP', { timeout: 120000 }, async t => {
  const f = await permissionFixture(t);
  for (const reason of ['exit', 'SIGTERM', 'SIGINT', 'timeout', 'disconnect']) await t.test(reason, async () => {
    const s = startSupervisor({ authority: f.supervisionAuthority(), executorDatabaseUrl: f.urls.executor,
      environment: { NODE_ENV: 'test', DATABASE_SCHEMA: f.schema }, heartbeatTimeoutMs: 30000, handshakeTimeoutMs: 5000 });
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const timer = setTimeout(() => readyResolve(false), 10000);
    s.events.on('event', e => { if (e.type === 'ready') readyResolve(true); });
    try {
      assert.equal(await ready, true); clearTimeout(timer);
      if (reason === 'disconnect') s.child.disconnect();
      else if (reason === 'timeout') {
        const original = s.child.send.bind(s.child);
        s.child.send = (message, callback) => {
          if (message.message_type === 'COOPERATIVE_CLOSE_REQUEST') { callback?.(null); return true; }
          return original(message, callback);
        };
        s.shutdown('test-withheld-close-request'); // Actual parent closure deadline must expire.
      }
      else s.child.kill(reason === 'exit' ? 'SIGKILL' : reason);
      const result = await s.done;
      assert.equal(result.proof, false); assert.equal(result.stopped, false);
      await f.noStop();
    } finally { clearTimeout(timer); s.child.kill('SIGKILL'); await s.done; }
  });
});
test('B3: fixed supervised app refuses a migrator credential before READY', { timeout: 90000 }, async t => {
  const f = await permissionFixture(t), events = [];
  const s = startSupervisor({ authority: f.supervisionAuthority(), executorDatabaseUrl: f.urls.migrator, runtimeMode: 'application-test',
    environment: { NODE_ENV: 'test', DATABASE_SCHEMA: f.schema, PORT: '0', RENDER: 'true' },
    heartbeatMs: 200, heartbeatTimeoutMs: 30000, handshakeTimeoutMs: 60000, onEvent: e => events.push(e) });
  let output = '', timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Expected prepared-schema privilege rejection')), 60000);
      s.child.stderr.on('data', d => { output += d; if (output.includes('SQL031_INPUT_INVALID')) resolve(); });
    });
    assert.equal(events.some(e => e.type === 'ready'), false);
    assert.doesNotMatch(output, /Migration aplicada/);
  } finally { clearTimeout(timer); s.shutdown('privileged-runtime-rejected'); await s.done; }
  await f.noStop();
});
