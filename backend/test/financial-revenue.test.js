const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { financialRevenue, financialResponse } = require('../services/financialRevenue');

test('Faturamento HTTP: contrato, períodos, escopo, fuso e falha SQL segura', async t => {
  const now = new Date('2026-10-15T02:30:00Z'); // Still Wednesday in São Paulo.
  const row = (id, data, preco, status = 'concluido', hora = '09:00') =>
    ({ id, data, hora, preco, status, servico_nome: 'Corte' });
  const rows = [row(1,'2026-10-14',30.10),row(2,'2026-10-14',20.20),
    row(3,'2026-10-15',40),row(4,'2026-10-14',999,'confirmado'),
    row(5,'2026-10-14',999,'cancelado'),row(6,'2026-10-14',999,'falta'),
    row(7,'2026-09-30',10),row(8,'2025-09-30',100),
    row(9,'2026-10-14',900,'concluido','23:31')];
  let sqlError = false, calls = 0;
  const db = { allAsync: async (sql, params) => {
    calls++;
    assert.match(sql,/WHERE assinatura_id=\$1/);
    assert.deepEqual(params,[7]);
    assert.doesNotMatch(sql,/COALESCE|CURRENT_DATE|JOIN/);
    if(sqlError) throw new Error('private SQL password=secret');
    return rows;
  }};
  const app = express();
  app.get('/api/faturamento', financialResponse, (req,res,next) => {
    if(req.get('x-test-token') !== 'valid') return res.status(401).json({error:'Não autorizado.'});
    req.assinatura={id:7}; next();
  }, financialRevenue(db, () => now));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/faturamento`;
  const request=async(query='',token='valid')=>{
    const res=await fetch(base+query,{headers:{'x-test-token':token}});
    return {status:res.status,cache:res.headers.get('cache-control'),data:await res.json()};
  };
  await t.test('formato total em reais e no-store; futuro e outros status excluídos',async()=>{
    assert.deepEqual(await request('?periodo=dia&assinatura_id=999'),{status:200,cache:'no-store',data:{total:50.3}});
    assert.equal((await request('?periodo=hoje')).data.total,50.3);
    assert.equal((await request('?periodo=semana')).data.total,50.3);
    assert.equal((await request('?periodo=mes')).data.total,50.3);
    assert.equal((await request('?periodo=ano')).data.total,60.3);
    assert.equal((await request()).data.total,160.3);
    assert.equal((await request('?periodo=historico')).data.total,160.3);
  });
  await t.test('mês personalizado, mês em periodo=mes e vazio',async()=>{
    assert.equal((await request('?periodo=mes_customizado&mes=2026-09')).data.total,10);
    assert.equal((await request('?periodo=mes&mes=2025-09')).data.total,100);
    assert.equal((await request('?periodo=mes&mes=2026-11')).data.total,0);
  });
  await t.test('400 claro antes de consultar banco',async()=>{
    const before=calls;
    for(const q of ['?periodo=inválido','?periodo=mes_customizado','?periodo=mes&mes=2026-13']){
      const res=await request(q);assert.equal(res.status,400);assert.equal(res.cache,'no-store');assert.ok(res.data.error);
    }
    assert.equal(calls,before);
  });
  await t.test('autenticação precede cálculo',async()=>{
    const before=calls, response=await request('?periodo=dia','forged');
    assert.equal(response.status,401);assert.equal(response.cache,'no-store');assert.equal(calls,before);
  });
  await t.test('erro SQL não vaza mensagem ou dados internos',async()=>{
    sqlError=true;
    assert.deepEqual(await request('?periodo=dia'),{status:500,cache:'no-store',data:{error:'Não foi possível consultar o faturamento.'}});
  });
});
