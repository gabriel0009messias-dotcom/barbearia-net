const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
test('Etapa 4: legado preservado, regularizacao, pagamento e Admin em PostgreSQL',async t=>{
  const env=require('./helpers/postgres').testEnvironment();
  Object.assign(process.env,{LEGACY_ADMIN_EMAIL:'legacy-admin@example.test',LEGACY_ADMIN_PASSWORD:crypto.randomUUID(),MERCADO_PAGO_ACCESS_TOKEN:crypto.randomUUID(),MERCADO_PAGO_WEBHOOK_SECRET:crypto.randomUUID(),MERCADO_PAGO_MODE:'test'});
  const db=require('../database');await db.ready;
  const app=express();app.use(express.json());app.use('/api',require('../routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
  const nativeFetch=global.fetch,api=async(p,method='GET',body,headers={})=>{const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api${p}`,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const admin={'x-admin-token':(await api('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:process.env.LEGACY_ADMIN_PASSWORD})).body.token};
  const owners=[];
  for(let n=0;n<2;n++){
    const input={barbeariaNome:'Legacy fixture '+n,responsavelNome:'Fixture',email:`legacy-${n}@example.test`,telefone:'1198555500'+n,senha:'synthetic-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Preserved service',preco:65}]};
    const created=await api('/publico/assinaturas','POST',input);assert.equal(created.status,201);const id=created.body.assinatura.id;
    await require('../services/studiofy').createStudio(db).ensure(id);
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',gateway_status='approved',payment_id=$1,ultimo_pagamento='2026-09-01',proximo_vencimento=$2,data_vencimento='2099-01-01',observacoes='Historical contract' WHERE id=$3",['legacy-'+n,n?'invalid':null,id]);
    const login=await api('/barbeiro/login','POST',{identificador:input.email,senha:input.senha});assert.equal(login.status,200);owners.push({id,headers:{'x-barbeiro-token':login.body.token}});
  }
  const stored=o=>db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[o.id]),a=owners[0];
  await t.test('NULL e invalido retornam regularizacao, bloqueiam operacao e preservam conta/historico',async()=>{
    for(const o of owners){
      const professional=await db.getAsync('SELECT id FROM profissionais WHERE assinatura_id=$1',[o.id]);
      await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,servico_nome,preco,data,hora,status,profissional_id) VALUES($1,'Historical','Preserved service',65,'2026-09-01','10:00','concluido',$2)",[o.id,professional.id]);
      const tables=['assinaturas','servicos_assinatura','profissionais','profissional_servicos','agendamentos'];
      const snapshot={};for(const table of tables)snapshot[table]=await db.allAsync(`SELECT * FROM ${table} WHERE ${table==='assinaturas'?'id':'assinatura_id'}=$1 ORDER BY 1`,[o.id]);
      const me=await api('/barbeiro/me','GET',undefined,o.headers);assert.equal(me.status,200);assert.equal(me.body.acesso.status,'subscription_irregular');assert.equal(me.body.acesso.liberado,false);
      assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
      for(const table of tables)assert.deepEqual(await db.allAsync(`SELECT * FROM ${table} WHERE ${table==='assinaturas'?'id':'assinatura_id'}=$1 ORDER BY 1`,[o.id]),snapshot[table],table);
    }
  });
  await t.test('Controle Interno identifica irregular sem inventar vencimento ou divulgar segredo',async()=>{
    const list=await api('/admin/assinaturas?incluirPendentes=1','GET',undefined,admin);assert.equal(list.status,200);
    for(const o of owners){const row=[...list.body.assinaturas,...list.body.pendentes].find(r=>r.id===o.id);assert.ok(row);assert.equal(row.acesso.status,'subscription_irregular');assert.equal(row.acesso.vencimentoEm,null);assert.equal(row.senha_hash,undefined);assert.equal(row.gateway_payload,undefined);}
  });
  await t.test('regularizacao manual restrita ao Admin, temporaria e sem credito pago ficticio',async()=>{
    assert.equal((await api(`/admin/assinaturas/${a.id}/liberar-dias`,'POST',{dias:1},a.headers)).status,401);
    assert.equal((await api(`/admin/assinaturas/${a.id}/desbloquear`,'POST',{},a.headers)).status,401);
    const before=await stored(a);assert.equal((await api(`/admin/assinaturas/${a.id}/liberar-dias`,'POST',{dias:1},admin)).status,200);
    assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'manual_access');
    const after=await stored(a);for(const key of ['proximo_vencimento','vencimento_em','payment_id','ultimo_pagamento'])assert.deepEqual(after[key],before[key]);
    await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2000-01-01T00:00:00Z' WHERE id=$1",[a.id]);
    assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'subscription_irregular');
  });
  await t.test('retirar suspensao nao transforma legado irregular em assinatura paga',async()=>{
    assert.equal((await api(`/admin/assinaturas/${a.id}/bloquear`,'POST',{},admin)).status,200);
    assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'admin_blocked');
    assert.equal((await api(`/admin/assinaturas/${a.id}/desbloquear`,'POST',{},admin)).status,200);
    assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'subscription_irregular');
  });
  const remote=new Map();t.mock.method(global,'fetch',async url=>{const m=/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(String(url));assert.ok(m,'Gateway exclusivamente simulado');return Response.json(remote.get(m[1]));});
  async function notify(owner,id){
    const ref=crypto.randomUUID(),paid='2026-10-13T15:30:00.123-03:00';
    await db.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,6500,0,$3)',[ref,owner.id,'2099-01-01']);
    remote.set(id,{id,external_reference:ref,status:'approved',live_mode:false,currency_id:'BRL',transaction_amount:65,date_approved:paid});
    const ts=String(Date.now()),requestId=crypto.randomUUID(),v1=crypto.createHmac('sha256',process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const send=()=>api('/mercadopago/webhook?data.id='+id,'POST',{type:'payment',data:{id}},{'x-request-id':requestId,'x-signature':`ts=${ts},v1=${v1}`});
    assert.equal((await send()).status,200);const before=await stored(owner);
    assert.equal(new Date(before.vencimento_em).getTime(),Date.parse(paid)+30*86400000);
    assert.equal((await send()).status,200);assert.deepEqual(await stored(owner),before);
    const rows=await db.allAsync('SELECT * FROM mercado_pago_payments WHERE payment_id=$1',[id]);assert.equal(rows.length,1);assert.equal(rows[0].amount_cents,6500);assert.equal(rows[0].period_base,new Date(paid).toISOString());assert.ok(rows[0].credited_at);
  }
  await t.test('novo pagamento legitimo no legado NULL cria prazo preciso de 30 dias, duplicado idempotente',async()=>{await notify(a,'810001');assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'subscription_active');assert.equal((await api('/studiofy/painel','GET',undefined,a.headers)).status,200);});
  await t.test('novo pagamento no legado invalido preserva bloqueio administrativo e todos os dados',async()=>{
    const o=owners[1];await api(`/admin/assinaturas/${o.id}/bloquear`,'POST',{},admin);await notify(o,'810002');assert.equal((await stored(o)).bloqueio_admin,true);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
    assert.equal((await db.getAsync('SELECT COUNT(*)::int AS n FROM agendamentos WHERE assinatura_id=$1',[o.id])).n,1);
  });
});
