const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const { testEnvironment } = require('./helpers/postgres');
const { connectionConfig } = require('../database/config');
const { migrate } = require('../database/migrate');
const { importSqlite } = require('../scripts/import-sqlite');

test('upgrade Studiofy preserva contas, serviços, pagamentos e reservas anteriores',async t=>{
 const environment=testEnvironment();const pool=new Pool(connectionConfig());
 t.after(async()=>{await pool.end();await environment.cleanup();});
 const c=await pool.connect();
 try{
  await c.query(`CREATE SCHEMA "${environment.schema}"`);
  for(const name of ['001_current_backend.sql','002_professional_plan_price.sql','003_account_delete_relations.sql','004_manual_access.sql'])await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations',name),'utf8'));
  await c.query("INSERT INTO assinaturas (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,payment_id,valor_plano) VALUES (42,'Existente','Pessoa','11999990000','mercado_pago',5,'','payment-preservado',65)");
  await c.query("INSERT INTO servicos_assinatura (id,assinatura_id,nome,preco) VALUES (78,42,'Cuidado',90)");
  const date=new Date(Date.now()+86400000*2).toISOString().slice(0,10);
  await c.query("INSERT INTO agendamentos (id,assinatura_id,nome_cliente,servico_nome,preco,data,hora,status) VALUES (94,42,'Cliente','Cuidado',90,$1,'14:00','confirmado')",[date]);
  await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/005_studiofy.sql'),'utf8'));await c.query('COMMIT');
  const a=(await c.query('SELECT * FROM assinaturas WHERE id=42')).rows[0];assert.equal(a.payment_id,'payment-preservado');assert.equal(a.valor_plano,65);assert.equal(a.public_slug,'studio-42');
  const s=(await c.query('SELECT * FROM servicos_assinatura WHERE id=78')).rows[0];assert.equal(s.preco,90);assert.equal(s.duracao,30);assert.equal(s.ativo,true);
  const booking=(await c.query('SELECT * FROM agendamentos WHERE id=94')).rows[0];assert.equal(booking.nome_cliente,'Cliente');assert.equal(booking.status,'confirmado');assert.ok(booking.profissional_id);
  const reminder=(await c.query('SELECT * FROM appointment_reminders WHERE appointment_id=94')).rows[0];assert.equal(new Date(reminder.due_at).toISOString(),new Date(`${date}T13:40:00-03:00`).toISOString());
  await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/006_public_cancellation.sql'),'utf8'));await c.query('COMMIT');
  assert.deepEqual((await c.query('SELECT * FROM agendamentos WHERE id=94')).rows[0],booking);
  assert.deepEqual((await c.query('SELECT * FROM appointment_reminders WHERE appointment_id=94')).rows[0],reminder);
  assert.equal((await c.query('SELECT cancellation_notice_minutes FROM assinaturas WHERE id=42')).rows[0].cancellation_notice_minutes,0);
  assert.equal((await c.query('SELECT count(*) AS n FROM public_booking_access')).rows[0].n,0);
  await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/007_multisegment.sql'),'utf8'));await c.query('COMMIT');
  assert.deepEqual((await c.query('SELECT * FROM agendamentos WHERE id=94')).rows[0],booking);
  assert.deepEqual((await c.query('SELECT * FROM appointment_reminders WHERE appointment_id=94')).rows[0],reminder);
  assert.equal((await c.query('SELECT business_type_code FROM assinaturas WHERE id=42')).rows[0].business_type_code,'other');
  assert.equal((await c.query('SELECT categoria FROM servicos_assinatura WHERE id=78')).rows[0].categoria,'');
  const beforeTrial=(await c.query('SELECT * FROM assinaturas WHERE id=42')).rows[0];
  await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/008_seven_day_trial.sql'),'utf8'));
  const afterTrial=(await c.query('SELECT * FROM assinaturas WHERE id=42')).rows[0];
  for(const [key,value] of Object.entries(beforeTrial))assert.deepEqual(afterTrial[key],value,key);
  assert.equal(afterTrial.trial_status,null);assert.equal(afterTrial.trial_ends_at,null);
  assert.deepEqual((await c.query('SELECT * FROM agendamentos WHERE id=94')).rows[0],booking);
  const tables=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[environment.schema])).rows.map(r=>r.tablename);
  const beforeChat={};
  for(const table of tables)beforeChat[table]=(await c.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows;
  await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/009_studiofy_chat.sql'),'utf8'));await c.query('COMMIT');
  for(const table of tables)assert.deepEqual((await c.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows,beforeChat[table],`Chat preserva ${table}`);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM chat_conversations')).rows[0].n,0);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM chat_messages')).rows[0].n,0);
  // Upgrade an existing schema containing every final state, without rewriting its facts.
  for(const [id,status]of [[95,'concluido'],[96,'cancelado'],[97,'falta']])await c.query(
   "INSERT INTO agendamentos (id,assinatura_id,nome_cliente,servico_nome,preco,data,hora,status,profissional_id,duracao,studio_service_id) VALUES ($1,42,'Cliente histórico','Cuidado',90,'2026-09-27','09:00',$2,$3,30,78)",[id,status,booking.profissional_id]);
  const beforeFinal=(await c.query('SELECT * FROM agendamentos ORDER BY id')).rows;
  await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/011_appointment_final_states.sql'),'utf8'));
  assert.deepEqual((await c.query('SELECT * FROM agendamentos ORDER BY id')).rows,beforeFinal);
  for(const id of [95,96,97]){
   await assert.rejects(c.query("UPDATE agendamentos SET status='confirmado' WHERE id=$1",[id]),error=>error.code==='23514');
   await assert.rejects(c.query('UPDATE agendamentos SET preco=1 WHERE id=$1',[id]),error=>error.code==='23514');
  }
  assert.deepEqual((await c.query('SELECT * FROM agendamentos ORDER BY id')).rows,beforeFinal);
  const before012={};
  for(const table of tables)before012[table]=(await c.query('SELECT * FROM "'+table+'" ORDER BY 1')).rows;
  await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/012_public_booking_requests.sql'),'utf8'));await c.query('COMMIT');
  for(const table of tables)assert.deepEqual((await c.query('SELECT * FROM "'+table+'" ORDER BY 1')).rows,before012[table], '012 preserves '+table);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND column_name='bloqueio_admin'",[environment.schema])).rows[0].n,0);
  const indices=(await c.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1',[environment.schema])).rows.map(r=>r.indexname);
  for(const name of ['public_booking_requests_pkey','public_booking_request_recovery','public_request_limits_pkey','public_request_limits_expiry'])assert.ok(indices.includes(name),name);
  const hash='a'.repeat(64),requestHash='b'.repeat(64);
  await c.query('INSERT INTO public_booking_requests(assinatura_id,key_hash,request_hash,appointment_id) VALUES(42,$1,$2,94)',[hash,requestHash]);
  await assert.rejects(c.query('INSERT INTO public_booking_requests(assinatura_id,key_hash,request_hash,appointment_id) VALUES(42,$1,$2,94)',[hash,requestHash]),e=>e.code==='23505');
  await assert.rejects(c.query('INSERT INTO public_booking_requests(assinatura_id,key_hash,request_hash,appointment_id) VALUES(42,$1,$2,94)',['invalid',requestHash]),e=>e.code==='23514');
  await assert.rejects(c.query('INSERT INTO public_booking_requests(assinatura_id,key_hash,request_hash,appointment_id) VALUES(999,$1,$2,94)',['c'.repeat(64),requestHash]),e=>e.code==='23503');
  await assert.rejects(c.query('INSERT INTO public_booking_requests(assinatura_id,key_hash,request_hash,appointment_id) VALUES(42,$1,$2,999)',['c'.repeat(64),requestHash]),e=>e.code==='23503');
  await c.query('DELETE FROM agendamentos WHERE id=94');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM public_booking_requests')).rows[0].n,0);
  await c.query('INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at) VALUES($1,1,1,CURRENT_TIMESTAMP)',[hash]);
  await assert.rejects(c.query('INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at) VALUES($1,1,1,CURRENT_TIMESTAMP)',[hash]),e=>e.code==='23505');
  await assert.rejects(c.query('INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at) VALUES($1,2,1,CURRENT_TIMESTAMP)',['bad']),e=>e.code==='23514');
 }finally{c.release();}
});

test('migrations e importacao preservam dados, IDs e pagamentos', async t => {
  const environment = testEnvironment();
  const pool = new Pool(connectionConfig());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-import-test-'));
  const filename = path.join(directory, 'source.db');
  const source = new sqlite3.Database(filename);
  const exec = sql => new Promise((resolve, reject) => source.exec(sql, error => error ? reject(error) : resolve()));
  await exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, telefone TEXT);
    INSERT INTO clientes VALUES (80, 'Cliente 1', '5511111111111'), (81, 'Cliente 2', '5511111111111');
    CREATE TABLE assinaturas (id INTEGER PRIMARY KEY, barbearia_nome TEXT, responsavel_nome TEXT, telefone TEXT,
      metodo_pagamento TEXT, dia_vencimento INTEGER, suporte_numero TEXT, status TEXT, status_assinatura TEXT,
      gateway_status TEXT, payment_id TEXT, bloqueado INTEGER, ultimo_pagamento TEXT, proximo_vencimento TEXT);
    INSERT INTO assinaturas VALUES (100, 'Salao', 'Responsavel', '551122223333', 'mercado_pago', 5, '', 'ativo', 'ATIVA', 'approved', '900', 0, '2026-09-01', '2026-10-01');
    CREATE TABLE agendamentos (id INTEGER PRIMARY KEY, assinatura_id INTEGER, cliente_id INTEGER, data TEXT, hora TEXT, status TEXT);
    INSERT INTO agendamentos VALUES (200, 100, 80, '2026-09-20', '09:00', 'confirmado');
    CREATE TABLE mercado_pago_orders (reference TEXT PRIMARY KEY, assinatura_id INTEGER, amount_cents INTEGER, live_mode INTEGER, expires_at TEXT, credited_payment_id TEXT);
    INSERT INTO mercado_pago_orders VALUES ('reference-import', 100, 6500, 0, '2026-10-01', '900');
    CREATE TABLE mercado_pago_payments (payment_id TEXT PRIMARY KEY, order_reference TEXT, assinatura_id INTEGER, status TEXT, amount_cents INTEGER, credited_at TEXT);
    INSERT INTO mercado_pago_payments VALUES ('900', 'reference-import', 100, 'approved', 6500, '2026-09-01');
  `);
  await new Promise(resolve => source.close(resolve));
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const originalHash = hash();
  t.after(async () => { await pool.end(); await environment.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); });

  await t.test('migrations concorrentes e repetidas nao destroem dados', async () => {
    await Promise.all([migrate(pool), migrate(pool)]);
    assert.deepEqual((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name), [
      '001_current_backend.sql', '002_professional_plan_price.sql', '003_account_delete_relations.sql',
      '004_manual_access.sql', '005_studiofy.sql', '006_public_cancellation.sql', '007_multisegment.sql', '008_seven_day_trial.sql', '009_studiofy_chat.sql', '011_appointment_final_states.sql', '012_public_booking_requests.sql',
    ]);
    await pool.query("UPDATE configuracoes SET valor='preservar' WHERE chave='admin_pin'");
    await migrate(pool);
    assert.equal((await pool.query("SELECT valor FROM configuracoes WHERE chave='admin_pin'")).rows[0].valor, 'preservar');
    await pool.query("UPDATE configuracoes SET valor='5090' WHERE chave='admin_pin'");
  });
  await t.test('ensaio reverte as linhas; arquivo SQLite permanece intacto', async () => {
    const result = await importSqlite(filename, { checkOnly: true });
    assert.equal(result.counts.clientes, 2);
    assert.equal((await pool.query('SELECT count(*) FROM assinaturas')).rows[0].count, 0);
    assert.equal(hash(), originalHash);
  });
  await t.test('catalogo personalizado nao e confundido com destino vazio', async () => {
    await pool.query("UPDATE business_types SET name='Personalizado' WHERE code='other'");
    try {
      await assert.rejects(importSqlite(filename, { checkOnly: true }), /Destino possui dados em business_types/);
      assert.equal((await pool.query("SELECT name FROM business_types WHERE code='other'")).rows[0].name, 'Personalizado');
    } finally { await pool.query("UPDATE business_types SET name='Outro' WHERE code='other'"); }
  });
  await t.test('importa campos de pagamento e duplicados historicos sem alterar IDs', async () => {
    await importSqlite(filename);
    const row = (await pool.query('SELECT * FROM assinaturas WHERE id=100')).rows[0];
    assert.equal(row.payment_id, '900'); assert.equal(row.gateway_status, 'approved');
    assert.equal(row.bloqueado, 0); assert.equal(row.proximo_vencimento, '2026-10-01');
    assert.equal((await pool.query('SELECT cliente_id FROM agendamentos WHERE id=200')).rows[0].cliente_id, 80);
    assert.equal((await pool.query('SELECT count(*) FROM clientes')).rows[0].count, 2);
    const next = (await pool.query("INSERT INTO clientes(nome) VALUES ('Novo') RETURNING id")).rows[0].id;
    assert.ok(next > 81);
    assert.equal(hash(), originalHash);
  });
  await t.test('repetir importacao nao duplica nem sobrescreve dados atuais', async () => {
    await pool.query("UPDATE assinaturas SET barbearia_nome='Alterado no painel' WHERE id=100");
    assert.equal((await importSqlite(filename)).alreadyImported, true);
    assert.equal((await pool.query('SELECT barbearia_nome FROM assinaturas WHERE id=100')).rows[0].barbearia_nome, 'Alterado no painel');
  });
  await t.test('pagamento importado nao credita outros 30 dias', async () => {
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token'; process.env.MERCADO_PAGO_MODE = 'test';
    const original = global.fetch;
    global.fetch = async () => Response.json({ id: 900, status: 'approved', external_reference: 'reference-import', currency_id: 'BRL', transaction_amount: 65, live_mode: false, date_approved: '2026-09-01T12:00:00Z' });
    const payments = require('../services/payments/mercadoPago');
    try {
      await payments.reconcile('900');
      assert.equal((await pool.query('SELECT proximo_vencimento FROM assinaturas WHERE id=100')).rows[0].proximo_vencimento, '2026-10-01');
    } finally { global.fetch = original; await require('../database').close(); }
  });
});
