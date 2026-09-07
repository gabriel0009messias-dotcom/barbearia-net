const { validationResult } = require('express-validator');
const { sanitizeObject } = require('../utils/sanitize');

function validateRequest(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    res.status(422).json({
      error: 'Dados invalidos.',
      details: errors.array(),
    });
    return;
  }

  req.body = sanitizeObject(req.body);
  req.query = sanitizeObject(req.query);
  next();
}

module.exports = {
  validateRequest,
};
