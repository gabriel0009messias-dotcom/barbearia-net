const { publicWhatsappError, logWhatsappFailure } = require('../../whatsappError');
function notFoundMiddleware(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada.' });
}

function errorMiddleware(error, req, res, next) {
  const safe = publicWhatsappError(error);
  const statusCode = safe.statusCode;
  // URL spelling never selects a less safe exception policy.
  const message = safe.message;

  if (statusCode >= 500) {
    logWhatsappFailure(error);
  }

  res.status(statusCode).json({ error: message });
}

module.exports = {
  notFoundMiddleware,
  errorMiddleware,
};
