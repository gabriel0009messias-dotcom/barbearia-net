const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs'),{execFileSync}=require('node:child_process');const express=require('express');const root=path.resolve(__dirname,'..');let db,env,server,api,admin,seq=0,paymentSeq=760000,remote=new Map(),nativeFetch,mp;
before(async()=>{env=require(path.join(root,'test/helpers/postgres')).testEnvironment();Object.assign(process.env,{LEGACY_ADMIN_EMAIL:'independent-admin@example.test',LEGACY_ADMIN_PASSWORD:crypto.randomUUID(),MERCADO_PAGO_ACCESS_TOKEN:crypto.randomUUID(),MERCADO_PAGO_WEBHOOK_SECRET:crypto.randomUUID(),MERCADO_PAGO_MODE:'test',PUBLIC_APP_URL:'https://example.test'});db=require(path.join(root,'database'));await db.ready;nativeFetch=global.fetch;global.fetch=async(url)=>{if(String(url).endsWith('/users/me'))return Response.json({email:'seller@example.test'});if(String(url).endsWith('/checkout/preferences'))return Response.json({id:crypto.randomUUID(),sandbox_init_point:'https://sandbox.mercadopago.com.br/fixture'});const match=/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(String(url));assert.ok(match,'Only local simulated payment reads');return Response.json(remote.get(match[1]));};const app=express();app.use(express.json());app.use('/api',require(path.join(root,'routes')));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));api=async(p,method='GET',body,headers={})=>{const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api${p}`,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),retry:r.headers.get('retry-after')};};admin={'x-admin-token':(await api('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:process.env.LEGACY_ADMIN_PASSWORD})).body.token};mp=require(path.join(root,'services/payments/mercadoPago'));});
after(async()=>{global.fetch=nativeFetch;server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
async function account(extra={}){const n=++seq,body={barbeariaNome:'Independent fixture '+n,responsavelNome:'Fixture',telefone:'1198777'+String(n).padStart(4,'0'),email:`independent-${n}@example.test`,senha:'synthetic-audit-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Fixture',preco:65}],...extra};const created=await api('/publico/assinaturas','POST',body);assert.equal(created.status,201);const id=created.body.assinatura.id,login=await api('/barbeiro/login','POST',{identificador:body.email,senha:body.senha});assert.equal(login.status,200);return {id,body,headers:{'x-barbeiro-token':login.body.token}};}
const stored=o=>db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[o.id]);
async function payment(o,fields={},reference){const id=String(++paymentSeq),ref=reference||crypto.randomUUID();if(!reference)await db.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,6500,0,$3)',[ref,o.id,'2099-01-01']);remote.set(id,{id,external_reference:ref,live_mode:false,status:'approved',transaction_amount:65,currency_id:'BRL',date_approved:new Date().toISOString(),collector_id:1,...fields});return id;}
const signed=(id,ts='1',body={type:'payment',data:{id}})=>{const reqId=crypto.randomUUID(),v1=crypto.createHmac('sha256',process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${reqId};ts:${ts};`).digest('hex');return api(`/mercadopago/webhook?data.id=${id}`,'POST',body,{'x-request-id':reqId,'x-signature':`ts=${ts},v1=${v1}`});};
test('EXPECT: pagamento novo nao supera bloqueio Admin feminino legado apos 013',async()=>{const o=await account();await db.runAsync("UPDATE assinaturas SET status='bloqueada',ultimo_pagamento='2026-09-01',proximo_vencimento='2099-01-01',bloqueado=1 WHERE id=$1",[o.id]);const id=await payment(o);assert.equal((await signed(id)).status,200);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403,'Legacy administrative suspension was lost and payment reopened operations');});

for(const status of ['bloqueado','bloqueada',' BLOQUEADO ',' BLOQUEADA ']) test('legado '+status+': trial/manual/tolerancia e checkout nunca removem suspensao',async()=>{
 const o=await account();await db.runAsync('UPDATE assinaturas SET status=$1,bloqueio_admin=FALSE,acesso_manual_ate=$2 WHERE id=$3',[status,'2099-01-01T00:00:00Z',o.id]);
 const access=require('../services/access').avaliarAcessoAssinatura;
 const raw=await stored(o);assert.equal(access(raw).status,'admin_blocked');
 assert.equal(access({...raw,ultimo_pagamento:'2026-09-01',proximo_vencimento:new Date(Date.now()-86400000).toISOString().slice(0,10)}).status,'admin_blocked');
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 assert.equal((await api('/publico/assinaturas/'+o.id+'/checkout','POST',{},{})).status,401);assert.equal((await api('/publico/assinaturas/'+o.id+'/checkout','POST',{},o.headers)).status,200);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 assert.equal((await api('/admin/assinaturas/'+o.id+'/liberar-dias','POST',{dias:10},admin)).status,200);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 assert.equal((await api('/admin/assinaturas/'+o.id+'/desbloquear','POST',{},o.headers)).status,401);
 assert.equal((await api('/admin/assinaturas/'+o.id+'/desbloquear','POST',{},admin)).status,200);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
});
test('pagamento e renovacao registram dois periodos sem retirar legado feminino; desbloqueio explicito restaura pago',async()=>{
 const o=await account();await db.runAsync("UPDATE assinaturas SET status=' BLOQUEADA ',ultimo_pagamento='2026-09-01',proximo_vencimento='2099-01-01',bloqueado=1 WHERE id=$1",[o.id]);
 const first=await payment(o);assert.equal((await signed(first)).status,200);const before=await stored(o);assert.equal(before.bloqueio_admin,true);assert.equal(before.payment_id,first);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 const second=await payment(o);assert.equal((await signed(second)).status,200);const renewed=await stored(o);
 assert.equal(renewed.bloqueio_admin,true);assert.equal(Date.parse(renewed.vencimento_em)-Date.parse(before.vencimento_em),30*86400000);
 assert.equal((await signed(second)).status,200);assert.equal(Date.parse((await stored(o)).vencimento_em),Date.parse(renewed.vencimento_em));
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 assert.equal((await api('/admin/assinaturas/'+o.id+'/desbloquear','POST',{},admin)).status,200);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
});
test('PATCH canoniza os dois pedidos; outras edicoes jamais desbloqueiam legado',async()=>{
 for(const status of ['bloqueado','bloqueada']){const o=await account();const before=await stored(o);
 assert.equal((await api('/admin/assinaturas/'+o.id,'PATCH',{status,bloqueio_admin:false},admin)).status,200);
 const row=await stored(o);assert.equal(row.bloqueio_admin,true);assert.equal(row.status,before.status);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);}
 const o=await account();await db.runAsync("UPDATE assinaturas SET status='bloqueada',bloqueio_admin=FALSE WHERE id=$1",[o.id]);
 assert.equal((await api('/admin/assinaturas/'+o.id,'PATCH',{status:'pendente',bloqueio_admin:false},admin)).status,200);
 assert.equal((await stored(o)).bloqueio_admin,true);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);
 for(const status of ['inventado',' BLOQUEADA ','BLOQUEADO',null,{},'ativo'])assert.equal((await api('/admin/assinaturas/'+o.id,'PATCH',{status},admin)).status,400);
 assert.equal((await api('/admin/assinaturas/'+o.id,'PATCH',{status:'bloqueado'},o.headers)).status,401);
});
test('desbloqueio respeita trial expirado, assinatura irregular e revogacao',async()=>{
 for(const fields of ["trial_started_at='2000-01-01T00:00:00Z',trial_ends_at='2000-01-08T00:00:00Z'","ultimo_pagamento='2026-09-01',proximo_vencimento=NULL","ultimo_pagamento='2026-09-01',proximo_vencimento='2099-01-01',gateway_status='refunded'"]){
 const o=await account();await db.runAsync("UPDATE assinaturas SET status='bloqueada',bloqueio_admin=FALSE,"+fields+' WHERE id=$1',[o.id]);
 assert.equal((await api('/admin/assinaturas/'+o.id+'/desbloquear','POST',{},admin)).status,200);
 assert.equal((await stored(o)).bloqueio_admin,false);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);}
});
test('conta normal, expiracao financeira nova e renovacao nao criam suspensao administrativa',async()=>{
 const o=await account();assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
 const id=await payment(o);await signed(id);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
 await db.runAsync("UPDATE assinaturas SET vencimento_em='2000-01-01T00:00:00Z',proximo_vencimento='2000-01-01' WHERE id=$1",[o.id]);
 assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);const expired=await stored(o);
 assert.equal(expired.status,'atrasada');assert.equal(expired.bloqueio_admin,false);
 const next=await payment(o);await signed(next);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
 remote.get(next).status='refunded';await signed(next);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,403);assert.equal((await stored(o)).bloqueio_admin,false);
 const third=await payment(o);await signed(third);assert.equal((await api('/studiofy/painel','GET',undefined,o.headers)).status,200);
});
