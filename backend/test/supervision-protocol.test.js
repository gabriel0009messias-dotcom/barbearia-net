const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { channel, PROFILE, validate, canonical } = require('../services/supervision/protocol');
const { executorEnvironment } = require('../services/supervision/environment');
const session = () => ({ supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), spawn_id: randomUUID(),
  executor_id: randomUUID(), boot_id: randomUUID(), challenge: randomBytes(32).toString('hex'), runtime_profile: PROFILE, revision: 'test-revision', instance_id: 'test-instance' });
test('strict authenticated IPC envelopes and sequence/replay rules', async t => {
  const key = randomBytes(32).toString('hex');
  await t.test('valid HELLO, ACK, heartbeat and exact duplicate are accepted',() => {
    const s = session(), sender = channel(s,key), receiver = channel(s,key);
    const hello = sender.message('HELLO',{ pid: 123, started_at: new Date().toISOString() });
    assert.equal(receiver.receive(hello),'new'); assert.equal(receiver.receive(hello),'duplicate');
    const next = sender.message('ACK',{ local_test_enrollment: true }); assert.equal(receiver.receive(next),'new');
    assert.throws(() => receiver.receive(hello));
  });
  for (const field of ['supervisor_id','supervisor_boot_id','spawn_id','executor_id','boot_id','challenge','runtime_profile','revision','instance_id']) {
    await t.test('reject mismatched '+field,() => {
      const s = session(), other = { ...s, [field]: field==='challenge'?randomBytes(32).toString('hex'):field.endsWith('_id')?randomUUID():'wrong' };
      assert.throws(() => channel(s,key).receive(channel(other,key).message('ACK',{ local_test_enrollment: true })));
    });
  }
  await t.test('wrong auth, stale ACK, malformed, extra fields, SQL, handles and oversize rejected',() => {
    const s=session(), tx=channel(s,key), rx=channel(s,key);
    const ack=tx.message('ACK',{local_test_enrollment:true});
    for(const change of [{auth:'0'.repeat(64)},{sequence:0},{protocol_version:2},{message_type:'SQL'},{business:'forbidden'},{sql:'SELECT 1'}, {revision:'x'.repeat(5000)}]) assert.throws(()=>rx.receive({...ack,...change}));
    for(const value of [null,[],{},'bad',42]) assert.throws(()=>validate(value));
    assert.throws(()=>canonical({value:[]}));
  });
  await t.test('conflicting duplicate and out of order sequence cannot advance',() => {
    const s=session(), a=channel(s,key), b=channel(s,key), rx=channel(s,key);
    rx.receive(a.message('ACK',{local_test_enrollment:true}));
    assert.throws(()=>rx.receive(b.message('READY',{port:1})));
    a.message('HEARTBEAT');assert.throws(()=>rx.receive(a.message('HEARTBEAT')));
  });
});
test('executor env is an explicit allowlist, with canonical aliases and separate database authority',() => {
  const input={NODE_ENV:'test',PORT:'0',PATH:'untrusted',HOME:'untrusted',DATABASE_URL:'postgresql://issuer@invalid/db',
    PROOF_DATABASE_URL:'synthetic-only',MIGRATION_DATABASE_URL:'synthetic-only',RENDER_API_KEY:'synthetic-only',NODE_OPTIONS:'--inspect',
    npm_config_registry:'synthetic-only',LD_PRELOAD:'synthetic-only',LD_LIBRARY_PATH:'synthetic-only',CHROME_PATH:'synthetic-only',
    PUPPETEER_EXECUTABLE_PATH:'synthetic-only',UNKNOWN:'synthetic-only',WHATSAPP_EVOLUTION_API_URL:'http://127.0.0.1',
    WHATSAPP_EVOLUTION_API_KEY:'synthetic-api',ADMIN_EMAIL:'synthetic@example.test',SMTP_HOST:'127.0.0.1'};
  const env=executorEnvironment(input,{home:'/controlled',executable:'/controlled/node',executorDatabaseUrl:'postgresql://executor@127.0.0.1/test'});
  assert.notEqual(env,input);assert.equal(env.HOME,'/controlled');assert.equal(env.PORT,'0');assert.equal(env.DATABASE_URL,'postgresql://executor@127.0.0.1/test');
  assert.equal(env.EVOLUTION_API_URL,input.WHATSAPP_EVOLUTION_API_URL);assert.equal(env.LEGACY_ADMIN_EMAIL,input.ADMIN_EMAIL);
  assert.equal(env.SMTP_HOST,'127.0.0.1');
  for(const key of ['PROOF_DATABASE_URL','MIGRATION_DATABASE_URL','RENDER_API_KEY','NODE_OPTIONS','npm_config_registry','LD_PRELOAD','LD_LIBRARY_PATH','CHROME_PATH','PUPPETEER_EXECUTABLE_PATH','UNKNOWN','WHATSAPP_EVOLUTION_API_KEY'])assert.equal(env[key],undefined,key);
  assert.equal(executorEnvironment(input).DATABASE_URL,undefined);
});
