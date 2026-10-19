const { normalizeBrazilianDestination } = require('./whatsapp/phone');
const plain = value => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,200) : '';
function buildReminderMessage(row) {
 const s=row.snapshot, name=plain(s?.cliente), service=plain(s?.servico), establishment=plain(s?.estabelecimento);
 if (!['reminder_15m','reminder_5m'].includes(row.reminder_kind) || !name || !service || !establishment ||
   !row.destination || normalizeBrazilianDestination(row.destination)!==row.destination ||
   !/^\d{4}-\d{2}-\d{2}$/.test(s.data || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.hora || '')) throw Error('Invalid reminder snapshot');
 // Exact appointment time plus generic wording remain true after transport delays.
 const first=row.reminder_kind==='reminder_15m' ? `⏰ Lembrete: seu horário está chegando, ${name}!` : `🚨 ${name}, seu atendimento começa em instantes!`;
 const professional=plain(s.profissional);
 return `${first}\nServiço: ${service}\n${professional?`Profissional: ${professional}\n`:''}Data: ${s.data.split('-').reverse().join('/')} às ${s.hora}\nEstabelecimento: ${establishment}`;
}
module.exports={buildReminderMessage};
