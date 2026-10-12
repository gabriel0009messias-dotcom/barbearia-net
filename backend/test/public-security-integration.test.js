const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),path=require('node:path');
const {fork}=require('node:child_process');
const {POLICIES,budgetKey}=require('../services/publicLimits');
const {normalizePhone}=require('../services/trial');

test('Segurança pública: identidade, autorização, cache e limites PostgreSQL',{timeout:60000},async t=>{
 const environment=require('./helpers/postgres').testEnvironment();
 Object.assign(process.env,{EVOLUTION_API_URL:'',EVOLUTION_API_KEY:'',MERCADO_PAGO_ACCESS_TOKEN:'',MERCADO_PAGO_WEBHOOK_SECRET:''});
 const db=require('../database');await db.ready;
 const router=require('../routes'),app=express();app.use(express.json());app.use('/api',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();await environment.cleanup();});
 const request=async(url,data,token,method=data?'POST':'GET')=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api${url}`,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control'),retry:response.headers.get('retry-after')};
 };
 const fixture=n=>({establishmentName:'Studio Fictício '+n,responsavelNome:'Pessoa Fictícia',businessType:'other',city:'Cidade Fictícia',state:'SP',telefone:'1198000111'+n,whatsappNumero:'1199000222'+n,email:`security-${n}@example.test`,senha:'fixture-only-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Serviço Fictício',preco:40,duracao:30}]});
 async function account(n){const body=fixture(n),result=await request('/publico/assinaturas',body);assert.equal(result.status,201);const login=await request('/barbeiro/login',{identificador:body.email,senha:body.senha});assert.equal(login.status,200);return {body,id:result.data.assinatura.id,token:login.data.token};}
 const a=await account(1),b=await account(2);
 const page=(account,telefone)=>request('/studiofy/pagina',{nome:account.body.establishmentName,slug:'studio-'+account.id,descricao:'Teste',cor:'#123456',telefone},account.token,'PUT');
 for(const [name,owner,value] of [['B tenta telefone de A',b,'+55 '+a.body.telefone],['B tenta WhatsApp de A',b,a.body.whatsappNumero],['A tenta WhatsApp de B',a,b.body.whatsappNumero]])await t.test(name,async()=>{
  const before=await db.getAsync('SELECT telefone,barbearia_nome FROM assinaturas WHERE id=$1',[owner.id]);
  const result=await page(owner,value);assert.equal(result.status,409);assert.equal(result.data.code,'TELEFONE_JA_UTILIZADO');assert.deepEqual(await db.getAsync('SELECT telefone,barbearia_nome FROM assinaturas WHERE id=$1',[owner.id]),before);
  assert.equal((await request('/barbeiro/login',{identificador:a.body.telefone,senha:a.body.senha})).status,200);
 });
 await t.test('própria identidade e telefone novo são permitidos e normalizados',async()=>{
  assert.equal((await page(b,'+55 '+b.body.telefone)).status,200);
  assert.equal((await page(b,'+55 '+b.body.whatsappNumero)).status,200);
  assert.equal((await page(b,'+55 (11) 98000-9999')).status,200);
  assert.equal((await db.getAsync('SELECT telefone FROM assinaturas WHERE id=$1',[b.id])).telefone,'11980009999');
  assert.equal((await page(b,b.body.telefone)).status,200);
 });
 await t.test('duas páginas concorrentes não persistem telefone duplicado',async()=>{
  const results=await Promise.all([page(a,'11980008888'),page(b,'+55 (11) 98000-8888')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const rows=await db.allAsync('SELECT telefone FROM assinaturas');assert.equal(rows.filter(r=>normalizePhone(r.telefone)==='11980008888').length,1);
  assert.equal((await page(a,a.body.telefone)).status,200);assert.equal((await page(b,b.body.telefone)).status,200);
 });
 await t.test('cadastro concorrente com personalização mantém identidade exclusiva',async()=>{
  const fresh=fixture(3);fresh.telefone='11980007777';
  const results=await Promise.all([page(b,fresh.telefone),request('/publico/assinaturas',fresh)]);
  assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(results.filter(r=>[200,201].includes(r.status)).length,1);
  assert.equal((await db.allAsync('SELECT telefone FROM assinaturas')).filter(r=>normalizePhone(r.telefone)===fresh.telefone).length,1);
 });
 const noStore=result=>assert.equal(result.cache,'no-store');
 await t.test('IDs não autorizados não revelam dados nem criam budgets por ID',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  for(const id of [a.id,b.id,99999,'invalid','0','-1']){const result=await request(`/publico/assinaturas/${id}/status`);assert.equal(result.status,401);noStore(result);assert.deepEqual(Object.keys(result.data),['error']);}
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);
  for(const id of [b.id,99999]){const result=await request(`/publico/assinaturas/${id}/status`,undefined,a.token);assert.equal(result.status,403);noStore(result);assert.deepEqual(Object.keys(result.data),['error']);}
  const invalid=await request('/publico/assinaturas/invalid/status',undefined,a.token);assert.equal(invalid.status,400);noStore(invalid);
 });
 await t.test('status autorizado mínimo funciona no trial e na contratação sem trial',async()=>{
  const active=await request(`/publico/assinaturas/${a.id}/status`,undefined,a.token);assert.equal(active.status,200);assert.deepEqual(active.data,{id:a.id,liberado:true});noStore(active);
  const paidBody=fixture(4),paid=await request('/publico/assinaturas',{...paidBody,contratarSemTrial:true});assert.equal(paid.status,201);assert.equal(paid.data.trialIniciado,false);
  const login=await request('/barbeiro/login',{identificador:paidBody.email,senha:paidBody.senha});assert.equal(login.status,200);
  const status=await request(`/publico/assinaturas/${paid.data.assinatura.id}/status`,undefined,login.data.token);assert.equal(status.status,200);assert.deepEqual(status.data,{id:paid.data.assinatura.id,liberado:false});noStore(status);
 });
 await t.test('rotas privadas têm no-store em sucesso, token inválido, 401 e 403',async()=>{
  for(const suffix of ['', '/acesso','/status']){
   const own=await request(`/publico/assinaturas/${a.id}${suffix}`,undefined,a.token);assert.equal(own.status,200);noStore(own);
   for(const token of [undefined,'invalid-fixture']){const result=await request(`/publico/assinaturas/${a.id}${suffix}`,undefined,token);assert.equal(result.status,401);noStore(result);}
   const foreign=await request(`/publico/assinaturas/${b.id}${suffix}`,undefined,a.token);assert.equal(foreign.status,403);noStore(foreign);
  }
  const checkout=await request(`/publico/assinaturas/${a.id}/checkout`,{senha:'incorrect-fixture'});assert.equal(checkout.status,401);noStore(checkout);
 });
 await t.test('falha de banco na autenticação não vaza detalhes e mantém no-store',async sub=>{
  sub.mock.method(db,'get',(_sql,_params,callback)=>callback(Error('synthetic-sensitive-db-detail')));
  for(const suffix of ['', '/acesso','/status']){
   const result=await request(`/publico/assinaturas/${a.id}${suffix}`,undefined,a.token);
   assert.equal(result.status,500);noStore(result);assert.equal(JSON.stringify(result.data).includes('synthetic-sensitive'),false);
  }
 });
 await t.test('no-store e erros seguros também cobrem 404 e falhas de banco',async sub=>{
  for(const suffix of ['', '/acesso','/status']){
   const route=router.stack.find(layer=>layer.route?.path===`/publico/assinaturas/:id${suffix}`).route;
   const response={code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
   route.stack[0].handle({},response,()=>{});
   const req={params:{id:String(a.id)},assinatura:{id:a.id}};
   const original=db.get;
   sub.mock.method(db,'get',(_sql,_params,callback)=>callback(null,undefined));
   await route.stack.at(-1).handle(req,response);assert.equal(response.code,404);assert.equal(response.headers['Cache-Control'],'no-store');
   sub.mock.restoreAll();
   sub.mock.method(db,'get',(_sql,_params,callback)=>callback(Error('synthetic-private-db-detail')));
   response.code=200;await route.stack.at(-1).handle(req,response);assert.equal(response.code,500);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(JSON.stringify(response.data).includes('synthetic-private'),false);
   sub.mock.restoreAll();assert.equal(db.get,original);
  }
 });
 async function seed(scope,context,hits,clock=Date.now()){const policy=POLICIES[scope],start=Math.floor(clock/policy.windowMs)*policy.windowMs;await db.runAsync('INSERT INTO public_request_limits VALUES($1,$2,$3,$4)',[budgetKey(scope,policy,context),start,hits,new Date(start+policy.windowMs)]);}
 await t.test('status limitado por conta e globalmente com Retry-After e no-store',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');await seed('subscriptionStatus',{tenantId:a.id},POLICIES.subscriptionStatus.limit);
  const limited=await request(`/publico/assinaturas/${a.id}/status`,undefined,a.token);assert.equal(limited.status,429);noStore(limited);assert.ok(Number(limited.retry)>0);
  assert.equal((await request(`/publico/assinaturas/${b.id}/status`,undefined,b.token)).status,200);
  await db.runAsync('DELETE FROM public_request_limits');await seed('subscriptionStatusGlobal',undefined,POLICIES.subscriptionStatusGlobal.limit);
  const global=await request(`/publico/assinaturas/${a.id}/status`);assert.equal(global.status,429);noStore(global);
 });
 await t.test('dois processos compartilham os budgets reais de status',async()=>{
  for(const scope of ['subscriptionStatusGlobal','subscriptionStatus']){
   await db.runAsync('DELETE FROM public_request_limits');const clock=Math.floor(Date.now()/60000)*60000+10000;
   const context=scope==='subscriptionStatus'?{tenantId:a.id}:undefined;await seed(scope,context,POLICIES[scope].limit-2,clock);
   const outcomes=await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{
    const child=fork(path.join(__dirname,'helpers/subscription-status-worker.js'),[],{windowsHide:true,env:{...process.env,STATUS_TEST_CLOCK:String(clock),STATUS_TEST_SCOPE:scope,STATUS_TEST_TENANT:String(a.id)},stdio:['ignore','ignore','ignore','ipc']});let result;
    child.on('message',value=>result=value);child.on('error',reject);child.on('exit',code=>code===0&&result?resolve(result):reject(Error('Status worker failed')));
   })));
   assert.equal(outcomes.reduce((n,r)=>n+r.accepted,0),2);assert.equal(outcomes.reduce((n,r)=>n+r.limited,0),4);
  }
 });
 await t.test('catálogo HTTP usa DTO e ignora colunas internas fictícias',async sub=>{
  await db.runAsync('DELETE FROM public_request_limits');const original=db.transaction;
  sub.mock.method(db,'transaction',function(callback,options){return original.call(db,c=>callback({...c,allAsync:async(sql,params)=>{
   const rows=await c.allAsync(sql,params);return /FROM servicos_assinatura|FROM profissionais/.test(sql)?rows.map(row=>({...row,internal_future:'synthetic-internal-field'})):rows;
  }}),options);});
  const result=await request(`/studiofy/public/studio-${a.id}`);assert.equal(result.status,200);assert.equal(JSON.stringify(result.data).includes('synthetic-internal'),false);
  for(const row of [...result.data.servicos,...result.data.profissionais]){assert.equal(row.assinatura_id,undefined);assert.equal(row.internal_future,undefined);}
 });
});
