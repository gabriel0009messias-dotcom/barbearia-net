const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const util = require('node:util');
const markers = ['FAKE_QR_SECRET_MARKER','FAKE_PAIRING_SECRET_MARKER','FAKE_API_KEY_MARKER','FAKE_WEBHOOK_SECRET_MARKER','FAKE_TOKEN_MARKER'];
const privateText = markers.join(' ');
function clean(value) { const text = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase(); for (const marker of markers) assert.ok(!text.includes(marker.toLowerCase()), 'Private exception data escaped.'); }

test('authentication and routing exceptions use one boundary for every URL spelling', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.NODE_ENV='test'; process.env.RENDER='true'; process.env.EVOLUTION_API_URL='';
  const db = require('../database'); let server;
  try {
    await db.ready;
    const salt='url-policy-test',hash=crypto.scryptSync('local-test-password',salt,64).toString('hex');
    await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,email,metodo_pagamento,dia_vencimento,suporte_numero,status,senha_hash,senha_salt,proximo_vencimento) VALUES(806,'URL test','URL test','11999990000','url-policy@example.test','mercado_pago',5,'','ativo',$1,$2,'2099-01-01')",[hash,salt]);
    const app=express();app.use(express.json());app.use('/api',require('../routes'));
    server=await new Promise(done=>{const s=app.listen(0,'127.0.0.1',()=>done(s));});
    const base='http://127.0.0.1:'+server.address().port;
    const login=await fetch(base+'/api/barbeiro/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identificador:'url-policy@example.test',senha:'local-test-password'})});
    const token=(await login.json()).token;assert.ok(token);
    const logs=[];for(const level of ['log','info','warn','error','debug'])t.mock.method(console,level,(...args)=>logs.push(util.format(...args)));
    const originalGet=db.get;let injectedCalls=0;
    t.mock.method(db,'get',function(sql,params,callback){
      if(/^SELECT \* FROM assinaturas WHERE id/.test(sql)){injectedCalls++;return callback(Object.assign(new Error(privateText),{statusCode:503,diagnostic:{private:privateText},cause:new Error(privateText),response:{headers:privateText,body:privateText},stack:privateText}));}
      return originalGet.call(this,sql,params,callback);
    });
    const cases=[];
    for(const segment of ['whatsapp','WhatsApp','WHATSAPP','WhAtSaPp']){
      for(const suffix of ['','/','?instanceName=barbearia-6&instanceName=barbearia-806&extra=1'])cases.push(['/publico/assinaturas/806/'+segment+'/status'+suffix,503,true]);
      cases.push(['/publico/assinaturas/806/'+segment+'/qr',503,true]);
    }
    cases.push(['/publico/assinaturas/%38%30%36/WhAtSaPp/status',503,true]);
    cases.push(['/publico/assinaturas/806/%77hatsapp/status',404,false]);
    cases.push(['/publico/assinaturas/806/whatsapp/status/extra',404,false]);
    cases.push(['/publico/assinaturas/%GG/WhAtSaPp/status',400,false]);
    cases.push(['/publico/assinaturas/%FAKE_TOKEN_MARKER/WhAtSaPp/status',400,false]);
    for(const [route,expected,reachesAuth]of cases)await t.test(route,async()=>{
      logs.length=0;const before=injectedCalls;
      const response=await fetch(base+'/api'+route,{headers:{'x-barbeiro-token':token}});const text=await response.text();
      assert.equal(response.status,expected);clean(text);clean(logs.join('\n'));assert.equal(injectedCalls>before,reachesAuth);
      if(reachesAuth){const payload=JSON.parse(text);assert.equal(payload.errorCode,'WHATSAPP_INTERNAL_ERROR');assert.equal(payload.diagnostic,undefined);assert.equal(payload.stack,undefined);}
    });
    await t.test('an unrelated authenticated handler cannot select a raw exception response',async()=>{
      const response=await fetch(base+'/api/publico/assinaturas/806',{headers:{'x-barbeiro-token':token}});assert.equal(response.status,503);clean(await response.text());
    });
  } finally { if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await db.close();await env.cleanup(); }
});

test('alternative error middleware does not choose a policy from originalUrl or query', async t => {
  const { errorMiddleware }=require('../src/middlewares/errorMiddleware');
  for(const spelling of ['whatsapp','WhatsApp','WHATSAPP','WhAtSaPp','%77hatsapp'])await t.test(spelling,()=>{
    let payload,status;
    const response={status(value){status=value;return this;},json(value){payload=value;}};
    const error=Object.assign(new Error(privateText),{statusCode:400,cause:new Error(privateText)});
    errorMiddleware(error,{originalUrl:'/api/'+spelling+'/start?whatsapp=WHATSAPP',url:'/irrelevant',baseUrl:'/api'},response,()=>{});
    assert.equal(status,400);clean(payload);
  });
});
