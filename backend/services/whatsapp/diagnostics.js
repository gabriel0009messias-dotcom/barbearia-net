const EVENTS = new Set(['inbound_received','inbound_persisted','conversation_flow_started','inbound_rejected','inbound_ignored','inbound_routed','conversation_transition','outbox_worker_started','outbox_result','delivery_started','delivery_accepted']);
const REASONS = new Set(['unauthorized','unsupported_event','outgoing_or_missing_direction','non_private_chat','unsupported_envelope',
  'processed','duplicate','awaiting_delivery','invalid_event','ownership_invalid','event_identity_mismatch','pending_identity_mismatch',
  'pending_missing_account','pending_ownership_changed','pending_payment_required','payment_required','legacy_event','future_event',
  'pending_missing_conversation','pending_expired','pending_obsolete','captured_obsolete','pending_delivery_failed','delivery_failed',
  'stale_revision','stale_event','confirmation_repeat','clarification_requested','greeting_coalesced']);
const STEPS = new Set(['ASK_NAME','MENU','SERVICE','PRICES','PROFESSIONAL','DATE','TIME','NAME','REVIEW','EDIT','INFO','OBSERVATION','THIRD_PARTY_NAME','CANCEL','CANCEL_REVIEW','COMPLETE']);
function diagnostic(event, fields = {}) {
  if (!EVENTS.has(event)) return;
  const safe = { event };
  for (const key of ['instanceHash','eventHash']) if (/^[a-f0-9]{16}$/.test(fields[key] || '')) safe[key] = fields[key];
  if (fields.type === 'MESSAGES_UPSERT') safe.type = fields.type;
  if (REASONS.has(fields.reason)) safe.reason = fields.reason;
  if (STEPS.has(fields.step)) safe.step = fields.step;
  if (['pending','sending','sent','failed','uncertain','missing',401,503].includes(fields.status)) safe.status = fields.status;
  if (/^[1-9][0-9]{0,15}$/.test(fields.deliveryId || '')) safe.deliveryId = fields.deliveryId;
  console.info('[WhatsApp]', JSON.stringify(safe));
}
module.exports = { diagnostic };
