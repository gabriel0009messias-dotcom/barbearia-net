const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');
const fingerprint = token => 'sha256:' + createHash('sha256').update('studiofy.operation-token.v1:' + token).digest('hex');
const rejected = (promise, codes=['23514','23505','P0002','22P02']) => assert.rejects(promise,e=>codes.includes(e.code));

test('3B.1 SQL foundation: explicit synthetic enrollment only; no runtime proof issuer', {timeout:120000}, async t => {
  const env=require('./helpers/postgres').testEnvironment(), pool=new Pool({...require('../database/config').connectionConfig(),max:8});
  t.after(async()=>{await pool.end();await env.cleanup();});
  await migrate(pool,env.schema);
  const q=(sql,args=[])=>pool.query(sql,args);
  const call=(name,p,client=pool)=>client.query('SELECT '+name+'($1::jsonb) AS id',[JSON.stringify(p)]).then(r=>r.rows[0].id);
  let tenantId=96000;
  const supervisor=async()=>{
    const p={supervisor_id:randomUUID(),supervisor_boot_id:randomUUID(),protocol_version:1,process_id:700,origin:'local-parent-v1',revision:'synthetic'};
    await call('studiofy_register_supervisor',p);return p;
  };
  const birth=async(s,override={})=>{
    const p={executor_id:randomUUID(),boot_id:randomUUID(),supervisor_id:s.supervisor_id,supervisor_boot_id:s.supervisor_boot_id,
      spawn_id:randomUUID(),observed_pid:701,nonce_fingerprint:'sha256:'+'a'.repeat(64),protocol_version:1,
      runtime_profile:'evolution-single-process-v1',observed_at:new Date().toISOString(),started_at:new Date().toISOString(),...override};
    await call('studiofy_register_executor_birth',p);return p;
  };
  const advance=(b,state,client=pool)=>client.query('SELECT studiofy_advance_executor_gate($1,$2,$3,$4)',[b.executor_id,b.boot_id,b.supervisor_id,state]);
  const subject=async({b,open=true,message=true}={})=>{
    const s=b?null:await supervisor(); b=b||await birth(s); if(open)await advance(b,'OPEN');
    const tenant=++tenantId,instance='proof-'+tenant,token=randomUUID(),claim=randomUUID(),execution=randomUUID();
    await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2)",[tenant,instance]);
    await q("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2",[token,String(tenant)]);
    let delivery=null;
    if(message)delivery=(await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,claimed_at) VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,$5,clock_timestamp()) RETURNING id",[tenant,instance,randomUUID(),claim,token])).rows[0].id;
    const x={b,tenant,instance,token,claim:message?claim:null,execution,delivery,kind:message?'whatsapp_messages':'instance_operation'};
    x.register=()=>q('INSERT INTO evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[execution,b.executor_id,token,tenant,instance,x.kind,delivery,x.claim]);
    if(open)await x.register();return x;
  };
  const closure=(x,type='COOPERATIVE_SCOPE_CLOSED')=>({closure_event_id:randomUUID(),proof_type:type,protocol_version:1,
    executor_id:x.b.executor_id,boot_id:x.b.boot_id,supervisor_id:x.b.supervisor_id,supervisor_boot_id:x.b.supervisor_boot_id,
    origin:'supervisor-ipc-v1',evidence_canonicalization_version:'pg-jsonb-v1',observed_at:new Date().toISOString(),idempotency_key:randomUUID(),
    evidence:type==='COOPERATIVE_SCOPE_CLOSED'?{seal_id:randomUUID(),admission_closed:true,scope_closed:true,active_tasks:0,active_descendants:0,
      active_transports:0,pending_callbacks:0,pending_correlations:0,pending_sql:0,unresolved_sql:0,runtime_profile:'evolution-single-process-v1'}:
      {exit_observed:true,exit_code:0,exit_signal:null,descendants_closed:true,sql_fenced:true,spawn_id:x.b.spawn_id}});
  const proof=async(x,c)=>({proof_id:randomUUID(),proof_type:c.proof_type,protocol_version:1,closure_event_id:c.closure_event_id,
    executor_id:x.b.executor_id,boot_id:x.b.boot_id,execution_id:x.execution,source_schema:env.schema,assinatura_id:x.tenant,
    instance_name:x.instance,operation_kind:x.kind,delivery_id:x.delivery,claim_token:x.claim,operation_token_fingerprint:fingerprint(x.token),
    supervisor_id:x.b.supervisor_id,supervisor_boot_id:x.b.supervisor_boot_id,evidence_canonicalization_version:'pg-jsonb-v1',
    evidence_hash:(await q('SELECT evidence_hash FROM evolution_executor_closure_events WHERE closure_event_id=$1',[c.closure_event_id])).rows[0].evidence_hash,
    idempotency_key:randomUUID()});
  const seal=async x=>{await advance(x.b,'DRAINING');const c=closure(x);await call('studiofy_accept_executor_closure',c);return c;};
  const state=async x=>(await q('SELECT * FROM evolution_execution_lifecycle_status WHERE execution_id=$1',[x.execution])).rows[0];
  const snapshot=async x=>({delivery:(await q('SELECT * FROM whatsapp_messages WHERE id=$1',[x.delivery])).rows,
    owner:(await q('SELECT * FROM evolution_instance_owners WHERE owner_id=$1',[String(x.tenant)])).rows,
    execution:(await q('SELECT * FROM evolution_operation_executions WHERE execution_id=$1',[x.execution])).rows});
  const begin=async()=>{const c=await pool.connect();await c.query('BEGIN');return c;};
  const end=async c=>{await c.query('ROLLBACK');c.release();};
  // Observe actual backend lock waits rather than relying on timing races.
  const blocked=async c=>{
    const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return pid;
  };
  const waitForLock=async pid=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if((await q("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;
      await new Promise(r=>setTimeout(r,10));}
    assert.fail('Expected real PostgreSQL lock wait');
  };
  await t.test('fresh migration has no supervisors, gates, events, proofs or STOPPED',async()=>{
    for(const name of ['supervisors','executor_birth_bindings','executor_gates','executor_closure_events','execution_stop_proofs','execution_stops'])
      assert.equal((await q('SELECT count(*)::int n FROM evolution_'+name)).rows[0].n,0);
  });
  await t.test('supervisor identity immutable and protocol constrained',async()=>{
    const s=await supervisor();assert.equal(await call('studiofy_register_supervisor',s),s.supervisor_id);
    await rejected(call('studiofy_register_supervisor',{...s,process_id:999}));
    await rejected(call('studiofy_register_supervisor',{...s,supervisor_id:randomUUID(),protocol_version:2}));
    await rejected(call('studiofy_register_supervisor',{...s,Authorization:'secret'}));
    await rejected(q('UPDATE evolution_supervisors SET process_id=8 WHERE supervisor_id=$1',[s.supervisor_id]));
  });
  await t.test('birth binding rejects wrong supervisor, profile, PID, nonce and legacy executor; enrollment is idempotent',async()=>{
    const s=await supervisor(),b=await birth(s);assert.equal(await call('studiofy_register_executor_birth',b),b.executor_id);
    for(const delta of [{supervisor_id:randomUUID()},{supervisor_boot_id:randomUUID()},{runtime_profile:'uncontained'},
      {observed_pid:0},{nonce_fingerprint:'pid:701'},{boot_id:randomUUID()}])await rejected(call('studiofy_register_executor_birth',{...b,...delta}));
    const legacy=randomUUID();await q('INSERT INTO evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,701,clock_timestamp())',[legacy,randomUUID()]);
    await rejected(birth(s,{executor_id:legacy}));
    assert.equal((await q('SELECT count(*)::int n FROM evolution_executor_gates WHERE executor_id=$1',[legacy])).rows[0].n,0);
  });
  await t.test('BOOTSTRAPPING denies new execution; OPEN permits; DRAINING denies admission/renewal/boundary but allows finalization',async()=>{
    const x=await subject({open:false});await rejected(x.register());await advance(x.b,'OPEN');await x.register();await advance(x.b,'DRAINING');
    for(const p of ['admission','renew','boundary'])await rejected(q('SELECT studiofy_execution_lock_gate($1,$2)',[x.b.executor_id,p]));
    await q("SELECT studiofy_execution_lock_gate($1,'finalize')",[x.b.executor_id]);
    await rejected(advance(x.b,'OPEN'));
    await rejected(q("UPDATE evolution_executor_gates SET state='CLOSED' WHERE executor_id=$1",[x.b.executor_id]));
  });
  await t.test('zero snapshot, timeout, abort, active descendant, transport, callback, correlation and unresolved SQL cannot be certificates',async()=>{
    const x=await subject();await advance(x.b,'DRAINING');const c=closure(x);
    await rejected(call('studiofy_accept_executor_closure',{...c,evidence:{activeCount:0}}));
    for(const key of ['active_tasks','active_descendants','active_transports','pending_callbacks','pending_correlations','pending_sql','unresolved_sql'])
      await rejected(call('studiofy_accept_executor_closure',{...c,evidence:{...c.evidence,[key]:1}}));
    await rejected(call('studiofy_accept_executor_closure',{...c,evidence:{...c.evidence,timeout:true}}));
    await rejected(call('studiofy_accept_executor_closure',{...c,evidence:{...c.evidence,admission_closed:false}}));
    assert.equal(await call('studiofy_accept_executor_closure',c),c.closure_event_id);
  });
  let stopped,acceptedProof,acceptedClosure;
  await t.test('proof mismatch rejected for every identity dimension, original-derived fingerprint and evidence hash',async()=>{
    const x=await subject(),c=await seal(x),p=await proof(x,c);stopped=x;acceptedProof=p;acceptedClosure=c;
    for(const delta of [{execution_id:randomUUID()},{executor_id:randomUUID()},{boot_id:randomUUID()},{assinatura_id:x.tenant+1},
      {instance_name:'wrong'},{operation_kind:'instance_operation'},{delivery_id:x.delivery+1},{claim_token:randomUUID()},
      {operation_token_fingerprint:'sha256:'+'b'.repeat(64)},{supervisor_id:randomUUID()},{supervisor_boot_id:randomUUID()},
      {source_schema:'public'},{evidence_hash:'sha256:'+'c'.repeat(64)},{proof_type:'CONTAINER_EXIT'},{protocol_version:2}])
      await rejected(call('studiofy_accept_execution_stop',{...p,...delta}));
    assert.equal((await state(x)).lifecycle_state,'UNKNOWN'); // CLOSED, awaiting its own durable proof.
    const before=await snapshot(x);assert.equal(await call('studiofy_accept_execution_stop',p),p.proof_id);
    assert.deepEqual(await snapshot(x),before);assert.equal((await state(x)).lifecycle_state,'STOPPED');
    assert.equal((await q('SELECT state FROM evolution_execution_authorizations WHERE execution_id=$1',[x.execution])).rows[0].state,'UNKNOWN');
  });
  await t.test('same issuer/key/content returns same proof; semantic conflict and duplicate incompatible projection rejected',async()=>{
    const p=acceptedProof;assert.equal(await call('studiofy_accept_execution_stop',p),p.proof_id);
    await rejected(call('studiofy_accept_execution_stop',{...p,proof_id:randomUUID()}));
    await rejected(call('studiofy_accept_execution_stop',{...p,idempotency_key:randomUUID(),proof_id:randomUUID()}));
    assert.equal((await q('SELECT count(*)::int n FROM evolution_execution_stops WHERE execution_id=$1',[p.execution_id])).rows[0].n,1);
    assert.equal(await call('studiofy_accept_executor_closure',acceptedClosure),acceptedClosure.closure_event_id);
    await rejected(call('studiofy_accept_executor_closure',{...acceptedClosure,observed_at:'2020-01-01T00:00:00.000Z'}));
  });
  await t.test('all evidence and projection are append-only, including TRUNCATE; STOPPED gate never reopens',async()=>{
    for(const table of ['evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops']){
      await rejected(q('UPDATE '+table+' SET recorded_at=clock_timestamp()'));await rejected(q('DELETE FROM '+table));
      await rejected(q('TRUNCATE '+table+' CASCADE'),['23514','0A000']);
    }
    for(const status of ['BOOTSTRAPPING','OPEN','DRAINING','CLOSED'])await rejected(q('UPDATE evolution_executor_gates SET state=$1 WHERE executor_id=$2',[status,stopped.b.executor_id]));
    await rejected(q('DELETE FROM evolution_executor_gates WHERE executor_id=$1',[stopped.b.executor_id]));
  });
  await t.test('late callback, heartbeat, renewal, boundary, reserve/token release and retry cannot resurrect STOPPED',async()=>{
    const x=stopped,before=await snapshot(x);
    await rejected(q("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[x.execution]));
    await rejected(q('INSERT INTO evolution_execution_authorizations(execution_id) VALUES($1)',[x.execution]));
    for(const assignment of ["dispatch_started_at=clock_timestamp(),attempts=attempts+1","status='pending'","status='sent'",'operation_token=NULL'])
      await rejected(q('UPDATE whatsapp_messages SET '+assignment+' WHERE id=$1',[x.delivery]));
    await rejected(q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL WHERE owner_id=$1',[String(x.tenant)]));
    await rejected(q('SELECT studiofy_execution_lock_finalization($1)',[x.token]));
    assert.deepEqual(await snapshot(x),before);
  });
  await t.test('exit evidence requires real-exit assertion, exact spawn and descendants; second valid modality preserves first projection',async()=>{
    const x=stopped,c=closure(x,'SUPERVISOR_PROCESS_EXIT');
    for(const delta of [{exit_observed:false},{descendants_closed:false},{sql_fenced:false},{spawn_id:randomUUID()},
      {exit_code:null,exit_signal:null},{exit_code:0,exit_signal:'SIGTERM'},{exit_code:-1}])await rejected(call('studiofy_accept_executor_closure',{...c,evidence:{...c.evidence,...delta}}));
    const before=await state(x);await call('studiofy_accept_executor_closure',c);await call('studiofy_accept_execution_stop',await proof(x,c));
    assert.deepEqual(await state(x),before);
  });
  await t.test('raw authorization UPDATE cannot take gate after authorization row lock',async()=>{
    const x=await subject();await rejected(q("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[x.execution]));
    const c=await begin();try{await c.query("SELECT studiofy_execution_lock_gate($1,'renew')",[x.b.executor_id]);
      await c.query("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[x.execution]);await c.query('COMMIT');}finally{await end(c);}
  });
  for(const mode of ['boundary','heartbeat','renewal']){
    await t.test(mode+' wins gate before closure: closure waits for real transaction then closes',async()=>{
      const x=await subject(),c=closure(x,'SUPERVISOR_PROCESS_EXIT'),first=await begin(),second=await begin();
      try{
        const pid=await blocked(second);
        if(mode==='boundary')await first.query('UPDATE whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1',[x.delivery]);
        else{await first.query("SELECT studiofy_execution_lock_gate($1,'renew')",[x.b.executor_id]);
          await first.query("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[x.execution]);}
        const pending=call('studiofy_accept_executor_closure',c,second);pending.catch(()=>{});await waitForLock(pid);
        await first.query('COMMIT');assert.equal(await pending,c.closure_event_id);await second.query('COMMIT');
        await call('studiofy_accept_execution_stop',await proof(x,c));assert.equal((await state(x)).lifecycle_state,'STOPPED');
      }finally{await end(first);await end(second);}
    });
    await t.test('closure wins gate before '+mode+': loser waits then rejects atomically',async()=>{
      const x=await subject(),c=closure(x,'SUPERVISOR_PROCESS_EXIT'),first=await begin(),second=await begin();
      try{
        const pid=await blocked(second);await call('studiofy_accept_executor_closure',c,first);
        const pending=mode==='boundary'?second.query('UPDATE whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1',[x.delivery]):
          second.query("SELECT studiofy_execution_lock_gate($1,'renew')",[x.b.executor_id]);
        pending.catch(()=>{});await waitForLock(pid);await first.query('COMMIT');await rejected(pending);await second.query('ROLLBACK');
        assert.equal((await q('SELECT attempts FROM whatsapp_messages WHERE id=$1',[x.delivery])).rows[0].attempts,0);
      }finally{await end(first);await end(second);}
    });
  }
  await t.test('concurrent duplicate proof and conflicting proof use real connections and one terminal projection',async()=>{
    const x=await subject(),c=await seal(x),p=await proof(x,c),a=await begin(),b=await begin();
    try{const pid=await blocked(b);await call('studiofy_accept_execution_stop',p,a);const pending=call('studiofy_accept_execution_stop',p,b);
      pending.catch(()=>{});await waitForLock(pid);await a.query('COMMIT');assert.equal(await pending,p.proof_id);await b.query('COMMIT');
      await rejected(call('studiofy_accept_execution_stop',{...p,proof_id:randomUUID()}));
    }finally{await end(a);await end(b);}
  });
  await t.test('rollback and bounded lock timeout leave no proof/projection; retry after unobserved COMMIT is idempotent',async()=>{
    const x=await subject(),c=await seal(x),p=await proof(x,c),a=await begin(),b=await begin();
    try{
      await call('studiofy_accept_execution_stop',p,a);assert.notEqual((await state(x)).lifecycle_state,'STOPPED');await a.query('ROLLBACK');
      await a.query('BEGIN');
      await a.query('SELECT pg_advisory_xact_lock(studiofy_executor_gate_key($1))',[x.b.executor_id]);
      await b.query("SET LOCAL lock_timeout='80ms'");await rejected(call('studiofy_accept_execution_stop',p,b),['55P03']);await b.query('ROLLBACK');
      await a.query('ROLLBACK');assert.notEqual((await state(x)).lifecycle_state,'STOPPED');
      await a.query('BEGIN');await call('studiofy_accept_execution_stop',p,a);
      const commitWithLostAcknowledgement=async()=>{await a.query('COMMIT');throw Object.assign(Error('Synthetic lost COMMIT acknowledgement'),{code:'08006'});};
      await assert.rejects(commitWithLostAcknowledgement(),e=>e.code==='08006');
      assert.equal(await call('studiofy_accept_execution_stop',p),p.proof_id);
    }finally{await end(a);await end(b);}
  });
  await t.test('restart/PID reuse/multiworker/overlapping revisions do not share authority or stop another boot',async()=>{
    const s=await supervisor(),a=await subject({b:await birth(s)}),b=await subject({b:await birth(s)});
    const c=await seal(a);await call('studiofy_accept_execution_stop',await proof(a,c));
    assert.notEqual(a.b.boot_id,b.b.boot_id);assert.equal(a.b.observed_pid,b.b.observed_pid);
    assert.notEqual((await state(b)).lifecycle_state,'STOPPED');await q("SELECT studiofy_execution_lock_gate($1,'boundary')",[b.b.executor_id]);
    await rejected(call('studiofy_accept_execution_stop',{...await proof(b,c),executor_id:a.b.executor_id,boot_id:a.b.boot_id}));
  });
  await t.test('privileged SQL APIs have fixed search_path and no PUBLIC EXECUTE or table DML',async()=>{
    const rows=(await q("SELECT p.proname,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname IN ('studiofy_register_supervisor','studiofy_register_executor_birth','studiofy_accept_executor_closure','studiofy_accept_execution_stop')",[env.schema])).rows;
    assert.equal(rows.length,4);for(const row of rows){assert.ok(row.proconfig.includes('search_path=pg_catalog'));assert.equal(row.public_execute,false);}
    assert.equal((await q("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname=$1 AND c.relname IN ('evolution_executor_gates','evolution_execution_stop_proofs','evolution_execution_stops') AND a.grantee=0",[env.schema])).rows[0].n,0);
  });
  await t.test('ordinary SQL role cannot enroll, accept evidence or write new ledger tables',async()=>{
    const c=await begin(),role='test_stop_'+randomUUID().replaceAll('-','');
    try{
      await c.query('CREATE ROLE "'+role+'" NOLOGIN');await c.query('GRANT USAGE ON SCHEMA "'+env.schema+'" TO "'+role+'"');
      await c.query('SET LOCAL ROLE "'+role+'"');
      for(const api of ['studiofy_register_supervisor','studiofy_register_executor_birth','studiofy_accept_executor_closure','studiofy_accept_execution_stop']){
        await c.query('SAVEPOINT denied');await rejected(c.query('SELECT '+api+"('{}'::jsonb)"),['42501']);await c.query('ROLLBACK TO SAVEPOINT denied');
      }
      for(const table of ['evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_gates','evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops']){
        await c.query('SAVEPOINT denied');await rejected(c.query('DELETE FROM '+table),['42501']);await c.query('ROLLBACK TO SAVEPOINT denied');
      }
    }finally{await end(c);}
  });
  await t.test('finalization races follow business -> gate -> authorization; proof never waits for owner/delivery',async()=>{
    const x=await subject(),c=closure(x,'SUPERVISOR_PROCESS_EXIT'),a=await begin(),b=await begin();
    try{
      const pid=await blocked(b);await a.query('SELECT id FROM assinaturas WHERE id=$1 FOR UPDATE',[x.tenant]);
      await a.query('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1 FOR UPDATE',[String(x.tenant)]);
      await a.query('SELECT studiofy_execution_lock_finalization($1)',[x.token]);
      const pending=call('studiofy_accept_executor_closure',c,b);pending.catch(()=>{});await waitForLock(pid);
      await a.query("UPDATE whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=1,status='uncertain' WHERE id=$1",[x.delivery]);
      await a.query('COMMIT');await pending;await b.query('COMMIT');await call('studiofy_accept_execution_stop',await proof(x,c));
      const before=await snapshot(x);await rejected(q('SELECT studiofy_execution_lock_finalization($1)',[x.token]));assert.deepEqual(await snapshot(x),before);
    }finally{await end(a);await end(b);}
  });
  await t.test('concurrent semantic conflict waits then rejects, with one proof and unchanged terminal projection',async()=>{
    const x=await subject(),c=await seal(x),p=await proof(x,c),a=await begin(),b=await begin();
    try{
      const pid=await blocked(b);await call('studiofy_accept_execution_stop',p,a);
      const pending=call('studiofy_accept_execution_stop',{...p,proof_id:randomUUID()},b);pending.catch(()=>{});await waitForLock(pid);
      await a.query('COMMIT');await rejected(pending);await b.query('ROLLBACK');assert.equal((await state(x)).proof_id,p.proof_id);
    }finally{await end(a);await end(b);}
  });
  await t.test('SQL INSERT constraints reject crossed proof identity even for owner; no unbound retroactive birth',async()=>{
    const p=(await q('SELECT * FROM evolution_execution_stop_proofs WHERE proof_id=$1',[acceptedProof.proof_id])).rows[0];
    const c=await begin();
    try{
      await c.query('SELECT pg_advisory_xact_lock(studiofy_executor_gate_key($1))',[stopped.b.executor_id]);
      const columns=Object.keys(p),values=columns.map(k=>k==='proof_id'?randomUUID():k==='assinatura_id'?stopped.tenant+1:k==='idempotency_key'?randomUUID():p[k]);
      await rejected(c.query('INSERT INTO evolution_execution_stop_proofs('+columns.join(',')+') VALUES('+values.map((_,i)=>'$'+(i+1)).join(',')+')',values));
    }finally{await end(c);}
  });
  await t.test('late provider correlation cannot mutate a STOPPED execution',async()=>{
    const x=await subject(),conversation=randomUUID(),epoch=(await q('SELECT conversation_epoch FROM evolution_instance_owners WHERE owner_id=$1',[String(x.tenant)])).rows[0].conversation_epoch;
    await q("INSERT INTO whatsapp_conversations(id,assinatura_id,instance_key,owner_epoch,sender,reference) VALUES($1,$2,$3,$4,'5511999990000','0123456789abcdef')",[conversation,x.tenant,x.instance,epoch]);
    await q("INSERT INTO whatsapp_conversation_responses(delivery_id,assinatura_id,conversation_id,owner_epoch,reference) VALUES($1,$2,$3,$4,'0123456789abcdef')",[x.delivery,x.tenant,conversation,epoch]);
    const c=await seal(x);await call('studiofy_accept_execution_stop',await proof(x,c));
    await rejected(q("UPDATE whatsapp_conversation_responses SET provider_message_id='late-synthetic' WHERE delivery_id=$1",[x.delivery]));
    assert.equal((await q('SELECT provider_message_id FROM whatsapp_conversation_responses WHERE delivery_id=$1',[x.delivery])).rows[0].provider_message_id,null);
  });
  await t.test('explicit synthetic enrollment integrates existing JS authorization/finalization without a supervisor or issuer',async()=>{
    const {processIdentity}=require('../services/executionLifecycle'),identity=processIdentity(),s=await supervisor();
    const b=await birth(s,{executor_id:identity.executorId,boot_id:identity.bootId,observed_pid:identity.processId,started_at:identity.startedAt,
      service_id:identity.serviceId,instance_id:identity.instanceId,revision:identity.revision});await advance(b,'OPEN');
    const db=require('../database');await db.ready;
    try{
      const tenant=++tenantId,instance='proof-'+tenant;
      await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2,'ativo','2099-01-01')",[tenant,instance]);
      const row=(await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,clock_timestamp()) RETURNING *",[tenant,instance,randomUUID(),randomUUID()])).rows[0];
      let calls=0;await require('../services/evolutionDelivery').createEvolutionDelivery(db).dispatch('whatsapp_messages',row,async()=>{calls++;return {key:{id:randomUUID()},status:'PENDING'};});
      assert.equal(calls,1);assert.equal((await q('SELECT status FROM whatsapp_messages WHERE id=$1',[row.id])).rows[0].status,'sent');
      assert.equal((await q('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1',[String(tenant)])).rows[0].operation_token,null);
      const e=(await q('SELECT * FROM evolution_operation_executions WHERE delivery_id=$1',[row.id])).rows[0];
      const x={b,tenant,instance,execution:e.execution_id,delivery:row.id,kind:e.operation_kind,claim:e.claim_token,token:e.operation_token};
      const before=await snapshot(x),c=await seal(x);await call('studiofy_accept_execution_stop',await proof(x,c));
      assert.deepEqual(await snapshot(x),before);assert.equal((await state(x)).lifecycle_state,'STOPPED');
    }finally{await db.close();}
  });
});
