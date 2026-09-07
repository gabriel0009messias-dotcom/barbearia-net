const { query } = require('../database/pool');

async function upsertStatus(salonId, payload) {
  const result = await query(
    `INSERT INTO whatsapp_sessions (salon_id, instance_name, status, qr_code, connected_phone, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (salon_id)
     DO UPDATE SET
       instance_name = EXCLUDED.instance_name,
       status = EXCLUDED.status,
       qr_code = EXCLUDED.qr_code,
       connected_phone = EXCLUDED.connected_phone,
       last_seen_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [salonId, payload.instanceName || null, payload.status, payload.qrCode || null, payload.connectedPhone || null]
  );

  return result.rows[0];
}

async function findBySalonId(salonId) {
  const result = await query('SELECT * FROM whatsapp_sessions WHERE salon_id = $1 LIMIT 1', [salonId]);
  return result.rows[0] || null;
}

module.exports = {
  upsertStatus,
  findBySalonId,
};
