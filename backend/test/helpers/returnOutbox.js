const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { transitionAppointment } = require('../../services/agenda');

async function fixture(t) {
  const env = require('./postgres').testEnvironment();
  const db = require('../../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const q = (text, values) => db.pool.query(text, values);
  const get = (text, values) => db.getAsync(text, values);
  const s = '"' + env.schema + '"';
  async function clock(iso = '2030-06-03T15:00:00Z') {
    assert.match(env.schema, /^test_[a-f0-9]{32}$/);
    assert.ok(Number.isFinite(+new Date(iso)));
    await q(`CREATE OR REPLACE FUNCTION ${s}.studiofy_return_now() RETURNS timestamptz LANGUAGE sql VOLATILE
      SET search_path=pg_catalog AS $$SELECT '${new Date(iso).toISOString()}'::timestamptz$$`);
  }
  async function enable(value = true) {
    await q("INSERT INTO configuracoes(chave,valor) VALUES('return_outbox_delivery_enabled',$1) ON CONFLICT(chave) DO UPDATE SET valor=EXCLUDED.valor", [String(value)]);
  }
  async function account({ instance = 'return-test-' + randomUUID() } = {}) {
    return (await q(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,
      suporte_numero,acesso_manual_ate,whatsapp_session) VALUES('Estabelecimento histórico','Synthetic owner','11988880000',
      'mercado_pago',5,'11977770000','2099-01-01',$1) RETURNING *`, [instance])).rows[0];
  }
  async function service(owner) {
    return (await q("INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES($1,'Serviço histórico',30) RETURNING id", [owner.id])).rows[0].id;
  }
  let bookingSequence = 0;
  async function book(owner, sid, { phone = '11999996060', name = 'Ágata histórica' } = {}) {
    const date = new Date(Date.UTC(2021, 0, 1 + bookingSequence++)).toISOString().slice(0, 10);
    return (await q(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status,studio_service_id)
      VALUES($1,$2,$3,'Serviço histórico',30,$5,'10:00','confirmado',$4) RETURNING id`, [owner.id, name, phone, sid, date])).rows[0].id;
  }
  async function complete(owner, sid, options) {
    const id = await book(owner, sid, options);
    await transitionAppointment(db, owner.id, id, 'concluido');
    return get('SELECT * FROM return_reminders WHERE appointment_id=$1', [id]);
  }
  async function opportunity(options) { const owner = await account(options), sid = await service(owner); return { owner, sid, r: await complete(owner, sid) }; }
  const row = r => get('SELECT * FROM return_reminders WHERE id=$1', [r.id]);
  const outbox = r => get('SELECT * FROM whatsapp_messages WHERE return_reminder_id=$1', [r.id]);
  const group = (c, r) => c.query(`SELECT ${s}.studiofy_return_group_lock($1,$2,$3)`, [r.assinatura_id, r.customer_key, r.service_identity]);
  async function claim(r) {
    const m = await outbox(r), token = randomUUID();
    await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2", [token, m.id]);
    return { ...m, claim_token: token };
  }
  function child(code) {
    const processChild = spawn(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '../..'),
      windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    processChild.stderr.on('data', data => { stderr += data; });
    processChild.done = new Promise((resolve, reject) => {
      processChild.once('error', reject);
      processChild.once('exit', code => code === 0 ? resolve() : reject(Error('Child exited ' + code + ': ' + stderr)));
    });
    // A staged crash is intentionally nonzero; callers can still await rejection.
    processChild.done.catch(() => {});
    t.after(() => { if (processChild.exitCode === null) processChild.kill(); });
    return processChild;
  }
  await clock();
  return { db, env, q, get, s, clock, enable, account, service, book, complete, opportunity, row, outbox, group, claim, child };
}
const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });
module.exports = { fixture, accepted };
