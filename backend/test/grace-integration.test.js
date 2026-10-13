const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { GRACE_MS } = require('../services/billingTime');

test('Etapa 3: tolerancia, pagamento, webhook, dados e projecao administrativa', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env,{LEGACY_ADMIN_EMAIL:'grace-admin@example.test',LEGACY_ADMIN_PASSWORD:crypto.randomUUID(),MERCADO_PAGO_ACCESS_TOKEN:crypto.randomUUID(),MERCADO_PAGO_WEBHOOK_SECRET:crypto.randomUUID(),MERCADO_PAGO_MODE:'test'});
  const db=require('../database');await db.ready;
  const app=express();app.use(express.json());app.use('/api',require('../routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
  const nativeFetch=global.fetch;
  const api=async(path,method='GET',body,headers={})=>{const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const admin={'x-admin-token':(await api('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:process.env.LEGACY_ADMIN_PASSWORD})).body.token};
  const now=Date.now(), due=now-3600000, approved=new Date(now).toISOString();
  const owners=[];
  for(let n=0;n<2;n++){
    const input={barbeariaNome:'Grace fixture '+n,responsavelNome:'Fixture',email:`grace-${n}@example.test`,telefone:'1198444400'+n,senha:'synthetic-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Preserved service',preco:65}]};
    const created=await api('/publico/assinaturas','POST',input);assert.equal(created.status,201);
    const id=created.body.assinatura.id;
    const login=await api('/barbeiro/login','POST',{identificador:input.email,senha:input.senha});
    await db.runAsync("UPDATE assinaturas SET status='ativo',ultimo_pagamento='2026-09-01',vencimento_em=$1,proximo_vencimento=$2,bloqueio_admin=$3 WHERE id=$4",[new Date(due).toISOString(),new Date(due).toISOString().slice(0,10),n===1,id]);
    owners.push({id,headers:{'x-barbeiro-token':login.body.token}});
  }
  const a=owners[0], stored=owner=>db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[owner.id]);
  await t.test('API central libera tolerancia e nega suspensao mesmo com sessao aberta',async()=>{
    assert.equal((await api('/barbeiro/me','GET',undefined,a.headers)).body.acesso.status,'grace_period');
    assert.equal((await api('/studiofy/painel','GET',undefined,a.headers)).status,200);
    assert.equal((await api('/studiofy/painel','GET',undefined,owners[1].headers)).status,403);
  });
  const payments=new Map();
  t.mock.method(global,'fetch',async url=>{
    const match=/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(String(url));assert.ok(match,'Somente gateway simulado');assert.ok(payments.has(match[1]));return Response.json(payments.get(match[1]));
  });
  async function notify(owner,id,expectedBase=now){
    const ref=crypto.randomUUID();await db.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,6500,0,$3)',[ref,owner.id,'2099-01-01']);
    payments.set(id,{id,external_reference:ref,status:'approved',live_mode:false,currency_id:'BRL',transaction_amount:65,date_approved:approved});
    const ts=String(now),requestId=crypto.randomUUID(),v1=crypto.createHmac('sha256',process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const send=()=>api('/mercadopago/webhook?data.id='+id,'POST',{type:'payment',data:{id}},{'x-request-id':requestId,'x-signature':`ts=${ts},v1=${v1}`});
    assert.equal((await send()).status,200);const before=await stored(owner);
    assert.equal(new Date(before.vencimento_em).getTime(),expectedBase+30*86400000);
    assert.equal((await send()).status,200);assert.deepEqual(await stored(owner),before);
    const rows=await db.allAsync('SELECT * FROM mercado_pago_payments WHERE payment_id=$1',[id]);assert.equal(rows.length,1);assert.ok(rows[0].credited_at);assert.equal(rows[0].period_base,new Date(expectedBase).toISOString());assert.equal(rows[0].period_ends,new Date(expectedBase+30*86400000).toISOString());
  }
  await t.test('pagamento na tolerancia renova 720 horas desde aprovacao e webhook duplicado nao reaplica',()=>notify(a,'800001'));
  await t.test('pagamento na tolerancia preserva suspensao administrativa',async()=>{await notify(owners[1],'800002');assert.equal((await stored(owners[1])).bloqueio_admin,true);assert.equal((await api('/studiofy/painel','GET',undefined,owners[1].headers)).status,403);});
  await t.test('segunda renovacao antecipada conserva hora e milissegundos do periodo existente',()=>notify(a,'800003',now+30*86400000));
  await t.test('fim exato de 96h bloqueia sem apagar servicos profissionais agenda financeiro ou conta',async()=>{
    const professional=await db.getAsync('SELECT id FROM profissionais WHERE assinatura_id=$1',[a.id]);
    await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,servico_nome,preco,data,hora,status,profissional_id) VALUES($1,'Historical','Preserved service',65,'2026-09-01','10:00','concluido',$2)",[a.id,professional.id]);
    await db.runAsync('UPDATE assinaturas SET vencimento_em=$1 WHERE id=$2',[new Date(now-GRACE_MS).toISOString(),a.id]);
    const tables=['servicos_assinatura','profissionais','profissional_servicos','agendamentos','mercado_pago_orders','mercado_pago_payments'];
    const before={};for(const table of tables)before[table]=await db.allAsync(`SELECT * FROM ${table} WHERE assinatura_id=$1 ORDER BY 1`,[a.id]);
    const beforeAccount=await stored(a);t.mock.method(Date,'now',()=>now);
    const denied=await api('/studiofy/painel','GET',undefined,a.headers);assert.equal(denied.status,403);assert.equal(denied.body.acesso.motivo,'subscription_expired');
    for(const table of tables)assert.deepEqual(await db.allAsync(`SELECT * FROM ${table} WHERE assinatura_id=$1 ORDER BY 1`,[a.id]),before[table],table);
    const after=await stored(a);for(const key of ['id','email','senha_hash','public_slug','payment_id','ultimo_pagamento','vencimento_em','proximo_vencimento'])assert.deepEqual(after[key],beforeAccount[key],key);
    assert.equal(before.agendamentos[0].status,'concluido');assert.equal(before.agendamentos[0].preco,65);
  });
  await t.test('Controle Interno recebe estados efetivos nas duas secoes sem segredos',async()=>{
    let list=(await api('/admin/assinaturas?incluirPendentes=1','GET',undefined,admin)).body;
    const rows=[...list.assinaturas,...list.pendentes];
    assert.equal(rows.find(row=>row.id===a.id).acesso.motivo,'subscription_expired');
    assert.equal(rows.find(row=>row.id===owners[1].id).acesso.status,'admin_blocked');
    for(const row of rows)for(const key of ['senha_hash','senha_salt','gateway_payload','whatsapp_bridge_token'])assert.equal(row[key],undefined);
  });
  await t.test('PostgreSQL em outros fusos preserva mesmo instante de vencimento',async()=>{
    for(const timezone of ['UTC','America/Sao_Paulo','America/New_York'])await db.transaction(async c=>{await c.runAsync("SELECT set_config('TimeZone',$1,true)",[timezone]);const row=await c.getAsync('SELECT * FROM assinaturas WHERE id=$1',[a.id]);assert.equal(new Date(row.vencimento_em).getTime(),now-GRACE_MS);assert.equal(require('../services/access').avaliarAcessoAssinatura(row,now).liberado,false);});
  });
});
