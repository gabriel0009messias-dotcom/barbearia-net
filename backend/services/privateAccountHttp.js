// Install before authentication. Keep internal failures out of responses without
// inspecting or logging request data or the original exception.
function privateAccountResponse(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  const json = res.json;
  res.json = function (payload) {
    return json.call(this, this.statusCode >= 500
      ? { error: 'Não foi possível concluir a solicitação.' }
      : payload);
  };
  next();
}

module.exports = { privateAccountResponse };
