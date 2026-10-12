const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {publicService,publicProfessional}=require('../services/publicCatalog');
const {createHttpErrorHandler}=require('../services/httpErrors');

test('DTO público ignora colunas internas presentes e futuras',()=>{
 const secret={senha:'synthetic-marker'};
 const service=publicService({id:1,nome:'Serviço',descricao:'Descrição',preco:40,duracao:30,foto:null,categoria:'Teste',assinatura_id:99,ativo:true,internal_future:secret});
 assert.deepEqual(Object.keys(service).sort(),['id','nome','descricao','preco','duracao','foto','categoria'].sort());
 assert.equal(JSON.stringify(service).includes('synthetic-marker'),false);
 const professional=publicProfessional({id:2,nome:'Pessoa Fictícia',servicos:[1,secret],assinatura_id:99,internal_future:secret});
 assert.deepEqual(professional,{id:2,nome:'Pessoa Fictícia',servicos:[1]});
});

test('parser JSON e erros controlados não registram credenciais nem objetos brutos',async t=>{
 const logs=[],app=express();app.use(express.json());
 app.post('/fixture',(_req,res)=>res.json({ok:true}));
 app.get('/error',(_req,_res,next)=>next(Object.assign(Error('synthetic-private-message'),{status:503,body:'synthetic-private-body',headers:{Authorization:'synthetic-private-header'}})));
 app.use(createHttpErrorHandler({error:(...args)=>logs.push(args)}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const markers=['synthetic-password','synthetic-token','synthetic-authorization','synthetic-cookie'];
 const response=await fetch(base+'/fixture',{method:'POST',headers:{'Content-Type':'application/json',Authorization:markers[2],Cookie:markers[3]},body:JSON.stringify({senha:markers[0],token:markers[1],Authorization:markers[2]})+','});
 assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');const payload=await response.json();assert.equal(payload.error,'JSON invalido na requisicao.');
 for(const marker of markers){assert.equal(JSON.stringify(logs).includes(marker),false);assert.equal(JSON.stringify(payload).includes(marker),false);}
 assert.deepEqual(logs[0],['Erro HTTP',{type:'invalid_json',status:400}]);
 const controlled=await fetch(base+'/error');assert.equal(controlled.status,503);assert.equal(JSON.stringify(await controlled.json()).includes('synthetic-private'),false);
 assert.equal(JSON.stringify(logs).includes('synthetic-private'),false);
 assert.deepEqual(logs[1],['Erro HTTP',{type:'request_error',status:503}]);
});
