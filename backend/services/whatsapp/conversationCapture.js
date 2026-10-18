const crypto = require('node:crypto');
const { normalizeInstanceName } = require('../evolutionOwnership');
const { normalizeBrazilianDestination } = require('./phone');

const fingerprint = event => crypto.createHash('sha256').update(JSON.stringify([event.phone,event.text,event.reference || null,event.timestamp || null,event.replyTo || null,event.quotedText || null,Boolean(event.hasReplyContext)])).digest('hex');
function validEvent(event) {
  if (!event || typeof event !== 'object') return false;
  let instance; try { instance = normalizeInstanceName(event.instance); } catch { return false; }
  return Boolean(instance && instance === event.instance && normalizeBrazilianDestination(event.phone) === event.phone &&
    typeof event.messageId === 'string' && event.messageId.length > 0 && event.messageId.length <= 200 &&
    typeof event.text === 'string' && event.text.trim() && event.text.length <= 2000 &&
    (event.timestamp == null || Number.isSafeInteger(event.timestamp) && event.timestamp > 0));
}
const envelope = event => ({instance:event.instance,phone:event.phone,messageId:event.messageId,text:event.text,
  reference:event.reference || null,timestamp:event.timestamp || null,replyTo:event.replyTo || null,
  quotedText:event.quotedText || null,hasReplyContext:Boolean(event.hasReplyContext)});

async function capture(database, event) {
  if (!validEvent(event)) return {ok:true,ignored:true,reason:'invalid_event'};
  const key=event.instance.toLowerCase(), digest=fingerprint(event);
  let row=await database.getAsync('SELECT * FROM whatsapp_conversation_inbox WHERE instance_key=$1 AND message_id=$2',[key,event.messageId]);
  if (!row) row=await database.getAsync('SELECT * FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2',[key,event.messageId]);
  if (!row) {
    // Autocommit admission, BEFORE transaction()/the processing advisory lock.
    // MATERIALIZED freezes the MVCC observation and database time before
    // unique-index waits. No FK/account/conversation/ownership lock is taken.
    await database.runAsync(`WITH observation AS MATERIALIZED (
      SELECT o.owner_id::bigint AS tenant,o.conversation_epoch AS epoch,clock_timestamp() AS arrived,
        jsonb_build_object('conversation_id',c.id,'question_id',c.question_id,'step',c.state->>'step',
          'response_id',c.last_response_id,'status',m.status,'sent_at',m.sent_at,
          'question_delivered',EXISTS(SELECT 1 FROM whatsapp_conversation_responses r
            JOIN whatsapp_messages sent ON sent.id=r.delivery_id AND sent.assinatura_id=r.assinatura_id
            WHERE r.conversation_id=c.id AND r.assinatura_id=c.assinatura_id
              AND r.owner_epoch=c.owner_epoch AND r.question_id=c.question_id AND sent.status='sent')) AS context
      FROM evolution_instance_owners o
      LEFT JOIN whatsapp_conversations c ON c.assinatura_id=o.owner_id::bigint AND c.instance_key=o.instance_key AND c.sender=$3
      LEFT JOIN whatsapp_messages m ON m.id=c.last_response_id AND m.assinatura_id=c.assinatura_id
      WHERE o.instance_key=$1 COLLATE "C" AND o.instance_name=$4 AND o.model='principal'
        AND o.source_schema=current_schema() AND o.owner_id ~ '^[1-9][0-9]{0,14}$')
      INSERT INTO whatsapp_conversation_captures(instance_key,message_id,assinatura_id,owner_epoch,fingerprint,decision,
        sender,event_timestamp,received_at,capture_context,captured_event)
      SELECT $1,$2,tenant,epoch,$5,'captured',$3,$6,arrived,context,$7::jsonb FROM observation
      ON CONFLICT(instance_key,message_id) DO NOTHING`,[key,event.messageId,event.phone,event.instance,digest,event.timestamp || null,JSON.stringify(envelope(event))]);
    row=await database.getAsync('SELECT * FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2',[key,event.messageId]);
  }
  if (!row) return {ok:true,ignored:true,reason:'ownership_invalid'};
  if (row.fingerprint!==digest) return {ok:true,ignored:true,duplicate:true,reason:'event_identity_mismatch'};
  return {row};
}
module.exports={capture,fingerprint};
