const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {createSecurityLimits,POLICIES}=require('../services/securityLimits');
test('Etapa 5: APIs sensiveis, headers hostis, checkout e isolamento',async t=>{
  const env=require('./helpers/postgres').testEnvironment();
  Object.assign(process.env,{LEGACY_ADMIN_EMAIL:'limits-admin@example.test',LEGACY_ADMIN_PASSWORD:crypto.randomUUID(),MERCADO_PAGO_ACCESS_TOKEN:crypto.randomUUID(),MERCADO_PAGO_WEBHOOK_SECRET:crypto.randomUUID(),MERCADO_PAGO_MODE:'test',PUBLIC_APP_URL:'https://example.test',RESEND_API_KEY:'synthetic-resend-key',EMAIL_FROM:'security@example.test'});
  const db=require('../database');await db.ready;
  // Control only quota SQL time; counters, transactions and authentication stay real.
  const quotaTime='2026-01-01T00:00:30.000Z';
  const compact=sql=>sql.replace(/\s+/g,' ').trim();
  const counterSql=compact(`WITH moment AS (
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS at
  ), frame AS (
    SELECT at, (at / $2::bigint) * $2::bigint AS start FROM moment
  ) INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at)
    SELECT $1,start,1,to_timestamp((start+$2::bigint)/1000.0) FROM frame
    ON CONFLICT(key_hash,window_start) DO UPDATE
      SET hits=LEAST(public_request_limits.hits::bigint+1,$3::bigint+1)::integer
    RETURNING hits,ceil(extract(epoch FROM (expires_at-clock_timestamp())))::integer AS retry`);
  const cleanupSql=operator=>`DELETE FROM public_request_limits WHERE (key_hash,window_start) IN (SELECT key_hash,window_start FROM public_request_limits WHERE expires_at${operator}clock_timestamp() LIMIT 1000)`;
  const quotaQueries=new Map([
    [counterSql,{name:'counter',clocks:2,params:3}],
    [cleanupSql('<='),{name:'securityCleanup',clocks:1,params:0}],
    [cleanupSql('<'),{name:'publicCleanup',clocks:1,params:0}],
  ]);
  const adapted={counter:0,securityCleanup:0,publicCleanup:0},structureErrors=[];
  function quotaArgs(sql,params=[]) {
    const normalized=compact(sql),shape=quotaQueries.get(normalized);
    const quotaFamily=/^WITH\b.*\bINSERT INTO public_request_limits\b/.test(normalized)||
      /^DELETE FROM public_request_limits WHERE \(key_hash,window_start\) IN/.test(normalized);
    if(!shape&&!quotaFamily)return [sql,params];
    try {
      assert.ok(shape,'Quota SQL structure changed; review the test time adapter.');
      assert.equal((sql.match(/clock_timestamp\(\)/g)||[]).length,shape.clocks,'Quota SQL clock count changed.');
      assert.equal(params.length,shape.params,'Quota SQL parameter count changed.');
    } catch(error) {structureErrors.push(error.message);throw error;}
    adapted[shape.name]++;
    return [sql.replace(/clock_timestamp\(\)/g,()=>`$${params.length+1}::timestamptz`),[...params,quotaTime]];
  }
  const transaction=db.transaction,runAsync=db.runAsync;
  const transactionMock=t.mock.method(db,'transaction',(work,...options)=>transaction.call(db,store=>work({
    ...store,
    getAsync:(sql,params)=>store.getAsync(...quotaArgs(sql,params)),
    runAsync:(sql,params)=>store.runAsync(...quotaArgs(sql,params)),
  }),...options));
  const cleanupMock=t.mock.method(db,'runAsync',(sql,params)=>runAsync.call(db,...quotaArgs(sql,params)));
  t.after(()=>{
    try {
      assert.deepEqual(structureErrors,[],'Quota SQL adapter structural failures (even if caught by a limiter).');
      for(const [name,count] of Object.entries(adapted))assert.ok(count>0,`Quota SQL adapter not exercised: ${name}`);
    } finally {transactionMock.mock.restore();cleanupMock.mock.restore();}
  });
  const app=express();app.set('trust proxy',true);app.use(express.json());app.use('/api',require('../routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
  const nativeFetch=global.fetch,logs=[],posts=[],emails=[];const limiter=createSecurityLimits(db);
  t.mock.method(console,'info',(...args)=>logs.push(args));t.mock.method(console,'error',(...args)=>logs.push(args));
  t.mock.method(global,'fetch',async(url,options)=>{
    if(String(url)==='https://api.resend.com/emails'){emails.push(JSON.parse(options.body));return Response.json({id:'synthetic-email'});}
    assert.ok(String(url).startsWith('https://api.mercadopago.com/'),'Provider only simulated');
    if(String(url).endsWith('/users/me'))return Response.json({email:'seller@example.test'});
    assert.ok(String(url).endsWith('/checkout/preferences'));const body=JSON.parse(options.body);posts.push(body);
    return Response.json({id:'synthetic-preference-'+posts.length,sandbox_init_point:'https://sandbox.mercadopago.com.br/limit-'+posts.length});
  });
  const api=async(p,method='POST',body={},headers={})=>{const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api${p}`,{method,headers:{'Content-Type':'application/json',...headers},body:method==='GET'?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),retry:r.headers.get('retry-after'),cache:r.headers.get('cache-control')};};
  const owners=[];
  for(let n=0;n<2;n++){
    const body={barbeariaNome:'Limit fixture '+n,responsavelNome:'Fixture',email:`limit-owner-${n}@example.test`,telefone:'1198666600'+n,senha:'synthetic-owner-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Fixture',preco:30}]};
    const created=await api('/publico/assinaturas','POST',body);assert.equal(created.status,201);const session=await api('/barbeiro/login','POST',{identificador:body.email,senha:body.senha});assert.equal(session.status,200);
    owners.push({id:created.body.assinatura.id,email:body.email,phone:body.telefone,senha:body.senha,headers:{'x-barbeiro-token':session.body.token}});
  }
  const [a,b]=owners;
  const drain=async(scope,id,n=POLICIES[scope].limit)=>{for(let i=0;i<n;i++)await limiter.check({set(){return this;},status(){return this;},json(){return this;}},scope,id);};
  await t.test('login normal cliente/Admin abaixo do limite com no-store',async()=>{
    const owner=await api('/barbeiro/login','POST',{identificador:a.phone,senha:a.senha});assert.equal(owner.status,200);assert.equal(owner.cache,'no-store');
    const admin=await api('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:process.env.LEGACY_ADMIN_PASSWORD});assert.equal(admin.status,200);assert.equal(admin.cache,'no-store');
  });
  await t.test('brute force e normalizacao: vinte tentativas, depois 429 apesar de trocar IP/header',async()=>{
    const key=await limiter.budgetKey('ownerLogin',b.email);
    const windowStart=Math.floor(Date.parse(quotaTime)/POLICIES.ownerLogin.windowMs)*POLICIES.ownerLogin.windowMs;
    const persisted=async hits=>{
      const rows=await db.allAsync('SELECT window_start,hits,expires_at FROM public_request_limits WHERE key_hash=$1',[key]);
      assert.equal(rows.length,1,'One real PostgreSQL quota window for this identity.');
      assert.equal(rows[0].window_start,windowStart);assert.equal(rows[0].hits,hits);
      assert.equal(rows[0].expires_at.getTime(),windowStart+POLICIES.ownerLogin.windowMs);
    };
    await persisted(1); // The successful fixture login consumed this same window.
    for(let n=0;n<20;n++){
      const r=await api('/barbeiro/login','POST',{identificador:b.email,senha:'wrong-sensitive-password'},{'X-Forwarded-For':`203.0.113.${n}`,'X-Real-IP':`192.0.2.${n}`});
      assert.equal(r.status,n<19?401:429); // Initial successful login already consumed one.
      await persisted(n+2);
    }
    const r=await api('/barbeiro/login','POST',{identificador:' '+b.email.toUpperCase()+' ',senha:b.senha},{Forwarded:'for=8.8.8.8','X-Forwarded-For':'1.1.1.1','X-RateLimit-Limit':'999999'});
    assert.equal(r.status,429);assert.ok(Number(r.retry)>=1&&Number(r.retry)<=300);assert.equal(r.cache,'no-store');assert.doesNotMatch(JSON.stringify(r.body),/limit-owner|password|token|key_hash/);
    await persisted(21); // Normalization retains the key and the saturated counter.
    assert.equal((await api('/barbeiro/login','POST',{identificador:a.email,senha:a.senha})).status,200,'No collective login lock');
  });
  await t.test('login inexistente e existente com senha errada usam resposta generica e quotas iguais',async()=>{
    const unknown='unknown-'+crypto.randomUUID()+'@example.test';
    const known=await api('/barbeiro/login','POST',{identificador:a.phone,senha:'wrong'}),absent=await api('/barbeiro/login','POST',{identificador:unknown,senha:'wrong'});assert.equal(known.status,401);assert.deepEqual(absent.body,known.body);
    await drain('ownerLogin',unknown);const excess=await api('/barbeiro/login','POST',{identificador:unknown,senha:'wrong'});assert.equal(excess.status,429);
    await drain('adminLogin',process.env.LEGACY_ADMIN_EMAIL);assert.equal((await api('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:'wrong'})).status,429);
  });
  await t.test('recuperacao conhecida/desconhecida confirma genericamente; excessos de email/token limitados',async()=>{
    const unknown='recovery-'+crypto.randomUUID()+'@example.test';
    const known=await api('/barbeiro/recuperar-senha/solicitar','POST',{email:a.email}),absent=await api('/barbeiro/recuperar-senha/solicitar','POST',{email:unknown});assert.equal(known.status,200);assert.deepEqual(absent.body,known.body);assert.equal(emails.length,1);
    await drain('recoveryRequest',unknown);assert.equal((await api('/barbeiro/recuperar-senha/solicitar','POST',{email:unknown})).status,429);
    const token=crypto.randomBytes(32).toString('hex');await drain('recoveryReset',token);assert.equal((await api('/barbeiro/recuperar-senha/redefinir','POST',{token,novaSenha:'sensitive-reset-password',confirmarSenha:'sensitive-reset-password'})).status,429);
    await drain('recoveryStatus',token);assert.equal((await api('/barbeiro/recuperar-senha/token-status?token='+token,'GET')).status,429);assert.ok(!JSON.stringify(logs).includes(token));
  });
  await t.test('checkout: duplo clique e retry usam mesma preferencia e preco backend',async()=>{
    const results=await Promise.all([api(`/publico/assinaturas/${a.id}/checkout`,'POST',{amount:1,dias:365},a.headers),api(`/publico/assinaturas/${a.id}/checkout`,'POST',{},a.headers)]);
    assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));assert.equal(posts.length,1);assert.equal(posts[0].items[0].unit_price,65);
    const retry=await api(`/publico/assinaturas/${a.id}/checkout`,'POST',{},a.headers);assert.equal(retry.status,200);assert.equal(posts.length,1);assert.equal((await db.getAsync('SELECT COUNT(*)::int AS n FROM mercado_pago_orders WHERE assinatura_id=$1',[a.id])).n,1);
  });
  await t.test('conta A e IDs falsos nao consomem quota privada de B, nem geram checkout',async()=>{
    const key=await limiter.budgetKey('checkoutOwner',b.id);assert.equal(await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key]),undefined);
    const before=posts.length;
    for(const id of [b.id,999999999,987654321,'not-a-number','0001']){const r=await api(`/publico/assinaturas/${id}/checkout`,'POST',{amount:1,accountId:b.id,limit:999999},a.headers);assert.equal(r.status,401);assert.deepEqual(r.body,{error:'Credenciais invalidas para gerar o pagamento.'});}
    assert.equal(posts.length,before);assert.equal(await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key]),undefined);
    const good=await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{},b.headers);assert.equal(good.status,200);assert.equal((await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key])).hits,1);
  });
  await t.test('checkout por senha: 429 sobrevive a troca de IP e token forjado; sessao proprietaria independente',async()=>{
    await drain('checkoutPassword',String(b.id));
    const denied=await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{senha:b.senha},{'X-Forwarded-For':'127.0.0.1','x-barbeiro-token':'forged-sensitive-token'});assert.equal(denied.status,429);assert.ok(Number(denied.retry)>=1);
    assert.equal((await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{},b.headers)).status,200);
  });
  await t.test('quota privada de checkout limita excesso e nao permite mudar ID para contornar',async()=>{
    await drain('checkoutOwner',a.id);const before=posts.length;
    assert.equal((await api(`/publico/assinaturas/${a.id}/checkout`,'POST',{},a.headers)).status,429);
    assert.equal((await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{},a.headers)).status,429,'Anonymous password bucket exhausted, no private authorization');
    assert.equal((await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{},b.headers)).status,200);assert.equal(posts.length,before);
  });
  await t.test('storage indisponivel retorna 503 antes de autenticar/criar preferencia; logs sem segredos',async sub=>{
    const before=posts.length,account=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[b.id]);
    sub.mock.method(db,'transaction',async()=>{throw Error('sensitive-storage-password-cookie-Authorization');});
    for(const p of ['/barbeiro/login','/admin/login',`/publico/assinaturas/${b.id}/checkout`]){
      const r=await api(p,'POST',{identificador:a.email,email:process.env.LEGACY_ADMIN_EMAIL,senha:'sensitive-request-password',cookie:'sensitive-body-cookie'},p.includes('checkout')?b.headers:{Authorization:'sensitive-authorization',Cookie:'sensitive-header-cookie'});
      assert.equal(r.status,503);assert.equal(r.retry,'5');assert.doesNotMatch(JSON.stringify(r.body),/sensitive|Authorization|storage/);
    }
    assert.equal(posts.length,before);assert.deepEqual(await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[b.id]),account);
    const text=JSON.stringify(logs);for(const marker of ['wrong-sensitive-password','sensitive-reset-password','forged-sensitive-token','sensitive-storage-password','sensitive-request-password','sensitive-body-cookie','sensitive-authorization','sensitive-header-cookie'])assert.ok(!text.includes(marker),marker);
  });
  await t.test('rate limit nunca remove bloqueio administrativo',async()=>{
    await db.runAsync('UPDATE assinaturas SET bloqueio_admin=TRUE WHERE id=$1',[b.id]);
    const checkout=await api(`/publico/assinaturas/${b.id}/checkout`,'POST',{},b.headers);assert.equal(checkout.status,200);
    assert.equal((await db.getAsync('SELECT bloqueio_admin FROM assinaturas WHERE id=$1',[b.id])).bloqueio_admin,true);
    assert.equal((await api('/studiofy/painel','GET',undefined,b.headers)).status,403);
  });
});
