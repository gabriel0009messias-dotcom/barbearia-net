const DAY_MS = 86400000;
const GRACE_MS = 96 * 60 * 60 * 1000;
const BUSINESS_TIMEZONE = 'America/Sao_Paulo';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function validDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const value = new Date(date + 'T00:00:00Z');
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}
function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !validDate(value.slice(0, 10))) return NaN;
  return Date.parse(value);
}
function legacyDateInstant(value) {
  if (typeof value !== 'string' || !validDate(value)) return NaN;
  const target = Date.parse(value + 'T00:00:00Z');
  let result = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(result).map(p => [p.type, p.value]));
    const wall = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const next = result + target - wall;
    if (next === result) return result;
    result = next;
  }
  // A nonexistent midnight (historical DST) is ambiguous: fail closed.
  return NaN;
}
function expiryInstant(account) {
  if (account?.vencimento_em != null) return instant(account.vencimento_em);
  const value = account?.proximo_vencimento;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? legacyDateInstant(value) : instant(value);
}
module.exports = { DAY_MS, GRACE_MS, BUSINESS_TIMEZONE, instant, legacyDateInstant, expiryInstant };
