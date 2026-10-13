const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {connectionConfig}=require('../database/config');
const {migrate}=require('../database/migrate');
test('015 com registros legados: atomicidade, preservacao e reaplicacao via migrador',async t=>{
  const env=require('./helpers/postgres').testEnvironment(),pool=new Pool(connectionConfig());t.after(async()=>{await pool.end();await env.cleanup();});
  await pool.query(`CREATE SCHEMA "${env.schema}"`);
  await pool.query('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ DEFAULT NOW())');
  const directory=path.join(__dirname,'../database/migrations');
  for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<'015')){
    const sql=fs.readFileSync(path.join(directory,name),'utf8');await pool.query(sql);await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,crypto.createHash('sha256').update(sql).digest('hex')]);
  }
  for(const [id,due]of [[1,null],[2,'invalid'],[3,'2099-01-01']])await pool.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,status_assinatura,proximo_vencimento,ultimo_pagamento,payment_id,observacoes) VALUES($1,'Legacy','Fixture','11999990000','mercado_pago',5,'','ativo','ATIVA',$2,'2026-09-01',$3,'Existing contract')",[id,due,'legacy-'+id]);
  await pool.query("INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES(1,'Historical',65)");
  const before=(await pool.query('SELECT * FROM assinaturas ORDER BY id')).rows;
  const services=(await pool.query('SELECT * FROM servicos_assinatura')).rows;
  await t.test('migracao concorrente adiciona NULL e nao reescreve fatos legados',async()=>{
    await Promise.all([migrate(pool,env.schema),migrate(pool,env.schema)]);
    const after=(await pool.query('SELECT * FROM assinaturas ORDER BY id')).rows;
    for(let i=0;i<after.length;i++){assert.equal(after[i].vencimento_em,null);const {vencimento_em,...facts}=after[i];assert.deepEqual(facts,before[i]);}
    assert.deepEqual((await pool.query('SELECT * FROM servicos_assinatura')).rows,services);
    assert.deepEqual(after.map(a=>require('../services/access').avaliarAcessoAssinatura(a).liberado),[false,false,true]);
  });
  await t.test('reexecucao preserva checksum, dados e coluna unica',async()=>{
    const before=(await pool.query('SELECT * FROM assinaturas ORDER BY id')).rows;await migrate(pool,env.schema);
    assert.deepEqual((await pool.query('SELECT * FROM assinaturas ORDER BY id')).rows,before);
    const rows=(await pool.query("SELECT * FROM schema_migrations WHERE name='015_subscription_expiry_instant.sql'")).rows;assert.equal(rows.length,1);
    assert.equal(rows[0].checksum,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,rows[0].name))).digest('hex'));
  });
});
