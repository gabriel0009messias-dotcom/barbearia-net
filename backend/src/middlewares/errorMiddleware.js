function notFoundMiddleware(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada.' });
}

function errorMiddleware(error, req, res, next) {
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Erro interno do servidor.';

  if (statusCode >= 500) {
    console.error(error);
  }

  res.status(statusCode).json({ error: message });
}

module.exports = {
  notFoundMiddleware,
  errorMiddleware,
};
