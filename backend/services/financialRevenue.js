const { financialSummary, financialPeriod, periodTotal } = require('./finance');

// Also protect failures in the existing authentication middleware, before queries.
// Scope this response policy to /faturamento; other modules keep their behavior.
function financialResponse(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const json = res.json.bind(res);
  res.json = payload => json(res.statusCode >= 500
    ? { error: 'Não foi possível consultar o faturamento.' } : payload);
  next();
}

// Authentication runs before this handler; the browser never chooses the tenant.
function financialRevenue(db, clock = () => new Date()) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let selector, now;
    try {
      now = clock();
      selector = financialPeriod(req.query, now);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.statusCode === 400
        ? error.message : 'Não foi possível consultar o faturamento.' });
    }
    try {
      const rows = await db.allAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1', [req.assinatura.id]);
      const summary = financialSummary(rows, now);
      return res.json({ total: periodTotal(summary, selector) / 100 });
    } catch {
      // Never expose database messages or appointment data in responses/logs.
      return res.status(500).json({ error: 'Não foi possível consultar o faturamento.' });
    }
  };
}

module.exports = { financialRevenue, financialResponse };
