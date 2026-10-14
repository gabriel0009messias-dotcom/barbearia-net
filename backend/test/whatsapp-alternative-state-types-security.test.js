const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const util = require('node:util');
const jwt = require('jsonwebtoken');
const markers = ['FAKE_QR_SECRET_MARKER','FAKE_PAIRING_SECRET_MARKER','FAKE_API_KEY_MARKER','FAKE_WEBHOOK_SECRET_MARKER','FAKE_TOKEN_MARKER'];
const privateText = markers.join(' ');
function assertClean(value) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
  for (const marker of markers) assert.ok(!text.includes(marker.toLowerCase()), 'Untrusted state escaped.');
}

test('alternative status/start reject nonprimitive state before response, log and persistence', async t => {
  process.env.NODE_ENV='test';process.env.JWT_SECRET='local-state-type-test-jwt';
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.EVOLUTION_API_KEY='local-state-type-test-key';
  const repository=require('../src/repositories/whatsappSessionRepository');
  const users=require('../src/repositories/saasUserRepository');
  const transport=require('../src/services/evolutionApiService');
  const writes=[],logs=[],calls=[];
  t.mock.method(repository,'findBySalonId',async()=>({salon_id:806,instance_name:'barbearia-806',status:'DISCONNECTED',connected_phone:null}));
  t.mock.method(repository,'upsertStatus',async(id,payload)=>{
    assert.equal(id,806);writes.push({...payload});
    return {salon_id:id,instance_name:payload.instanceName,status:payload.status,qr_code:payload.qrCode,connected_phone:null};
  });
  t.mock.method(users,'findById',async()=>({id:806,salon_id:806,ativo:true}));
  for(const level of ['log','info','warn','error','debug'])t.mock.method(console,level,(...args)=>logs.push(util.format(...args)));
  let base,server,current,connectPayload;
  const native=global.fetch;
  t.mock.method(global,'fetch',async(input,options)=>{
    const url=new URL(String(input));if(url.origin===base)return native(input,options);
    assert.equal(url.origin,new URL(process.env.EVOLUTION_API_URL).origin);
    assert.ok(!/barbearia-1(?:\D|$)/.test(url.pathname));calls.push(url.pathname);
    if(url.pathname==='/instance/fetchInstances')return Response.json([{name:'barbearia-806'}]);
    if(url.pathname==='/instance/connectionState/barbearia-806')return Response.json({instance:{state:current}});
    if(url.pathname==='/instance/connect/barbearia-806')return Response.json(connectPayload || {code:'SYNTHETIC_STATE_TYPE_LOCAL_QR'});
    throw Error('Unexpected simulated provider request');
  });
  try {
    const app=express();app.use(express.json());app.use('/api/whatsapp',require('../src/routes/whatsappRoutes'));
    app.use(require('../src/middlewares/errorMiddleware').errorMiddleware);
    server=await new Promise(done=>{const s=app.listen(0,'127.0.0.1',()=>done(s));});base='http://127.0.0.1:'+server.address().port;
    const token=jwt.sign({sub:'806'},process.env.JWT_SECRET);
    let sequence=0;
    async function request(flow) {
      const response=await native(base+'/api/whatsapp/'+flow,{method:flow==='status'?'GET':'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},...(flow==='start'?{body:'{}'}:{})});
      return {httpStatus:response.status,body:await response.json()};
    }
    const cases=[
      ['valid open','open','CONNECTED'],['array open',['open'],'nao_configurado'],['array close',['close'],'nao_configurado'],['array open/close',['open','close'],'nao_configurado'],
      ['object',{state:'open'},'nao_configurado'],['null',null,'nao_configurado'],['undefined',undefined,'nao_configurado'],['number',123,'nao_configurado'],['boolean',true,'nao_configurado'],
      ['unknown string','unexpected-state','nao_configurado'],['private marker array',[privateText],'nao_configurado'],['private marker object',{private:privateText},'nao_configurado'],
      ['case normalization','Open','CONNECTED'],['approved trim',' OPEN ','CONNECTED'],['oversized string','open'+' '.repeat(100000)+privateText,'nao_configurado'],['boxed string',new String('open'),'nao_configurado']
    ];
    // A boxed string cannot be represented as an object by JSON.stringify; inject this additional case at the adapter boundary.
    for(const [label,input,expected]of cases)for(const flow of ['status','start'])await t.test(label+' / '+flow,async sub=>{
      current=input;connectPayload=null;writes.length=0;logs.length=0;calls.length=0;
      process.env.EVOLUTION_API_URL='https://state-type-'+(++sequence)+'.invalid';
      if(input instanceof String)sub.mock.method(transport,'getConnectionState',async()=>({instance:{state:input}}));
      const result=await request(flow);
      assert.equal(result.httpStatus,200);assert.equal(result.body.status,expected);assert.equal(result.body.qr_code,null);
      assert.equal(writes.length,1);assert.equal(writes[0].status,expected);assert.equal(writes[0].qrCode,null);
      assert.ok(!calls.some(p=>p.startsWith('/instance/connect/')),'Invalid state cannot initiate pairing.');
      assertClean(result);assertClean(writes);assertClean(logs.join('\n'));
    });
    for(const flow of ['status','start'])await t.test('coercion hooks never run / '+flow,async sub=>{
      let coercions=0;
      const state={toString(){coercions++;throw Error(privateText);},valueOf(){coercions++;throw Error(privateText);}};
      sub.mock.method(transport,'getConnectionState',async()=>({instance:{state}}));
      writes.length=0;logs.length=0;calls.length=0;process.env.EVOLUTION_API_URL='https://state-type-'+(++sequence)+'.invalid';
      const result=await request(flow);assert.equal(result.httpStatus,200);assert.equal(result.body.status,'nao_configurado');assert.equal(writes[0].status,'nao_configurado');assert.equal(coercions,0);assertClean([result,writes,logs]);
    });
    await t.test('valid disconnected start keeps the approved code-only QR response',async()=>{
      current='close';connectPayload={code:'SYNTHETIC_STATE_TYPE_LOCAL_QR'};writes.length=0;logs.length=0;calls.length=0;process.env.EVOLUTION_API_URL='https://state-type-'+(++sequence)+'.invalid';
      const result=await request('start');assert.equal(result.httpStatus,200);assert.equal(result.body.status,'QR_READY');assert.match(result.body.qr_code,/^data:image\/png;base64,/);assert.equal(writes[0].status,'QR_READY');assert.equal(writes[0].qrCode,null);assertClean([result,writes,logs]);
    });
    for(const input of [['open'],{state:'open'},null,[privateText]])await t.test('invalid explicit connect response state is rejected '+(++sequence),async()=>{
      current='close';connectPayload={instance:{state:input},code:'FAKE_QR_SECRET_MARKER'};writes.length=0;logs.length=0;calls.length=0;process.env.EVOLUTION_API_URL='https://state-type-'+(++sequence)+'.invalid';
      const result=await request('start');assert.equal(result.httpStatus,200);assert.equal(result.body.status,'nao_configurado');assert.equal(result.body.qr_code,null);assert.equal(writes[0].status,'nao_configurado');assert.equal(writes[0].qrCode,null);assertClean([result,writes,logs]);
    });
  } finally { if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await require('../src/database/pool').pool.end(); }
});
