const xss = require('xss');

function sanitizeObject(input) {
  if (Array.isArray(input)) {
    return input.map(sanitizeObject);
  }

  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, sanitizeObject(value)]));
  }

  if (typeof input === 'string') {
    return xss(input.trim());
  }

  return input;
}

module.exports = {
  sanitizeObject,
};
