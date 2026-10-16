// Brazilian destination only. Country code is distinguished by length, never
// by startsWith('55') alone: DDD 55 is a legitimate national area code.
// Do not infer a missing area code, insert a ninth digit, or guess a country.
function normalizeBrazilianDestination(value) {
  if (typeof value !== 'string' || !/^\+?[0-9 ()-]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && (!digits.startsWith('55') || ![12, 13].includes(digits.length))) return null;
  const national = [12, 13].includes(digits.length) && digits.startsWith('55') ? digits.slice(2) : digits;
  if (!/^[1-9]{2}(?:[2-5]\d{7}|9\d{8})$/.test(national)) return null;
  return '55' + national;
}
// Evaluate the original public field before the booking's legacy normalization.
// Persist the decision, including rejection: workers must never infer it again.
function classifyBrazilianDestination(value) {
  const destination = normalizeBrazilianDestination(value);
  return { state: destination ? 'routable' : value == null || value === '' ? 'missing' : 'invalid', destination };
}
module.exports = { normalizeBrazilianDestination, classifyBrazilianDestination };
