const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { TRIAL_MS } = require('../services/trial');

test('trial: cadastro, isolamento, expiracao, sessao e pagamento', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-test-secret';
  process.env.MERCADO_PAGO_MODE = 'test';
  process.env.PUBLIC_APP_URL = 'https://example.test';
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  app.use(express.static(require('node:path').resolve(__dirname,'../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const nativeFetch = global.fetch;
  global.fetch = async url => String(url).endsWith('/users/me') ? Response.json({email:'seller@example.test'}) : Response.json({id:'trial-checkout',sandbox_init_point:'https://sandbox.mercadopago.com.br/trial'});
  t.after(async () => { global.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  async function request(path, method='GET', body, token) {
    const r = await nativeFetch(`http://127.0.0.1:${server.address().port}/api${path}`, {method,headers:{'Content-Type':'application/json','x-barbeiro-token':token || ''},body:body ? JSON.stringify(body) : undefined});
    return {status:r.status,body:await r.json()};
  }
  const signup = {barbeariaNome:'Trial A',responsavelNome:'Pessoa',telefone:'11999998888',email:'trial@example.test',senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Corte',preco:30}]};
  const created = await request('/publico/assinaturas','POST',{...signup,trial_ends_at:'2099-01-01',trial_status:'converted'});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.assinatura.id;
  const stored=()=>db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[id]);
  const first=await stored();
  assert.equal(+new Date(first.trial_ends_at)-Date.parse(first.trial_started_at),TRIAL_MS);
  assert.equal(created.body.assinatura.acesso.status,'trial_active');
  const countBefore=await db.getAsync('SELECT count(*) AS total FROM assinaturas');
  const repeated=await request('/publico/assinaturas','POST',{...signup,barbeariaNome:'Outra tentativa',email:'TRIAL@example.test',telefone:'+55 (11) 99999-8888'});
  assert.equal(repeated.status,409);
  assert.deepEqual(await db.getAsync('SELECT count(*) AS total FROM assinaturas'),countBefore);
  const login=()=>request('/barbeiro/login','POST',{identificador:signup.email,senha:signup.senha});
  let session=await login(); assert.equal(session.status,200); let token=session.body.token;
  assert.equal((await request('/studiofy/painel','GET',null,token)).status,200);
  await request('/barbeiro/logout','POST',{},token);
  assert.equal((await request('/barbeiro/me','GET',null,token)).status,401);
  session=await login();token=session.body.token;
  assert.equal((await stored()).trial_started_at,first.trial_started_at);
  const b=await request('/publico/assinaturas','POST',{...signup,barbeariaNome:'Trial B',telefone:'11999997777',email:'b@example.test'});
  const bid=b.body.assinatura.id;
  const beforeB=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[bid]);
  assert.equal((await request(`/publico/assinaturas/${bid}`,'PATCH',{trial_ends_at:'2099-01-01'},token)).status,403);
  assert.deepEqual(await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[bid]),beforeB);
  await request(`/publico/assinaturas/${id}`,'PATCH',{trial_ends_at:'2099-01-01',trial_started_at:'2098-12-25'},token);
  assert.equal(+(await stored()).trial_ends_at,+first.trial_ends_at);
  await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01T00:00:00.000Z', trial_ends_at='2000-01-08T00:00:00.000Z' WHERE id=$1",[id]);
  await db.runAsync("INSERT INTO agendamentos (assinatura_id,nome_cliente) VALUES ($1,'Cliente preservado')",[id]);
  const bookings=await db.allAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1',[id]);
  const services=await db.allAsync('SELECT * FROM servicos_assinatura WHERE assinatura_id=$1',[id]);
  const expired=await request('/barbeiro/me','GET',null,token);
  assert.equal(expired.status,200);assert.equal(expired.body.acesso.status,'trial_expired');
  const puppeteer=require('puppeteer'),fs=require('node:fs');
  const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
  await t.test('JavaScript, localStorage e relogio adulterados nao autorizam operacoes reais',{skip:!executablePath},async()=>{
    const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
    try {
      const page=await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/login.html`);
      const result=await page.evaluate(async({token,id})=>{
        localStorage.setItem('barbearia_auth_token',token);
        localStorage.setItem('trial_ends_at','2099-01-01');
        localStorage.setItem('trial_status','active');
        const OriginalDate=Date;
        window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['1999-12-31T00:00:00Z']));}static now(){return OriginalDate.parse('1999-12-31T00:00:00Z');}};
        // Modified client code can invent UI state and request bodies, never server entitlement.
        window.account={acesso:{liberado:true,status:'trial_active'}};
        const headers={'x-barbeiro-token':token,'Content-Type':'application/json'};
        const edit=await fetch('/api/publico/assinaturas/'+id,{method:'PATCH',headers,body:JSON.stringify({trial_status:'active',trial_ends_at:'2099-01-01',trial_started_at:'2098-12-25'})});
        const operation=await fetch('/api/studiofy/agendamentos',{method:'POST',headers,body:JSON.stringify({trial_ends_at:'2099-01-01'})});
        const me=await fetch('/api/barbeiro/me',{headers});
        return {edit:edit.status,operation:operation.status,me:me.status,state:(await me.json()).acesso.status,clock:Date.now()};
      },{token,id});
      assert.deepEqual(result,{edit:403,operation:403,me:200,state:'trial_expired',clock:Date.parse('1999-12-31T00:00:00Z')});
      const saved=await stored();assert.equal(+saved.trial_ends_at,Date.parse('2000-01-08T00:00:00.000Z'));
    } finally { await browser.close(); }
  });
  for(const [path,method,body] of [['/studiofy/painel','GET'],['/studiofy/agendamentos','POST',{}],['/agendamentos','POST',{}],['/faturamento','GET']]) {
    assert.equal((await request(path,method,body,token)).status,403,path);
  }
  assert.equal((await login()).status,200);
  assert.equal((await request('/publico/assinatura-config')).status,200);
  assert.equal((await request(`/publico/assinaturas/${id}/status`)).body.acesso.status,'trial_expired');
  assert.equal((await request(`/publico/assinaturas/${id}/checkout`,'POST',{},token)).status,200);
  assert.deepEqual(await db.allAsync('SELECT * FROM servicos_assinatura WHERE assinatura_id=$1',[id]),services);
  assert.deepEqual(await db.allAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1',[id]),bookings);
  await db.runAsync('UPDATE assinaturas SET trial_status=NULL,trial_started_at=NULL,trial_ends_at=NULL WHERE id=$1',[id]);
  assert.equal((await login()).body.assinatura.acesso.status,'payment_required');
  assert.equal((await stored()).trial_status,null);
  await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1",[id]);
  assert.equal((await login()).body.assinatura.acesso.status,'subscription_active');
  assert.equal((await request('/studiofy/painel','GET',null,token)).status,200);
  assert.equal((await stored()).trial_status,null);
});
