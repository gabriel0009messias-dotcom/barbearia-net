// Composition only. The existing createEvolutionDelivery is the sole transport.
async function composeMessage(db, reminderId, { schema = process.env.DATABASE_SCHEMA || 'salaoflix' } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid return schema');
  const s = '"' + schema + '"';
  const row = await db.getAsync(`SELECT ${s}.studiofy_return_message_text(r) AS text FROM ${s}.return_reminders r
    WHERE id=$1 AND transport_protocol='outbox_v1' AND historical_snapshot_status='captured'`, [reminderId]);
  if (!row?.text) throw new Error('Historical return snapshot unavailable');
  return row.text;
}
module.exports = { composeMessage };
