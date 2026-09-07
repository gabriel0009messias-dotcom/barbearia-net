const clientRepository = require('../repositories/clientRepository');
const paymentRepository = require('../repositories/paymentRepository');
const { query } = require('../database/pool');

async function getAdminDashboard() {
  const [clients, revenue, recentPayments, upcomingDueDates] = await Promise.all([
    clientRepository.listClients({}),
    paymentRepository.getRevenueSummary(),
    paymentRepository.listRecentPayments(8),
    query(
      `SELECT c.nome_fantasia, s.next_due_date, s.access_status, p.nome AS plan_name
       FROM assinaturas s
       JOIN clientes c ON c.id = s.cliente_id
       JOIN planos p ON p.id = s.plano_id
       WHERE s.next_due_date IS NOT NULL
       ORDER BY s.next_due_date ASC
       LIMIT 8`
    ),
  ]);

  const counts = clients.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.access_status === 'active') acc.active += 1;
      if (item.access_status === 'blocked') acc.blocked += 1;
      if (item.access_status === 'grace') acc.grace += 1;
      if (item.access_status === 'pending') acc.pending += 1;
      return acc;
    },
    { total: 0, active: 0, blocked: 0, grace: 0, pending: 0 }
  );

  return {
    counts,
    revenue,
    recentPayments,
    upcomingDueDates: upcomingDueDates.rows,
    clients,
  };
}

module.exports = {
  getAdminDashboard,
};
