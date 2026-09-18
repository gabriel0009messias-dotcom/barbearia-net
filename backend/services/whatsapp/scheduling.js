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
  const services = tenant => db.allAsync("SELECT id, nome AS name, preco AS price, duracao FROM servicos_assinatura WHERE assinatura_id = $1 AND ativo=true ORDER BY id", [tenant]);
  const salon = tenant => db.getAsync("SELECT * FROM assinaturas WHERE id = $1", [tenant]);
  async function times(tenant, date, service) {
    const { createStudio } = require('../studiofy');
    const run = async connection => {
      const studio = createStudio(connection, clock);
      await studio.ensure(tenant);
      const selected = service?.id || service || (await services(tenant))[0]?.id;
      const people = await studio.professionals(tenant);
      const professional = people.find(p => p.ativo && p.servicos.includes(Number(selected)));
      return professional ? studio.times(tenant,date,selected,professional.id) : [];
    };
    return db.transaction ? db.transaction(run) : run(db);
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
    const { createStudio } = require('../studiofy');
    const studio = createStudio(db, clock);
    await studio.ensure(tenant);
    const people = await studio.professionals(tenant);
    const professional = people.find(p => p.ativo && p.servicos.includes(Number(session.service.id)));
    if (!professional) return null;
    try {
      const result = await studio.book(tenant, {nome_cliente:session.name,telefone:phone,servico_id:session.service.id,profissional_id:professional.id,data:session.date,hora:session.time});
      return {lastID:result.id,changes:1};
    } catch (error) { if(error.statusCode===409 || error.code==='23505') return null; throw error; }
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
