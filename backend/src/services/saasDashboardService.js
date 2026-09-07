const { query } = require('../database/pool');
const subscriptionRepository = require('../repositories/saasSubscriptionRepository');

async function getDashboard(salonId) {
  const [today, upcoming, clients, revenue, topServices, subscription] = await Promise.all([
    query(
      `SELECT a.*, c.name AS client_name, s.name AS service_name, p.name AS professional_name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN services s ON s.id = a.service_id
       JOIN professionals p ON p.id = a.professional_id
       WHERE a.salon_id = $1 AND a.date = CURRENT_DATE
       ORDER BY a.start_time ASC`,
      [salonId]
    ),
    query(
      `SELECT a.*, c.name AS client_name, s.name AS service_name, p.name AS professional_name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN services s ON s.id = a.service_id
       JOIN professionals p ON p.id = a.professional_id
       WHERE a.salon_id = $1 AND a.date >= CURRENT_DATE
       ORDER BY a.date ASC, a.start_time ASC
       LIMIT 10`,
      [salonId]
    ),
    query('SELECT COUNT(*)::int AS total FROM clients WHERE salon_id = $1', [salonId]),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE salon_id = $1 AND status = 'APPROVED' AND DATE_TRUNC('month', COALESCE(paid_at, created_at)) = DATE_TRUNC('month', NOW())`,
      [salonId]
    ),
    query(
      `SELECT s.name, COUNT(*)::int AS total
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.salon_id = $1
       GROUP BY s.name
       ORDER BY total DESC, s.name ASC
       LIMIT 5`,
      [salonId]
    ),
    subscriptionRepository.findBySalonId(salonId),
  ]);

  return {
    appointments_today: today.rows,
    upcoming_appointments: upcoming.rows,
    total_clients: clients.rows[0]?.total || 0,
    monthly_revenue: Number(revenue.rows[0]?.total || 0),
    top_services: topServices.rows,
    subscription,
  };
}

module.exports = {
  getDashboard,
};
