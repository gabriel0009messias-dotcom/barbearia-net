const fs=require('fs'),path=require('path'),util=require('util'),assert=require('assert/strict');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL,JWT_SECRET:'synthetic-final-jwt-secret',EVOLUTION_API_URL:'https://audit-alternative.invalid',EVOLUTION_API_KEY:'FAKE_API_KEY_MARKER',EVOLUTION_WEBHOOK_SECRET:'FAKE_WEBHOOK_SECRET_MARKER',ENABLE_DOCS_WARNING:'false'});
const r=require('module').createRequire(path.resolve(__dirname,'../package.json'));
const express=r('express'),repository=r('./src/repositories/whatsappSessionRepository'),users=r('./src/repositories/saasUserRepository');
repository.findBySalonId=async()=>({salon_id:806,instance_name:'barbearia-806',status:'DISCONNECTED'});users.findById=async()=>({id:806,salon_id:806,ativo:true});
const native=global.fetch,originalInfo=console.info,originalError=console.error,logs=[],raw='FAKE_QR_SECRET_MARKER',pair='FAKE_PAIRING_SECRET_MARKER';
const sensitive=[raw,pair,process.env.EVOLUTION_API_KEY,process.env.EVOLUTION_WEBHOOK_SECRET,'FAKE_TOKEN_MARKER'],marker=sensitive.join(' ');
let base,mode='nested';console.info=(...args)=>logs.push(util.format(...args));console.error=(...args)=>logs.push(util.format(...args));
global.fetch=async(input,options)=>{const url=new URL(String(input));if(base&&url.origin===base)return native(input,options);assert.equal(url.origin,'https://audit-alternative.invalid');assert.ok(!url.pathname.includes('barbearia-1'));
if(mode==='nested')throw new TypeError('simulated transport failure',{cause:{code:'ECONNRESET',message:raw,pairingCode:pair,apikey:process.env.EVOLUTION_API_KEY,webhookSecret:process.env.EVOLUTION_WEBHOOK_SECRET,token:'FAKE_TOKEN_MARKER'}});
if(mode==='generic')throw Error(marker);
return new Response(new ReadableStream({start(controller){controller.error(Error(marker));}}),{status:200});};
require('node:test').test('alternative-errors rejects private exceptions in HTTP, console and persistence', async () => {const app=express();app.use('/api/whatsapp',r('./src/routes/whatsappRoutes'));app.use(r('./src/middlewares/errorMiddleware').errorMiddleware);const server=await new Promise(done=>{const s=app.listen(0,'127.0.0.1',()=>done(s));});base='http://127.0.0.1:'+server.address().port;
const token=r('jsonwebtoken').sign({sub:'806'},process.env.JWT_SECRET),results=[];
try{for(const fault of ['nested','generic','stream']){mode=fault;logs.length=0;const response=await native(base+'/api/whatsapp/status',{headers:{authorization:'Bearer '+token}});const body=await response.json();results.push({fault,httpStatus:response.status,logsContain:sensitive.map(value=>logs.join('\n').includes(value)),responseContains:sensitive.map(value=>JSON.stringify(body).includes(value))});}}
finally{server.closeAllConnections();await new Promise(done=>server.close(done));await r('./src/database/pool').pool.end();global.fetch=native;console.info=originalInfo;console.error=originalError;}
assert.ok(results.every(row=>row.logsContain.every(v=>!v)&&row.responseContains.every(v=>!v)),JSON.stringify(results));
});
