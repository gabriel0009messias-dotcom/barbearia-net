const {test}=require('node:test');
const assert=require('node:assert/strict');
const {requestIdentity}=require('../services/bookingRequests');
const {budgetKey,POLICIES,createPublicLimiter}=require('../services/publicLimits');
const key='a'.repeat(64),body={nome_cliente:' Ana ',telefone:'(11) 99999-0000',servico_id:1,profissional_id:2,data:'2099-01-01',hora:'08:00'};
test('capacidade e recibo usam domínios distintos, escopo e campos canônicos',()=>{
 const a=requestIdentity(key,1,body),b=requestIdentity(key,2,body);
 assert.match(a.token,/^[a-f0-9]{64}$/);assert.notEqual(a.token,key);assert.notEqual(a.token,a.keyHash);assert.notEqual(a.token,b.token);
 assert.deepEqual(requestIdentity(key,1,{...body,nome_cliente:'Ana',telefone:'11999990000',assinatura_id:500,preco:1}),a);
 assert.notEqual(requestIdentity(key,1,{...body,hora:'09:00'}).requestHash,a.requestHash);
});
for(const key of [undefined,null,'1','g'.repeat(64),{},'a'.repeat(63)])test('chave de recuperação inválida: '+String(key),()=>assert.throws(()=>requestIdentity(key,1,body),{statusCode:400}));
test('global budgets ignore every IP/header/body identity',async()=>{
 const keys=[];const handler=createPublicLimiter({getAsync:async(_q,p)=>{keys.push(p[0]);return {hits:1};},runAsync:async()=>{}},'signup');
 for(const value of ['192.0.2.1','2001:db8::1',undefined]){
  const req={ip:value,ips:[value],socket:{remoteAddress:value},headers:{'x-forwarded-for':value,'x-real-ip':value},body:{email:value,telefone:value}};
  await handler(req,{set(){return this;}},()=>{});
 }
 assert.equal(new Set(keys).size,1);
});
test('validated canonical contexts separate tenants and reservations without secrets',()=>{
 const a=budgetKey('booking',POLICIES.booking,{tenantId:1});
 assert.equal(a,budgetKey('booking',POLICIES.booking,{tenantId:'1'}));
 assert.notEqual(a,budgetKey('booking',POLICIES.booking,{tenantId:2}));
 assert.notEqual(budgetKey('reservationRead',POLICIES.reservationRead,{tenantId:1,reservationId:2}),budgetKey('reservationRead',POLICIES.reservationRead,{tenantId:1,reservationId:3}));
 assert.match(a,/^[a-f0-9]{64}$/);
});
test('missing or arbitrary context never creates an attacker-selected budget',()=>{
 for(const context of [undefined,{}, {tenantId:'invalid'},{tenantId:0},{tenantId:'01'}])assert.throws(()=>budgetKey('booking',POLICIES.booking,context));
 assert.throws(()=>budgetKey('reservationRead',POLICIES.reservationRead,{tenantId:1}));
 assert.ok(POLICIES.navigation.limit>240);assert.ok(POLICIES.booking.limit>30);assert.ok(POLICIES.signup.limit>60);
});

test('falha do store responde 503 seguro com Retry-After, sem log nem erro interno',async()=>{
 const handler=createPublicLimiter({getAsync:async()=>{throw Error('password=secret');}},'signup');
 const response={headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(value){this.body=value;return this;}};
 await handler({socket:{remoteAddress:'127.0.0.1'},headers:{},params:{}},response,()=>assert.fail('fail-open'));
 assert.equal(response.code,503);assert.equal(response.headers['Retry-After'],'5');assert.doesNotMatch(JSON.stringify(response.body),/secret|password/);
});
