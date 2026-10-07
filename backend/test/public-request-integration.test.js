const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {localMoment}=require('../services/agenda');
const {addDays}=require('../services/whatsapp/scheduling');
const {createPublicLimiter,POLICIES,budgetKey}=require('../services/publicLimits');

test('Etapa 2: recibos idempotentes, perda de resposta, isolamento e limites persistentes PostgreSQL',{timeout:60000},async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 Object.assign(process.env,{MERCADO_PAGO_ACCESS_TOKEN:'',EVOLUTION_API_URL:'',EVOLUTION_API_KEY:'',PUBLIC_TRUSTED_PROXY_CIDRS:''});
 const db=require('../database');await db.ready;
 const app=express();app.set('trust proxy',true);app.use(express.json({limit:'6mb'}));
 let drop=false;
 app.use((req,res,next)=>{const json=res.json.bind(res);res.json=data=>{if(drop&&req.path.endsWith('/agendamentos')&&res.statusCode===201){drop=false;req.socket.destroy();return res;}return json(data);};next();});
 app.use('/api',require('../routes'));
 app.post('/small/:slug',async(req,res,next)=>{if(await createPublicLimiter(db,'test-limited',{context:'tenant',limit:2,windowMs:60000}).check(res,{tenantId:req.params.slug==='a'?1:2}))next();},(_req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(url,body,key,method='POST',auth)=>{
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...(auth?{'x-barbeiro-token':auth}:{}),'X-Forwarded-For':crypto.randomBytes(4).join('.')},body:method==='GET'?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),retry:r.headers.get('Retry-After')};
 };
 let n=0;
 const create=async()=>{
  const i=++n,email=`request-${i}@example.test`,signup=await request('/api/publico/assinaturas',{establishmentName:`Studio Requests ${i}`,responsavelNome:'Ana',businessType:'nails',city:'Recife',state:'PE',telefone:`1199000${String(i).padStart(4,'0')}`,email,senha:'synthetic-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Manicure',preco:35.20,duracao:30}]});
  assert.equal(signup.status,201);const id=signup.data.assinatura.id;
  const login=await request('/api/barbeiro/login',{identificador:email,senha:'synthetic-password'}),token=login.data.token;
  const panel=await request('/api/studiofy/painel',undefined,undefined,'GET',token);
  await request('/api/studiofy/horarios',{horarios:Array.from({length:7},()=>[['08:00','18:00']])},undefined,'PUT',token);
  return {id,token,service:panel.data.servicos[0].id,professional:panel.data.profissionais[0].id};
 };
 const a=await create(),b=await create(),date=addDays(localMoment().date,2);
 const root=x=>`/api/studiofy/public/studio-${x.id}/agendamentos`;
 const body=(hour='08:00',extra={})=>({nome_cliente:'Cliente Requests',telefone:'11999990000',servico_id:a.service,profissional_id:a.professional,data:date,hora:hour,...extra});
 const key=()=>crypto.randomBytes(32).toString('hex');
 let first;
 await t.test('migration 012 adiciona estruturas sem reescrever dados anteriores',async()=>{
  const c=await db.pool.connect();
  try{
   await c.query('BEGIN');
   const tables=['assinaturas','servicos_assinatura','profissionais','agendamentos','appointment_reminders','public_booking_access'];
   const before={};for(const table of tables)before[table]=(await c.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
   await c.query('DROP TABLE public_booking_requests,public_request_limits');
   await c.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../database/migrations/012_public_booking_requests.sql'),'utf8'));
   for(const table of tables)assert.deepEqual((await c.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,before[table],table);
   assert.equal((await c.query('SELECT count(*)::int AS n FROM public_booking_requests')).rows[0].n,0);
  }finally{await c.query('ROLLBACK');c.release();}
 });
 await t.test('requisições simultâneas equivalentes retornam mesma capacidade e uma reserva',async()=>{
  const k=key(),responses=await Promise.all([request(root(a),body(),k),request(root(a),body(),k)]);
  assert.deepEqual(responses.map(r=>r.status),[201,201]);assert.deepEqual(responses[0].data,responses[1].data);first={...responses[0].data,key:k};
  assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1',[a.id])).n,1);
  const receipt=await db.getAsync('SELECT * FROM public_booking_requests WHERE assinatura_id=$1',[a.id]);
  assert.ok(!JSON.stringify(receipt).includes(k));assert.ok(!JSON.stringify(receipt).includes(first.token));assert.equal(receipt.key_hash.length,64);
  assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM appointment_reminders')).n,1);
 });
 await t.test('mesma chave com outro cliente ou dados retorna 409 sem revelar token',async()=>{
  for(const changed of [{hora:'08:30'},{telefone:'11999991111'},{nome_cliente:'Outra pessoa'}]){
   const r=await request(root(a),body('08:00',changed),first.key);assert.equal(r.status,409);assert.deepEqual(Object.keys(r.data),['error']);assert.ok(!JSON.stringify(r.data).includes(first.token));
  }
 });
 await t.test('perda da resposta depois do commit permite recuperação sem duplicar',async()=>{
  const k=key();drop=true;await assert.rejects(request(root(a),body('09:00'),k));
  const count=await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1',[a.id]);assert.equal(count.n,2);
  const recovered=await request(root(a),body('09:00'),k);assert.equal(recovered.status,201);
  assert.equal((await request('/api/studiofy/public/reservas/consultar',{token:recovered.data.token})).status,200);
  assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1',[a.id])).n,2);
 });
 await t.test('recuperação privada funciona após bloqueio ou mudança de slug sem liberar nova reserva',async()=>{
  const privateRoot='/api/studiofy/public/reservas/recuperar',payload={chave:first.key,solicitacao:body()};
  const accessBefore=await db.getAsync('SELECT status,status_assinatura,bloqueado,proximo_vencimento,acesso_manual_ate FROM assinaturas WHERE id=$1',[a.id]);
  await db.runAsync("UPDATE assinaturas SET status='bloqueada',status_assinatura='BLOQUEADA',bloqueado=1,proximo_vencimento=NULL,acesso_manual_ate=NULL,public_slug='requests-renamed' WHERE id=$1",[a.id]);
  try{
   const recovered=await request(privateRoot,payload);assert.equal(recovered.status,200);assert.equal(recovered.data.token,first.token);assert.equal(recovered.data.agendamento.slug,'requests-renamed');
   assert.equal((await request(root(a),body(),first.key)).status,404);
   assert.equal((await request(privateRoot,{...payload,chave:key()})).status,404);
   const wrong=await request(privateRoot,{...payload,solicitacao:body('08:00',{telefone:'11999995555',assinatura_id:b.id})});assert.equal(wrong.status,404);assert.equal(wrong.data.token,undefined);
  }finally{await db.runAsync('UPDATE assinaturas SET status=$1,status_assinatura=$2,bloqueado=$3,proximo_vencimento=$4,acesso_manual_ate=$5 WHERE id=$6',[...['status','status_assinatura','bloqueado','proximo_vencimento','acesso_manual_ate'].map(field=>accessBefore[field]),a.id]);await db.runAsync('UPDATE assinaturas SET public_slug=$1 WHERE id=$2',[`studio-${a.id}`,a.id]);}
 });
 await t.test('chave imprevisível é obrigatória quando fornecida; sem ela proteção 201/409 permanece',async()=>{
  for(const k of ['123', 'f'.repeat(63), 'x'.repeat(64)])assert.equal((await request(root(a),body('10:00'),k)).status,400);
  const results=await Promise.all([request(root(a),body('10:00')),request(root(a),body('10:00'))]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 });
 await t.test('escopo e IDs manipulados não atravessam estabelecimentos',async()=>{
  assert.equal((await request(root(b),body(),first.key)).status,409);
  const k=key(),r=await request(root(b),body('08:00',{servico_id:b.service,profissional_id:b.professional,assinatura_id:a.id}),k);
  assert.equal(r.status,201);assert.notEqual(r.data.token,first.token);assert.equal(r.data.agendamento.estabelecimento,'Studio Requests 2');
  assert.equal((await request(root(a),body('11:00',{profissional_id:b.professional}),key())).status,409);
 });
 await t.test('passado, fora do expediente, bloqueio e término após fechamento continuam recusados',async()=>{
  for(const changed of [{data:addDays(localMoment().date,-1)},{hora:'07:30'},{hora:'18:00'}])assert.ok([400,409].includes((await request(root(a),body('12:00',changed),key())).status));
  await request('/api/studiofy/bloqueios',{data:date,hora:'12:00',fim:'13:00',profissional_id:a.professional},undefined,'POST',a.token);
  assert.equal((await request(root(a),body('12:00'),key())).status,409);
 });
 await t.test('cancelamento e recuperação repetida mantêm estados e não reservam novamente',async()=>{
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:'0'.repeat(64),confirmar:true})).status,404);
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:first.token,confirmar:true})).status,200);
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:first.token,confirmar:true})).status,409);
  const retry=await request(root(a),body(),first.key);assert.equal(retry.status,201);assert.equal(retry.data.agendamento.status,'cancelado');
  const replacement=await request(root(a),body('08:00',{nome_cliente:'Cliente novo',telefone:'11999991111'}),key());assert.equal(replacement.status,201);assert.notEqual(replacement.data.token,first.token);
  assert.equal((await request('/api/studiofy/public/reservas/consultar',{token:first.token})).data.nome_cliente,'Cliente Requests');
 });
 await t.test('revogação por troca de identidade não reemite token ao recuperar recibo',async()=>{
  const k=key(),r=await request(root(a),body('11:00'),k),row=await db.getAsync("SELECT id FROM agendamentos WHERE assinatura_id=$1 AND hora='11:00'",[a.id]);
  assert.equal((await request(`/api/studiofy/agendamentos/${row.id}`,body('11:00',{nome_cliente:'Nova identidade',telefone:'11999993333'}),undefined,'PUT',a.token)).status,200);
  assert.equal((await request('/api/studiofy/public/reservas/consultar',{token:r.data.token})).status,404);
  assert.equal((await request(root(a),body('11:00'),k)).status,404);
  const privateRetry=await request('/api/studiofy/public/reservas/recuperar',{chave:k,solicitacao:body('11:00')});assert.equal(privateRetry.status,404);assert.equal(privateRetry.data.code,undefined);
  assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM public_booking_access WHERE appointment_id=$1',[row.id])).n,0);
 });
 await t.test('Agenda recebe snapshot único e Financeiro mantém receita zero de confirmados',async()=>{
  const panel=await request('/api/studiofy/painel',undefined,undefined,'GET',a.token);
  const rows=panel.data.agendamentos.filter(x=>x.hora==='09:00');assert.equal(rows.length,1);
  assert.equal(rows[0].preco,35.2);assert.equal(rows[0].duracao,30);assert.equal(rows[0].profissional_id,a.professional);assert.equal(rows[0].status,'confirmado');
  assert.equal(panel.data.financeiro.total.valor_centavos,0);
 });
 await t.test('limites persistem entre middleware/instâncias, ignoram XFF e separam tenant/operação',async()=>{
  for(let i=0;i<2;i++)assert.equal((await request('/small/a',{})).status,200);
  const limited=await request('/small/a',{});assert.equal(limited.status,429);assert.ok(Number(limited.retry)>0);assert.deepEqual(Object.keys(limited.data),['error']);
  assert.equal((await request('/small/b',{})).status,200);
  app.post('/small-second/:slug',async(req,res,next)=>{if(await createPublicLimiter(db,'test-limited',{context:'tenant',limit:2,windowMs:60000}).check(res,{tenantId:req.params.slug==='a'?1:2}))next();},(_req,res)=>res.json({ok:true}));
  assert.equal((await request('/small-second/a',{})).status,429);
  assert.equal((await request(`/api/studiofy/public/studio-${a.id}`,undefined,undefined,'GET')).status,200);
 });
 await t.test('limite real de criação retorna 429 sem criar reserva, catálogo continua acessível',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  for(let i=0;i<POLICIES.booking.limit;i++)assert.equal((await request(root(b),body('08:00',{servico_id:b.service,profissional_id:b.professional}), 'f'.repeat(64))).status,409);
  const r=await request(root(b),body('09:00',{servico_id:b.service,profissional_id:b.professional}),key());assert.equal(r.status,429);assert.ok(r.retry);
  assert.equal((await request(`/api/studiofy/public/studio-${b.id}`,undefined,undefined,'GET')).status,200);
  assert.equal((await request(root(a),body('13:00'),key())).status,201);
  const stored=await db.allAsync('SELECT * FROM public_request_limits');assert.ok(!JSON.stringify(stored).includes('127.0.0.1'));assert.ok(!JSON.stringify(stored).includes('Cliente Requests'));
 });
 await t.test('limite real de cadastro e escopos de consulta/cancelamento são independentes',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  for(let i=0;i<POLICIES.signup.limit;i++)assert.equal((await request('/api/publico/assinaturas',{})).status,400);
  const limited=await request('/api/publico/assinaturas',{});assert.equal(limited.status,429);assert.ok(Number(limited.retry)>0);
  assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM assinaturas')).n,2);
  const read=await request('/api/studiofy/public/reservas/consultar',{token:first.token});assert.equal(read.status,200);
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:first.token,confirmar:true})).status,409);
 });
 async function seedBudget(scope,context,hits){
  const policy=POLICIES[scope],start=Math.floor(Date.now()/policy.windowMs)*policy.windowMs;
  await db.runAsync('INSERT INTO public_request_limits VALUES($1,$2,$3,$4)',[budgetKey(scope,policy,context),start,hits,new Date(start+policy.windowMs)]);
 }
 for(const [scope,path,payload] of [
  ['reservationReadGlobal','consultar',()=>({token:key()})],
  ['confirmationRecoveryGlobal','recuperar',()=>({chave:key(),solicitacao:body('16:00')})],
  ['cancellationGlobal','cancelar',()=>({token:key(),confirmar:true})],
 ])await t.test(`HTTP ${path}: invalid capabilities share global ceiling, never gain private contexts`,async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  const firstInvalid=await request(`/api/studiofy/public/reservas/${path}`,payload());assert.equal(firstInvalid.status,404);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);
  await db.runAsync('DELETE FROM public_request_limits');await seedBudget(scope,undefined,POLICIES[scope].limit-1);
  const responses=await Promise.all(Array.from({length:25},()=>request(`/api/studiofy/public/reservas/${path}`,payload())));
  assert.equal(responses.filter(x=>x.status===404).length,1);assert.equal(responses.filter(x=>x.status===429).length,24);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);
  for(const r of responses.filter(x=>x.status===429)){assert.ok(Number(r.retry)>0);assert.deepEqual(Object.keys(r.data),['error']);}
 });
 await t.test('HTTP distributed catalogue and slots requests cannot escape operation ceiling with slugs',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');await seedBudget('navigationGlobal',undefined,POLICIES.navigationGlobal.limit-1);
  const responses=await Promise.all(Array.from({length:25},(_,i)=>request(`/api/studiofy/public/unknown-${i}${i%2?'/horarios?data='+date:''}`,undefined,undefined,'GET')));
  assert.equal(responses.filter(x=>x.status===404).length,1);assert.equal(responses.filter(x=>x.status===429).length,24);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);
 });
 await t.test('HTTP new idempotency keys cannot bypass validated establishment ceiling',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');await seedBudget('booking',{tenantId:a.id},POLICIES.booking.limit-1);
  const before=(await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n;
  const responses=await Promise.all(Array.from({length:25},()=>request(root(a),body('07:00'),key())));
  assert.equal(responses.filter(x=>x.status===409).length,1);assert.equal(responses.filter(x=>x.status===429).length,24);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n,before);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,2);
 });
 await t.test('HTTP legitimate collective traffic, retry, private recovery and cancel remain usable',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  await Promise.all(Array.from({length:40},async(_,i)=>{
   const studio=i%2?a:b,slug=`/api/studiofy/public/studio-${studio.id}`;
   assert.equal((await request(slug,undefined,undefined,'GET')).status,200);
   assert.equal((await request(slug+'/horarios?'+new URLSearchParams({data:date,servico_id:studio.service,profissional_id:studio.professional}),undefined,undefined,'GET')).status,200);
  }));
  const k=key(),data=body('16:00'),created=await request(root(a),data,k);assert.equal(created.status,201);
  const retry=await request(root(a),data,k);assert.equal(retry.status,201);assert.equal(retry.data.token,created.data.token);
  const recovered=await request('/api/studiofy/public/reservas/recuperar',{chave:k,solicitacao:data});assert.equal(recovered.status,200);assert.equal(recovered.data.token,created.data.token);
  assert.equal((await request('/api/studiofy/public/reservas/consultar',{token:created.data.token})).status,200);
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:created.data.token,confirmar:true})).status,200);
 });
 await t.test('HTTP verified private contexts enforce per-reservation quotas without disclosing IDs',async()=>{
  await db.runAsync('DELETE FROM public_request_limits');
  const row=await db.getAsync('SELECT appointment_id FROM public_booking_requests WHERE key_hash=$1',[require('node:crypto').createHash('sha256').update(first.key).digest('hex')]);
  await seedBudget('reservationRead',{tenantId:a.id,reservationId:row.appointment_id},POLICIES.reservationRead.limit);
  const r=await request('/api/studiofy/public/reservas/consultar',{token:first.token});assert.equal(r.status,429);assert.ok(Number(r.retry)>0);assert.deepEqual(Object.keys(r.data),['error']);
  assert.equal((await request('/api/studiofy/public/reservas/consultar',{token:'0'.repeat(64)})).status,404);
 });
 await t.test('falhas públicas não registram chave, identidade ou token em logs',async sub=>{
  const logs=[];sub.mock.method(console,'log',(...args)=>logs.push(args));sub.mock.method(console,'error',(...args)=>logs.push(args));
  const secret=key();const r=await request(root(a),body('08:00'),secret);assert.equal(r.status,409);assert.deepEqual(Object.keys(r.data),['error']);
  for(const value of [secret,first.token,'Cliente Requests','11999990000'])assert.ok(!JSON.stringify(logs).includes(value));
 });
 await t.test('retry preserva snapshot após edição e conclusão válida fatura uma vez, sem permitir cancelamento',async()=>{
  const k=key(),created=await request(root(a),body('14:00'),k);assert.equal(created.status,201);
  assert.equal((await request(`/api/studiofy/servicos/${a.service}`,{nome:'Preço novo',preco:90,duracao:60,ativo:true},undefined,'PUT',a.token)).status,200);
  const row=await db.getAsync("SELECT id FROM agendamentos WHERE assinatura_id=$1 AND hora='14:00'",[a.id]);
  await db.runAsync('UPDATE agendamentos SET data=$1 WHERE id=$2',[addDays(localMoment().date,-1),row.id]);
  assert.equal((await request(`/api/studiofy/agendamentos/${row.id}`,{status:'concluido'},undefined,'PATCH',a.token)).status,200);
  const recovered=await request(root(a),body('14:00'),k);assert.equal(recovered.status,201);assert.equal(recovered.data.agendamento.status,'concluido');
  assert.equal(recovered.data.agendamento.preco,35.2);assert.equal(recovered.data.agendamento.duracao,30);assert.equal(recovered.data.token,created.data.token);
  assert.equal((await request('/api/studiofy/public/reservas/cancelar',{token:created.data.token,confirmar:true})).status,409);
  const panel=await request('/api/studiofy/painel',undefined,undefined,'GET',a.token);assert.equal(panel.data.financeiro.total.valor_centavos,3520);
  assert.equal(panel.data.agendamentos.filter(x=>x.id===row.id).length,1);
 });
});
