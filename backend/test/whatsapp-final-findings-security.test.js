const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { publicWhatsappError, safeWhatsappException, logWhatsappFailure } = require('../whatsappError');
const markers = ['FAKE_QR_SECRET_MARKER', 'FAKE_PAIRING_SECRET_MARKER', 'FAKE_API_KEY_MARKER', 'FAKE_WEBHOOK_SECRET_MARKER', 'FAKE_TOKEN_MARKER'];
const privateText = markers.join(' ');
function assertClean(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of markers) assert.ok(!serialized.includes(marker), 'Private material must not escape.');
}

test('normal HTTP boundary projects every artificial exception field by allowlist', async t => {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes.js'), 'utf8');
  const start = source.indexOf('function responderErroWhatsapp(');
  const boundary = source.slice(start).match(/^[\s\S]*?\r?\n}/)[0];
  const context = { publicWhatsappError };
  vm.runInNewContext(boundary, context);
  for (const field of ['message','diagnostic','error','cause','stack','response','headers','body','nested','toJSON']) {
    await t.test(field, () => {
      const error = Object.assign(new Error(privateText), { statusCode: 502, code: 'WHATSAPP_FAKE_TOKEN_MARKER', [field]: field === 'toJSON' ? () => ({ token: privateText }) : { deep: { qr: privateText } } });
      const output = { headers: {} };
      const res = { status(code) { output.httpStatus=code; return this; }, set(name,value) { output.headers[name]=value; return this; }, json(body) { output.body=body; return this; } };
      context.error=error; context.res=res;
      vm.runInNewContext('responderErroWhatsapp(res, error)', context);
      assert.equal(output.httpStatus,502);
      assert.equal(output.body.errorCode,'WHATSAPP_INTERNAL_ERROR');
      assert.deepEqual(Object.keys(output.body).sort(), ['success','status','connected','conectado','error','message','errorCode'].sort());
      assertClean(output);
      assertClean(util.inspect(safeWhatsappException(error), { depth: 10 }));
    });
  }
  await t.test('untrusted retry metadata is not copied to headers or JSON', () => {
    const error = { code:'EVOLUTION_RATE_LIMIT',statusCode:429,message:privateText,retryAfterSeconds:privateText,retryAt:privateText,rateLimitSource:privateText,upstreamStatus:privateText };
    const safe=publicWhatsappError(error);
    assert.deepEqual(Object.keys(safe).sort(),['statusCode','code','message'].sort());
    assertClean(safe);
  });
  await t.test('console receives only safe projection, including nested causes', () => {
    const logs=[]; t.mock.method(console,'error',(...args)=>logs.push(util.format(...args)));
    const poisoned = Object.assign(new Error(privateText), { code: 'WHATSAPP_FAKE_TOKEN_MARKER', cause: new Error(privateText), response: { headers: privateText }, diagnostic: { qr: privateText } });
    logWhatsappFailure(poisoned);
    require('../evolutionApi').logEvolutionError('artificial error', poisoned);
    assert.ok(logs.length>0);assertClean(logs.join('\n'));
  });
});

test('legacy bridge generic routes fail closed and private binding remains immutable', async t => {
  const routes=new Map(),contexts=[],configs=[],output=[];
  const app={use(){},get(name,handler){routes.set('GET '+name,handler);},post(name,handler){routes.set('POST '+name,handler);},listen(port,host){assert.equal(host,'127.0.0.1');}};
  const express=()=>app;express.json=()=>()=>{};
  const context={require(name){
    if(name==='express')return express;
    if(name==='./loadEnv')return {};
    if(name==='./evolutionApi')return {logEvolutionError:logWhatsappFailure};
    if(name==='./botFlow')return {attachBotHandlers(client,options){contexts.push({...options});}};
    if(name==='./whatsappBrowser')return {criarOpcoesWppconnect:options=>({...options,logQR:false})};
    if(name==='@wppconnect-team/wppconnect')return {async create(options){configs.push(options);options.catchQR('data:image/png;base64,U1lOVEhFVElD',privateText);options.statusFind(privateText);return {};}};
    throw Error('Unexpected dependency');
  },console:{log(...args){output.push(util.format(...args));},error(...args){output.push(util.format(...args));}},process:{env:{}},Buffer,URL,Map,Set,Number,Date,Promise};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../wppconnect.js'),'utf8'),context);
  const trusted={apiBaseUrl:'https://trusted.example.invalid',barberToken:'FAKE_TOKEN_MARKER'};
  context.trusted=trusted;
  await t.test('legitimate private caller retains backend-defined tenant and context',async()=>{
    await vm.runInNewContext("iniciarSessao('806', trusted)",context);
    assert.equal(contexts.length,1);assert.equal(contexts[0].assinaturaId,806);assert.equal(contexts[0].apiBaseUrl,trusted.apiBaseUrl);assert.equal(configs[0].session,'assinatura-806');assert.equal(configs[0].logQR,false);assertClean(output.join('\n'));
  });
  async function denied(id,body){let status,data;await routes.get('POST /sessions/:assinaturaId/start')({params:{assinaturaId:id},body},{status(code){status=code;return this;},json(value){data=value;}});assert.equal(status,403);assertClean(data);assert.equal(contexts.length,1);}
  await t.test('anonymous cannot select existing session',()=>denied('806',{}));
  await t.test('manipulated sessionName is blocked',()=>denied('806',{...trusted,sessionName:'assinatura-906'}));
  await t.test('anonymous cannot reuse owner credential or redirect bot',()=>denied('806',{apiBaseUrl:'https://foreign.example.invalid'}));
  await t.test('another context cannot assume selected tenant',()=>denied('906',{...trusted}));
  await t.test('private callers cannot inherit partial credentials or replace binding',async()=>{
    for(const binding of [{apiBaseUrl:trusted.apiBaseUrl},{...trusted,apiBaseUrl:'https://foreign.example.invalid'},{...trusted,sessionName:'arbitrary'},{...trusted,barberToken:'another-token'}]){
      context.binding=binding;await assert.rejects(vm.runInNewContext("iniciarSessao('806', binding)",context));
    }
    assert.equal(contexts.length,1);
    assert.equal(vm.runInNewContext("obterSessao('806').apiBaseUrl",context),trusted.apiBaseUrl);
  });
  await t.test('generic status denies access and exposes no QR',async()=>{
    let status,data;routes.get('GET /sessions/:assinaturaId/status')({params:{assinaturaId:'806'}},{status(code){status=code;return this;},json(value){data=value;}});
    assert.equal(status,403);assert.equal(data.qrCode,undefined);assertClean(data);assertClean(output.join('\n'));
  });
});

test('whatsappManager clears pairing state on synchronous and asynchronous SDK failures', async t => {
  const source=fs.readFileSync(path.resolve(__dirname,'../whatsappManager.js'),'utf8');
  const localScope=require('../services/executionScope').createExecutionScope({certifiable:true});
  let mode='async',creates=0; const attached=[];
  const sdk={create(options){
    creates++;
    options.catchQR('data:image/png;base64,'+Buffer.from(privateText).toString('base64'));
    options.statusFind(privateText);
    const error=Object.assign(new Error(privateText), { diagnostic:{ qr:privateText }, cause:new Error(privateText), response:{ headers:privateText,body:privateText }, stack:privateText });
    if(mode==='sync')throw error;
    if(mode==='async')return Promise.reject(error);
    return Promise.resolve({onMessage(){}});
  }};
  const context={require(name){
    if(name==='./whatsappError')return {safeWhatsappException};
    if(name==='./botFlow')return {attachBotHandlers(client,options){attached.push(options);}};
    if(name==='./whatsappBrowser')return {criarOpcoesWppconnect:options=>({...options,logQR:false})};
    if(name==='./services/executionScope')return {executionScope:localScope};
    if(name==='@wppconnect-team/wppconnect')return sdk;
    throw Error('Unexpected dependency');
  },module:{exports:{}},Map,Date,Promise};
  vm.runInNewContext(source,context);
  const manager=context.module.exports;
  for(const fault of ['async','sync'])await t.test(fault,async()=>{
    mode=fault;
    await assert.rejects(manager.reiniciarSessao(806),error=>{assertClean(util.inspect(error,{depth:10}));return error.code==='WHATSAPP_LOCAL_START_FAILED';});
    const state=manager.statusSessao(806);
    assert.equal(state.qrCode,null);assert.equal(state.ultimoErro,'WHATSAPP_LOCAL_START_FAILED');assert.equal(state.status,'erro');assertClean(state);
  });
  await t.test('legitimate private local flow still connects without real SDK or messages',async()=>{
    mode='success';await manager.reiniciarSessao(806);
    assert.equal(manager.statusSessao(806).status,'conectado');assert.equal(manager.statusSessao(806).qrCode,null);assert.equal(attached[0].assinaturaId,806);assertClean(manager.statusSessao(806));
  });
  await t.test('legacy SDK blocks certification and cannot start after drain',async()=>{
    assert.ok(localScope.snapshot().certificationBlocked.includes('LEGACY_PROVIDER_OUTSIDE_CERTIFIED_PROFILE'));
    localScope.beginDrain();const before=creates;
    await assert.rejects(manager.reiniciarSessao(807),{code:'WHATSAPP_LOCAL_START_FAILED'});
    assert.equal(creates,before);await localScope.drain();assert.throws(localScope.sealClosedScope);
  });
});
