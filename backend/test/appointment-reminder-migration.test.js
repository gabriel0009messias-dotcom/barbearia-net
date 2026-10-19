const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg'),{migrate}=require('../database/migrate');
test('023 populated legacy upgrade, rollback, reexecution and appointment preservation',async t=>{
 const env=require('./helpers/postgres').testEnvironment(),pool=new Pool(require('../database/config').connectionConfig()),c=await pool.connect();
 t.after(async()=>{c.release();await pool.end();await env.cleanup();});
 const directory=path.join(__dirname,'../database/migrations'),sql=fs.readFileSync(path.join(directory,'023_appointment_reminder_windows.sql'),'utf8');
 await c.query('BEGIN');await c.query('CREATE SCHEMA "'+env.schema+'"');await c.query('SET LOCAL search_path TO "'+env.schema+'",public');
 await c.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
 await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
 for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<'023').sort()){
  const source=fs.readFileSync(path.join(directory,name),'utf8');await c.query(source);await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,crypto.createHash('sha256').update(source).digest('hex')]);
 }
 await c.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento) VALUES(42001,'Upgrade','Pessoa','11999990000','mercado_pago',5,'','ativo','2099-01-01')");
 for(const [i,status] of ['pending','sending','sent','uncertain'].entries()){
  const appointment=(await c.query("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(42001,'Cliente','5511999990001','Corte',30,'2030-01-02',$1,'confirmado') RETURNING id",[`${10+i}:00`])).rows[0].id;
  if(status!=='pending')await c.query("UPDATE appointment_reminders SET status=$1,attempts=1,claimed_at=clock_timestamp(),dispatch_started_at=clock_timestamp(),claim_token=gen_random_uuid(),sent_at=CASE WHEN $1='sent' THEN clock_timestamp() ELSE NULL END WHERE appointment_id=$2",[status,appointment]);
 }
 await c.query('COMMIT');await c.query('SET search_path TO "'+env.schema+'",public');
 const appointments=(await c.query('SELECT * FROM agendamentos ORDER BY id')).rows;
 const original=(await c.query('SELECT * FROM appointment_reminders ORDER BY id')).rows;
 await t.test('rollback restores exact pre-023 legacy state',async()=>{
  await c.query('BEGIN');await c.query(sql);await c.query('ROLLBACK');
  assert.deepEqual((await c.query('SELECT * FROM appointment_reminders ORDER BY id')).rows,original);
  assert.equal((await c.query("SELECT to_regclass('appointment_reminder_origins') AS relation")).rows[0].relation,null);
 });
 await t.test('upgrade preserves evidence, retires unstarted 20m and seeds two new kinds',async()=>{
  await migrate(pool);
  // The full runner also installs additive 024: legacy facts stay identical,
  // and its historical snapshot must remain unavailable rather than backfilled.
  assert.deepEqual((await c.query('SELECT * FROM agendamentos ORDER BY id')).rows,
   appointments.map(appointment=>({...appointment,return_history_snapshot:null,origem:null,observacao:null})));
  const legacy=(await c.query("SELECT * FROM appointment_reminders WHERE reminder_kind='legacy_20m' ORDER BY id")).rows;
  assert.equal(legacy.length,4);
  for(let i=0;i<4;i++)for(const [key,value] of Object.entries(original[i])){
   if(i===0&&['status','last_error'].includes(key))continue;
   assert.deepEqual(legacy[i][key],value,'Legacy evidence '+key);
  }
  assert.equal(legacy[0].status,'cancelled');
  assert.equal((await c.query("SELECT count(*)::int n FROM appointment_reminders WHERE reminder_kind<>'legacy_20m'")).rows[0].n,8);
 });
 await t.test('repeated and concurrent migration is idempotent; old checksums unchanged',async()=>{
  const before=(await c.query('SELECT * FROM appointment_reminders ORDER BY id')).rows;
  await Promise.all([migrate(pool),migrate(pool)]);await migrate(pool);
  assert.deepEqual((await c.query('SELECT * FROM appointment_reminders ORDER BY id')).rows,before);
  for(const row of (await c.query("SELECT name,checksum FROM schema_migrations WHERE name<'023'")).rows)assert.equal(row.checksum,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,row.name))).digest('hex'));
 });
 await t.test('new bookings create only 15m and 5m; legacy insert prohibited',async()=>{
  const a=(await c.query("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(42001,'Novo','5511999990001','Corte',30,'2030-01-03','14:00','confirmado') RETURNING id")).rows[0];
  assert.deepEqual((await c.query('SELECT reminder_kind FROM appointment_reminders WHERE appointment_id=$1 ORDER BY reminder_kind',[a.id])).rows.map(r=>r.reminder_kind),['reminder_15m','reminder_5m']);
  await assert.rejects(c.query('INSERT INTO appointment_reminders(appointment_id,assinatura_id,due_at) VALUES($1,42001,clock_timestamp())',[a.id]),e=>e.code==='23514');
 });
});
