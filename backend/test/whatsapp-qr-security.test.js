const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const api = require('../evolutionApi');

const raw = 'synthetic-qr-session,synthetic-public-key,synthetic-pairing-token';
function decode(image) {
  assert.match(image, /^data:image\/png;base64,/);
  const png = PNG.sync.read(Buffer.from(image.split(',')[1], 'base64'));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(result, 'Generated PNG must be a readable QR');
  return result.data;
}

test('QR local: readable fallback, all payload variants, no external generation', async t => {
  const requests = [];
  t.mock.method(global, 'fetch', async (...args) => { requests.push(args); throw Error('No network allowed'); });
  await t.test('raw content round-trips through an independent decoder without network or raw text in PNG', () => {
    const image = api.construirQrCodeUrl(raw);
    assert.equal(decode(image), raw);
    assert.equal(requests.length, 0);
    assert.ok(!image.includes(raw) && !image.includes(encodeURIComponent(raw)));
    assert.ok(!Buffer.from(image.split(',')[1], 'base64').includes(Buffer.from(raw)));
  });
  await t.test('embedded and unprefixed provider PNG remain local and readable', () => {
    const image = api.construirQrCodeUrl(raw);
    assert.equal(api.construirQrCodeUrl(image), image);
    assert.equal(api.construirQrCodeUrl(image.split(',')[1]), image);
    assert.equal(decode(api.construirQrCodeUrl(image.split(',')[1])), raw);
  });
  await t.test('external URLs, non-image data URLs, oversized and invalid values are rejected silently', () => {
    for (const value of ['https://api.qrserver.com/?data='+encodeURIComponent(raw), 'https://other.example.test/'+raw,
      '//other.example.test/'+raw, 'data:text/html;base64,c2VjcmV0', 'data:image/svg+xml;base64,c2VjcmV0',
      'x'.repeat(2001), '', null, {}]) assert.equal(api.construirQrCodeUrl(value), null);
    assert.equal(requests.length, 0);
  });
  const variants = [
    { code: raw }, { qrcode: raw }, { qrcode: { code: raw } }, { qr: raw }, { base64: raw },
    { qrcode: { base64: raw } }, { data: { code: raw } }, { data: { base64: raw } },
    { data: { qrcode: raw } }, { data: { qrcode: { code: raw } } }, { data: { qrcode: { base64: raw } } },
    { response: { code: raw } }, { response: { base64: raw } }, { response: { qrcode: raw } },
    { response: { qrcode: { code: raw } } }, { response: { qrcode: { base64: raw } } }, { response: { qr: raw } },
  ];
  for (const [index, payload] of variants.entries()) {
    await t.test(`provider variant ${index+1} generates a local readable image`, () => {
      assert.equal(decode(api.construirQrCodeUrl(api.extrairConteudoQr(payload))), raw);
      assert.equal(requests.length, 0);
    });
  }
  await t.test('alternative entrypoint shares the safe local encoder', () => {
    const alternative = require('../src/services/evolutionApiService');
    assert.equal(decode(alternative.normalizeQrCode(raw)), raw);
  });
});

test('QR security: real authenticated tenant routes and sanitized logs, simulated provider only', async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_API_URL = 'https://qr-security-provider.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-provider-private-key';
  process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-webhook-private-secret';
  process.env.PUBLIC_APP_URL = 'https://example.test';
  const logs = [], calls = [], states = new Map();
  t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const nativeFetch = global.fetch;
  let base, providerFailure = false;
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    if (base && String(url).startsWith(base+'/')) return nativeFetch(url, options);
    const target = new URL(url);
    assert.equal(target.origin, 'https://qr-security-provider.test', 'QR must never go to an external generator');
    assert.ok(!String(url).includes(raw) && !String(url).includes(encodeURIComponent(raw)));
    calls.push({ path: target.pathname, method: options.method });
    if (providerFailure) return Response.json({ code: raw, pairingCode: 'SAFE1234', apikey: process.env.EVOLUTION_API_KEY,
      secret: process.env.EVOLUTION_WEBHOOK_SECRET, message: raw }, { status: 500 });
    const name = target.pathname.split('/').pop();
    if (target.pathname === '/instance/create') { states.set(JSON.parse(options.body).instanceName,'close'); return Response.json({ instance: { instanceName: JSON.parse(options.body).instanceName } }); }
    if (target.pathname.startsWith('/webhook/')) return Response.json({ success: true });
    if (!states.has(name)) return Response.json({ message: `Instance "${name}" not found` }, { status: 404 });
    if (target.pathname.startsWith('/instance/connectionState/')) return Response.json({ instance: { state: states.get(name) } });
    if (target.pathname.startsWith('/instance/connect/')) {
      states.set(name,'connecting');
      return Response.json({ ...(target.searchParams.has('number') ? { pairingCode:'SAFE1234' } : { qrcode: { code: raw+'-'+name } }), token: 'synthetic-response-private-token',
        apikey: process.env.EVOLUTION_API_KEY, headers: { 'x-webhook-secret': process.env.EVOLUTION_WEBHOOK_SECRET } });
    }
    throw Error('Unexpected provider endpoint');
  });
  const db = require('../database');
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await db.close(); await environment.cleanup(); });
  await db.ready;
  const salt = 'qr-safe-test-salt', hash = crypto.scryptSync('test-password',salt,64).toString('hex');
  const accounts = [];
  async function request(route, token, method='GET', body) {
    const response = await nativeFetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return { status:response.status, cache:response.headers.get('cache-control'), body:await response.json() };
  }
  for (const id of [106,107]) {
    await db.runAsync(`INSERT INTO assinaturas (id,barbearia_nome,responsavel_nome,telefone,email,metodo_pagamento,dia_vencimento,suporte_numero,status,senha_hash,senha_salt,proximo_vencimento)
      VALUES ($1,'QR test','Test','11999990000',$2,'mercado_pago',5,'','ativo',$3,$4,'2099-01-01')`,[id,`qr-${id}@example.test`,hash,salt]);
    const login = await request('/barbeiro/login',null,'POST',{identificador:`qr-${id}@example.test`,senha:'test-password'});
    assert.equal(login.status,200); accounts.push({id,token:login.body.token});
  }
  const [owner,other] = accounts;
  const route = `/publico/assinaturas/${owner.id}/whatsapp`;
  let image;
  await t.test('authorized owner receives a readable local fallback without provider secrets', async () => {
    const response = await request(route+'/iniciar',owner.token,'POST',{});
    assert.equal(response.status,200); image=response.body.qrCode;
    assert.equal(decode(image),raw+'-barbearia-'+owner.id);
    const json=JSON.stringify(response.body);
    for(const secret of [process.env.EVOLUTION_API_KEY,process.env.EVOLUTION_WEBHOOK_SECRET,'synthetic-response-private-token',raw])assert.ok(!json.includes(secret));
    assert.ok(!json.includes('https://api.qrserver'));
  });
  await t.test('other account and anonymous callers cannot obtain owner QR through any retrieval path', async () => {
    const before=calls.length;
    for(const suffix of ['/status','/qr'])for(const token of [other.token,null]){
      const response=await request(route+suffix,token);
      assert.equal(response.status,token?403:401);
      assert.ok(!JSON.stringify(response.body).includes(image));
      assert.ok(!JSON.stringify(response.body).includes('SAFE1234'));
    }
    for(const suffix of ['/iniciar','/recuperar','/pairing-code']){
      const response=await request(route+suffix,other.token,'POST',{phone:'5511999990000'});
      assert.equal(response.status,403);
    }
    const alias=await request('/whatsapp/qr',other.token);
    assert.equal(alias.status,200);assert.ok(!JSON.stringify(alias.body).includes(image));
    assert.equal(calls.length,before,'Denied access must not call the provider');
  });
  await t.test('owner retrieval is no-store and only contains that tenant code', async () => {
    for(const target of [route+'/status',route+'/qr','/whatsapp/qr']){
      const response=await request(target,owner.token);assert.equal(response.status,200);
      assert.equal(response.cache,'no-store');assert.equal(response.body.qrCode||response.body.qr,image);
    }
  });
  await t.test('invalid sessions cannot retrieve, start or recover QR, including the alias', async () => {
    const before = calls.length;
    for (const target of [route+'/status', route+'/qr', '/whatsapp/qr']) {
      const response = await request(target, 'invalid-session-token');
      assert.equal(response.status, 401);
      assert.ok(!JSON.stringify(response.body).includes(image));
    }
    for (const suffix of ['/iniciar', '/recuperar', '/pairing-code']) {
      const response = await request(route+suffix, 'invalid-session-token', 'POST', { phone: '5511999990000' });
      assert.equal(response.status, 401);
    }
    assert.equal(calls.length, before);
  });
  await t.test('frontend instanceName and account parameters cannot select another tenant QR', async () => {
    const before = calls.length;
    const foreign = 'barbearia-'+owner.id;
    for (const target of [`/publico/assinaturas/${other.id}/whatsapp/qr?instanceName=${foreign}&id=${owner.id}`,
      `/whatsapp/qr?instanceName=${foreign}&assinaturaId=${owner.id}`]) {
      const response = await request(target, other.token);
      assert.equal(response.status, 200);
      assert.ok(!JSON.stringify(response.body).includes(image));
    }
    const response = await request(`/publico/assinaturas/${other.id}/whatsapp/iniciar`, other.token, 'POST',
      { instanceName: foreign, instancia: foreign, assinaturaId: owner.id });
    assert.equal(response.status, 200);
    assert.equal(decode(response.body.qrCode), raw+'-barbearia-'+other.id);
    assert.ok(calls.slice(before).every(call => !call.path.endsWith('/'+foreign)));
    api.invalidarExistenciaInstancia('barbearia-'+other.id);
    states.set('barbearia-'+other.id, 'close');
  });
  await t.test('QR, pairing, image, API key and webhook secret never appear in logs or database', async () => {
    const pairing=await request(`/publico/assinaturas/${other.id}/whatsapp/pairing-code`,other.token,'POST',{phone:'5511999990000'});
    assert.equal(pairing.status,200);assert.equal(pairing.body.pairingCode,'SAFE1234');
    for(const secret of [raw,process.env.EVOLUTION_API_KEY,process.env.EVOLUTION_WEBHOOK_SECRET,'synthetic-response-private-token'])assert.ok(!JSON.stringify(pairing.body).includes(secret));
    const output=logs.join('\n');
    for(const secret of [raw,'SAFE1234',image,process.env.EVOLUTION_API_KEY,process.env.EVOLUTION_WEBHOOK_SECRET,'synthetic-response-private-token'])assert.ok(!output.includes(secret),'Sensitive data must be redacted');
    const row=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[owner.id]);
    for(const secret of [raw,'SAFE1234',image])assert.ok(!JSON.stringify(row).includes(secret));
  });
  await t.test('pairing image cache expires and is discarded on confirmed open', child => {
    const realNow=Date.now;
    child.mock.method(Date,'now',()=>realNow()+61000);
    assert.equal(api.obterCodigoConexao('barbearia-'+owner.id),null);
    child.mock.restoreAll();
    api.receberEventoConexao('qr-security-cache','QRCODE_UPDATED',{code:raw,pairingCode:'SAFE1234'});
    assert.ok(api.obterCodigoConexao('qr-security-cache'));
    api.receberEventoConexao('qr-security-cache','CONNECTION_UPDATE',{state:'open'});
    assert.equal(api.obterCodigoConexao('qr-security-cache'),null);
  });
  await t.test('provider errors do not disclose pairing material or credentials in responses or logs', async () => {
    providerFailure = true;
    api.invalidarExistenciaInstancia('barbearia-'+owner.id);
    try {
      const response = await request(route+'/status', owner.token);
      assert.ok(response.status >= 500);
      const output = JSON.stringify(response.body)+'\n'+logs.join('\n');
      for (const secret of [raw, 'SAFE1234', process.env.EVOLUTION_API_KEY, process.env.EVOLUTION_WEBHOOK_SECRET]) {
        assert.ok(!output.includes(secret), 'Provider failures must not disclose secrets');
      }
    } finally { providerFailure = false; }
  });
  await t.test('expired sessions cannot retrieve, start or recover QR and never call the provider', async child => {
    const realNow = Date.now;
    child.mock.method(Date, 'now', () => realNow()+8*24*60*60*1000);
    const before = calls.length;
    for (const target of [route+'/status', route+'/qr', '/whatsapp/qr']) {
      const response = await request(target, owner.token);
      assert.equal(response.status, 401);
      assert.ok(!JSON.stringify(response.body).includes(image));
    }
    for (const suffix of ['/iniciar', '/recuperar', '/pairing-code']) {
      assert.equal((await request(route+suffix, owner.token, 'POST', { phone: '5511999990000' })).status, 401);
    }
    assert.equal(calls.length, before);
  });
});

test('QR security: both browser interfaces reject remote QR sources and display local PNG', async t => {
  const puppeteer=require('puppeteer');
  const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
  assert.ok(executablePath,'Chrome required');
  let value,attempt=false;
  const app=express();app.use(express.json());
  app.get('/api/publico/assinatura-config',(_,res)=>res.json({whatsappEnabled:true}));
  app.get('/api/barbeiro/me',(_,res)=>res.json({id:106,status:'ativo',servicos:[]}));
  app.get('/api/faturamento',(_,res)=>res.json({total:0}));
  app.get(['/api/agendamentos','/api/bloqueios'],(_,res)=>res.json([]));
  const payload=()=>({success:true,connected:false,status:attempt?'pairing':'disconnected',connectionAttemptActive:attempt,...(attempt?{qrCode:value}:{})});
  app.get('/api/publico/assinaturas/106/whatsapp/status',(_,res)=>res.json(payload()));
  app.post('/api/publico/assinaturas/106/whatsapp/iniciar',(_,res)=>{attempt=true;res.json(payload());});
  app.get('/qr-security-studiofy',(_,res)=>res.send('<!doctype html><div id="view"></div><script src="/studiofy-whatsapp.js"></script>'));
  app.use(express.static(path.resolve(__dirname,'../public')));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(const mode of ['studiofy','barbeiro']){
    await t.test(`${mode}: external generator never receives a request, including initial connect and status`,async()=>{
      const page=await browser.newPage(),requests=[];
      page.on('request',r=>requests.push(r.url()));
      await page.setRequestInterception(true);
      page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base+'/'))void r.abort();else void r.continue();});
      await page.evaluateOnNewDocument(()=>localStorage.setItem('barbearia_auth_token','synthetic-login-token'));
      async function open(qr){value=qr;attempt=false;await page.goto(base+(mode==='studiofy'?'/qr-security-studiofy':'/barbeiro.html'));
        if(mode==='studiofy')await page.evaluate(()=>StudiofyWhatsapp.mount(document.getElementById('view'),'synthetic-login-token',106,()=>{}));
        await page.waitForFunction(mode==='studiofy'?()=>!document.querySelector('#whatsappConnect').disabled:()=>!document.querySelector('#generateQrButton').disabled);
      }
      const remote='https://api.qrserver.com/v1/create-qr-code/?data='+encodeURIComponent(raw);
      await open(remote);
      await page.click(mode==='studiofy'?'#whatsappConnect':'#generateQrButton');
      await page.waitForFunction(mode==='studiofy'?()=>!document.querySelector('#whatsappRefresh').disabled:()=>!whatsappRequestInFlight);
      if(mode==='barbeiro')await page.evaluate(async()=>{whatsappStatusPaused=false;await consultarStatusWhatsapp();});
      const selector=mode==='studiofy'?'#whatsappQr':'#qrCodeImage';
      assert.equal(await page.$eval(selector,e=>e.getAttribute('src')),null);
      assert.equal(requests.filter(url=>url.startsWith('https://api.qrserver')).length,0);
      assert.ok(requests.every(url=>!url.includes(raw)&&!url.includes(encodeURIComponent(raw))));
      await open(api.construirQrCodeUrl(raw));
      await page.click(mode==='studiofy'?'#whatsappConnect':'#generateQrButton');
      await page.waitForFunction(sel=>{const e=document.querySelector(sel);return !e.hidden&&e.naturalWidth>0;},{},selector);
      assert.match(await page.$eval(selector,e=>e.getAttribute('src')),/^data:image\/png;base64,/);
      await page.close();
    });
  }
});

test('alternative entrypoint never returns a stored external QR URL', async t => {
  const repository=require('../src/repositories/whatsappSessionRepository');
  const transport=require('../src/services/evolutionApiService');
  const service=require('../src/services/whatsappService');
  const writes=[];
  let saved={salon_id:106,instance_name:'qr-alternative-safe',status:'DISCONNECTED',qr_code:'https://api.qrserver.com/?data='+encodeURIComponent(raw)};
  t.mock.method(repository,'findBySalonId',async id=>{assert.equal(id,106);return saved;});
  t.mock.method(repository,'upsertStatus',async (id,payload)=>{assert.equal(id,106);writes.push(payload);return {...saved,status:payload.status};});
  t.mock.method(transport,'getConnectionState',async name=>{assert.equal(name,saved.instance_name);return {instance:{state:'close'}};});
  await t.test('previous external image URL is not delivered to the client',async()=>{
    const response=await service.getStatus(106);assert.equal(response.qr_code,null);
    assert.ok(!JSON.stringify(response).includes(raw)&&!JSON.stringify(response).includes('qrserver'));
  });
  await t.test('live local image comes only from temporary cache, never from saved pairing data',async()=>{
    api.receberEventoConexao(saved.instance_name,'QRCODE_UPDATED',{code:raw});
    saved.qr_code='stale-sensitive-pairing-data';
    assert.equal(decode((await service.getStatus(106)).qr_code),raw);
    assert.ok(writes.every(payload=>payload.qrCode===null));
    api.receberEventoConexao(saved.instance_name,'CONNECTION_UPDATE',{state:'open'});
    assert.equal((await service.getStatus(106)).qr_code,null);
  });
  await t.test('start returns a readable local QR without persisting the image or raw code',async()=>{
    t.mock.method(transport,'fetchInstances',async()=>({name:saved.instance_name}));
    t.mock.method(transport,'connectInstance',async name=>{api.receberEventoConexao(name,'QRCODE_UPDATED',{code:raw});return {code:raw};});
    const response=await service.start(106);assert.equal(decode(response.qr_code),raw);
    assert.ok(writes.every(payload=>payload.qrCode===null));
    for(const value of [raw,response.qr_code])assert.ok(!JSON.stringify(writes).includes(value));
  });
  await t.test('session without an instance does not expose an orphan QR',async()=>{
    saved={...saved,instance_name:null};assert.equal((await service.getStatus(106)).qr_code,null);
  });
});
