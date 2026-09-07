function startOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function addMonths(date, months) {
  const value = new Date(date);
  value.setMonth(value.getMonth() + months);
  return value;
}

function toIsoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function daysBetween(dateA, dateB) {
  const first = startOfDay(dateA).getTime();
  const second = startOfDay(dateB).getTime();
  return Math.round((second - first) / 86400000);
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  startOfDay,
  addDays,
  addMonths,
  toIsoDate,
  daysBetween,
  parseIsoDate,
};
