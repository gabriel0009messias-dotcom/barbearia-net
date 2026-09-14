function localNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const minutes = time => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const cleanPhoneSql = "replace(replace(replace(replace(replace(replace(replace(telefone, '@c.us', ''), '@s.whatsapp.net', ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')";
const phoneSql = `(CASE WHEN length(${cleanPhoneSql}) IN (10, 11) THEN '55' || ${cleanPhoneSql} ELSE ${cleanPhoneSql} END)`;

function createScheduling(db, clock = () => new Date()) {
  const services = tenant => db.allAsync("SELECT id, nome AS name, preco AS price FROM servicos_assinatura WHERE assinatura_id = $1 ORDER BY id", [tenant]);
  const salon = tenant => db.getAsync("SELECT * FROM assinaturas WHERE id = $1", [tenant]);
  async function times(tenant, date) {
    const config = await salon(tenant);
    const now = localNow(clock());
    if (!config || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date < now.date || date >= addDays(now.date, 14)) return [];
    const days = String(config.dias_funcionamento ?? '1,2,3,4,5,6').split(',').map(Number);
    if (!days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return [];
    const occupied = await db.allAsync(`SELECT hora FROM agendamentos WHERE assinatura_id = $1 AND data = $2 AND status = 'confirmado'
      UNION SELECT hora FROM bloqueios WHERE assinatura_id = $3 AND data = $4`, [tenant, date, tenant, date]);
    const taken = new Set(occupied.map(row => row.hora));
    const result = [];
    const lunchStart = minutes(config.horario_almoco_inicio), lunchEnd = minutes(config.horario_almoco_fim);
    for (let cursor = minutes(config.horario_abertura); cursor + 30 <= minutes(config.horario_fechamento); cursor += 30) {
      const time = hhmm(cursor);
      if (date === now.date && time <= now.time) continue;
      if (cursor < lunchEnd && cursor + 30 > lunchStart) continue;
      if (!taken.has(time)) result.push(time);
    }
    return result;
  }
  async function dates(tenant, service) {
    const result = [], today = localNow(clock()).date;
    for (let i = 0; i < 14; i++) { const date = addDays(today, i); if ((await times(tenant, date, service)).length) result.push(date); }
    return result;
  }
  async function future(tenant, phone) {
    const now = localNow(clock());
    return db.allAsync(`SELECT id, servico_nome AS name, data AS date, hora AS time FROM agendamentos
      WHERE assinatura_id = $1 AND ${phoneSql} = $2 AND status = 'confirmado' AND (data > $3 OR (data = $4 AND hora > $5)) ORDER BY data, hora`, [tenant, phone, now.date, now.date, now.time]);
  }
  async function book(tenant, phone, session) {
    if (!(await times(tenant, session.date)).includes(session.time)) return null;
    const service = (await services(tenant)).find(s => s.id === session.service.id);
    if (!service) return null;
    // Denormalized fields are already the panel's source of truth. No global customer/service lookup.
    try {
      return await db.runAsync(`INSERT INTO agendamentos
        (assinatura_id, nome_cliente, telefone, servico_nome, preco, data, hora, status)
        SELECT $1, $2, $3, $4, $5, $6, $7, 'confirmado'
        WHERE NOT EXISTS (SELECT 1 FROM bloqueios WHERE assinatura_id = $8 AND data = $9 AND hora = $10)
        ON CONFLICT DO NOTHING`,
      [tenant, session.name, phone, service.name, service.price, session.date, session.time, tenant, session.date, session.time]).then(r => r.changes ? r : null);
    } catch (error) { if (error.code === '23505') return null; throw error; }
  }
  return {
    services, dates, times, book, future,
    async address(tenant) { const s = await salon(tenant); return [s?.localizacao_rua, s?.localizacao_cidade, s?.localizacao_referencia].filter(Boolean).join(', '); },
    async knownName(tenant, phone) {
      const row = await db.getAsync(`SELECT nome_cliente AS name FROM agendamentos WHERE assinatura_id = $1 AND ${phoneSql} = $2 AND nome_cliente IS NOT NULL ORDER BY id DESC LIMIT 1`, [tenant, phone]);
      return row?.name && /\p{L}/u.test(row.name) ? row.name : null;
    },
    async cancel(tenant, phone, id) {
      const now = localNow(clock());
      const result = await db.runAsync(`UPDATE agendamentos SET status = 'cancelado' WHERE id = $1 AND assinatura_id = $2 AND ${phoneSql} = $3 AND status = 'confirmado' AND (data > $4 OR (data = $5 AND hora > $6))`, [id, tenant, phone, now.date, now.date, now.time]);
      return result.changes > 0;
    },
  };
}

module.exports = { createScheduling, localNow, addDays };
