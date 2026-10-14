const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const util = require('node:util');
const markers=['FAKE_QR_SECRET_MARKER','FAKE_PAIRING_SECRET_MARKER','FAKE_API_KEY_MARKER','FAKE_WEBHOOK_SECRET_MARKER','FAKE_TOKEN_MARKER'];
const privateText=markers.join(' ');
function clean(value){const text=(typeof value==='string'?value:JSON.stringify(value)).toLowerCase();for(const marker of markers)assert.ok(!text.includes(marker.toLowerCase()),'Provider state escaped.');}

test('Evolution provider states are closed, typed and safe in HTTP and storage', async t => {
  const env=require('./helpers/postgres').testEnvironment();
  process.env.NODE_ENV='test';process.env.RENDER='true';process.env.EVOLUTION_API_URL='https://state-regression.invalid';process.env.EVOLUTION_API_KEY='local-state-test-key';
  const db=require('../database');let server,base,current;
  const clock=Date.now;let offset=0;t.mock.method(Date,'now',()=>clock()+offset);
  const native=global.fetch;const logs=[];
  try{
    await db.ready;
    const salt='provider-state-test',hash=crypto.scryptSync('local-test-password',salt,64).toString('hex');
    await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,email,metodo_pagamento,dia_vencimento,suporte_numero,status,senha_hash,senha_salt,proximo_vencimento,whatsapp_session) VALUES(806,'State test','State test','11999990000','state-policy@example.test','mercado_pago',5,'','ativo',$1,$2,'2099-01-01','barbearia-806')",[hash,salt]);
    const app=express();app.use(express.json());app.use('/api',require('../routes'));server=await new Promise(done=>{const s=app.listen(0,'127.0.0.1',()=>done(s));});base='http://127.0.0.1:'+server.address().port;
    const login=await native(base+'/api/barbeiro/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identificador:'state-policy@example.test',senha:'local-test-password'})});const token=(await login.json()).token;assert.ok(token);
    for(const level of ['log','info','warn','error','debug'])t.mock.method(console,level,(...args)=>logs.push(util.format(...args)));
    t.mock.method(global,'fetch',async(input,options)=>{const url=new URL(String(input));if(url.origin===base)return native(input,options);assert.equal(url.origin,'https://state-regression.invalid');assert.equal(url.pathname,'/instance/connectionState/barbearia-806');return Response.json({instance:{state:current}});});
    const api=require('../evolutionApi');
    const valid=[['open','conectado'],['connected','conectado'],['connecting','iniciando'],['pairing','iniciando'],['syncing','iniciando'],['close','nao_configurado'],['closed','nao_configurado'],['disconnected','nao_configurado'],['logout','nao_configurado'],['OpEn','conectado'],[' CONNECTING ','iniciando']];
    const invalid=[['QR string',markers[0]],['pairing marker',markers[1]],['API key marker',markers[2]],['all sensitive markers',privateText],['HTML/script','<script>'+privateText+'</script>'],['huge string','x'.repeat(100000)+privateText],['object',{state:'open',private:privateText}],['array that could coerce to a valid state',['open']],['marker array',[privateText]],['null',null],['undefined',undefined],['empty string',''],['number',123],['boolean',true]];
    const cases=[...valid.map(([input,status])=>({name:'known '+input,input,status,known:true})),...invalid.map(([name,input])=>({name,input,status:'nao_configurado',known:false}))];
    for(const item of cases)await t.test(item.name,async()=>{
      current=item.input;logs.length=0;
      api.receberEventoConexao('barbearia-806','CONNECTION_UPDATE',{state:'close'});offset+=11001;
      if(item.status==='iniciando')api.receberEventoConexao('barbearia-806','QRCODE_UPDATED',{code:'SYNTHETIC_LOCAL_STATE_TEST'});
      const response=await native(base+'/api/publico/assinaturas/806/whatsapp/qr',{headers:{'x-barbeiro-token':token}}),body=await response.json();
      assert.equal(response.status,200);assert.equal(body.status,item.status==='iniciando'?'pairing':item.status);
      const stored=await db.getAsync('SELECT whatsapp_status,whatsapp_ultimo_erro FROM assinaturas WHERE id=806');assert.equal(stored.whatsapp_status,item.status);
      clean(body);clean(stored);clean(logs.join('\n'));assert.equal(body.diagnostic,undefined);
      const source=api.extrairEstadoInstancia({instance:{state:item.input}});assert.equal(source,item.known?item.input.trim().toLowerCase():null);
    });
    await t.test('coercion hooks on an invalid object are never invoked',()=>{
      assert.equal(api.extrairEstadoInstancia({instance:{state:{toString(){throw new Error(privateText);}}}}),null);
    });
  }finally{if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await db.close();await env.cleanup();}
});
