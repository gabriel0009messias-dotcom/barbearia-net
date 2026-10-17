const crypto = require('node:crypto');
const { normalizeInstanceName, createEvolutionOwnershipResolver } = require('../evolutionOwnership');
const { normalizeBrazilianDestination } = require('./phone');
const { avaliarAcessoAssinatura } = require('../access');
const { transition, normalize } = require('./conversationFlow');
const reference = () => crypto.randomBytes(8).toString('hex');
const fingerprint = event => crypto.createHash('sha256').update(JSON.stringify([event.phone,event.text,event.reference || null,event.timestamp || null,event.replyTo || null,event.quotedText || null,Boolean(event.hasReplyContext)])).digest('hex');
const globalCommands = new Set(['oi','ola','bom dia','boa tarde','boa noite','menu','inicio','recomecar']);

function createConversationProcessor(database) {
  async function processEvent(event, resume = null) {
    let instance;
    try { instance = normalizeInstanceName(event.instance); } catch { return {ok:true,ignored:true,reason:'invalid_instance'}; }
    if (!instance || instance!==event.instance || normalizeBrazilianDestination(event.phone)!==event.phone) return {ok:true,ignored:true,reason:'invalid_sender'};
    if(typeof event.messageId!=='string' || event.messageId.length<1 || event.messageId.length>200 || typeof event.text!=='string' || !event.text.trim() || event.text.length>2000) return {ok:true,ignored:true,reason:'invalid_event'};
    return database.transaction(async db => {
      // Resumption is internal only. The public process() never accepts a
      // caller-supplied receipt, revision or tenant override.
      const receipt=resume ? await db.getAsync('SELECT * FROM whatsapp_conversation_inbox WHERE instance_key=$1 AND message_id=$2 FOR UPDATE',[resume.instance_key,resume.message_id]) : null;
      if(resume && receipt?.decision!=='awaiting_delivery') return {ok:true,duplicate:true};
      const finishPending=async reason=>{
        if(!receipt) return {ok:true,ignored:true,reason};
        await db.runAsync('UPDATE whatsapp_conversation_inbox SET decision=$1,pending_event=NULL,completed_at=clock_timestamp() WHERE instance_key=$2 AND message_id=$3',[reason,receipt.instance_key,receipt.message_id]);
        return {ok:true,ignored:true,reason};
      };
      const schema = (await db.getAsync('SELECT current_schema() AS name')).name;
      if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid conversation schema');
      const registry = `"${schema}".evolution_instance_owners`, key = instance.toLowerCase();
      const hint = await db.getAsync(`SELECT * FROM ${registry} WHERE instance_key=$1 COLLATE "C"`,[key]);
      if(!hint || hint.model!=='principal' || hint.source_schema!==schema || !/^[1-9]\d*$/.test(hint.owner_id) || !Number.isSafeInteger(Number(hint.owner_id))) return finishPending(receipt?'pending_ownership_changed':'ownership_invalid');
      const tenant=Number(hint.owner_id);
      if(receipt && (receipt.assinatura_id!==tenant || receipt.owner_epoch!==hint.conversation_epoch)) return finishPending('pending_ownership_changed');
      // Same source-first lock order as ownership operations (018). Registry
      // lookup above is a hint only; authority is rechecked under source lock.
      const account=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1 FOR UPDATE',[tenant]);
      const owner=await db.getAsync(`SELECT * FROM ${registry} WHERE instance_key=$1 COLLATE "C" FOR SHARE`,[key]);
      if(!account || !owner || owner.model!=='principal' || owner.source_schema!==schema || owner.owner_id!==String(tenant) || owner.instance_name!==instance || owner.conversation_epoch!==hint.conversation_epoch) return finishPending(receipt?'pending_ownership_changed':'ownership_changed');
      try { await createEvolutionOwnershipResolver(db,{schema}).resolve(tenant,{expectedInstance:instance}); }
      catch { return finishPending(receipt?'pending_ownership_changed':'ownership_invalid'); }
      if(!avaliarAcessoAssinatura(account).liberado) return finishPending(receipt?'pending_payment_required':'payment_required');
      const digest=fingerprint(event), existing=await db.getAsync('SELECT * FROM whatsapp_conversation_inbox WHERE instance_key=$1 AND message_id=$2',[key,event.messageId]);
      if(existing && !receipt) return {ok:true,duplicate:true,...(existing.decision==='awaiting_delivery'?{pending:true}:{}),...(existing.fingerprint!==digest || existing.assinatura_id!==tenant || existing.owner_epoch!==owner.conversation_epoch?{ignored:true,reason:'event_identity_mismatch'}:{})};
      if(receipt && (receipt.fingerprint!==digest || receipt.sender!==event.phone)) return finishPending('pending_identity_mismatch');
      if(!receipt) await db.runAsync(`INSERT INTO whatsapp_conversation_inbox(instance_key,message_id,assinatura_id,owner_epoch,fingerprint,decision) VALUES($1,$2,$3,$4,$5,'processing')`,[key,event.messageId,tenant,owner.conversation_epoch,digest]);
      const decide=async decision=>{await db.runAsync('UPDATE whatsapp_conversation_inbox SET decision=$1,pending_event=NULL,completed_at=clock_timestamp() WHERE instance_key=$2 AND message_id=$3',[decision,key,event.messageId]);return {ok:true,...(decision==='processed'?{}:{ignored:true,reason:decision})};};
      if(await db.getAsync('SELECT id FROM whatsapp_messages WHERE instance=$1 AND message_id=$2',[instance,event.messageId])) return decide('legacy_event');
      const clock=(await db.getAsync('SELECT clock_timestamp() AS now')).now, now=new Date(clock);
      if(event.timestamp && event.timestamp>Math.floor(now.getTime()/1000)+60) return decide('future_event');
      let conversation=await db.getAsync('SELECT * FROM whatsapp_conversations WHERE assinatura_id=$1 AND instance_key=$2 AND sender=$3 FOR UPDATE',[tenant,key,event.phone]);
      const expired=conversation && new Date(conversation.expires_at)<=now;
      const reassociated=conversation && conversation.owner_epoch!==owner.conversation_epoch;
      if(receipt) {
        if(!conversation) return finishPending('pending_missing_conversation');
        if(expired) return finishPending('pending_expired');
        if(reassociated) return finishPending('pending_ownership_changed');
        if(conversation.id!==receipt.conversation_id || conversation.version!==receipt.expected_version || conversation.reference!==receipt.expected_reference || conversation.last_response_id!==receipt.expected_response_id || conversation.state.step!==receipt.expected_step) return finishPending('pending_obsolete');
      }
      const first=!conversation;
      if(first) {
        await db.runAsync(`INSERT INTO whatsapp_conversations(assinatura_id,instance_key,owner_epoch,sender,reference) VALUES($1,$2,$3,$4,$5)`,[tenant,key,owner.conversation_epoch,event.phone,reference()]);
        conversation=await db.getAsync('SELECT * FROM whatsapp_conversations WHERE assinatura_id=$1 AND instance_key=$2 AND sender=$3 FOR UPDATE',[tenant,key,event.phone]);
      }
      let input=event.text.trim(), supplied=event.reference || null;
      const qualified=input.match(/\s+([a-f0-9]{16})$/i);
      if(qualified) { supplied=qualified[1].toLowerCase();input=input.slice(0,qualified.index).trim(); }
      const command=normalize(input), restart=globalCommands.has(command);
      const currentPrompt = conversation.last_response_id ? await db.getAsync('SELECT status,response FROM whatsapp_messages WHERE id=$1 AND assinatura_id=$2',[conversation.last_response_id,tenant]) : null;
      let stale = supplied && supplied!==conversation.reference ? 'stale_revision' : null;
      if(event.replyTo || event.quotedText || event.hasReplyContext) {
        // Explicit replies must resolve to this sender, tenant, epoch and exact
        // active revision. Unknown/ambiguous context never falls back to bare input.
        const bindings=await db.allAsync(`SELECT r.delivery_id,r.reference FROM whatsapp_conversation_responses r
          JOIN whatsapp_messages m ON m.id=r.delivery_id AND m.assinatura_id=r.assinatura_id
          WHERE r.assinatura_id=$1 AND r.conversation_id=$2 AND r.owner_epoch=$3
          AND ${event.replyTo ? 'r.provider_message_id=$4' : 'm.response=$4'}`,
          [tenant,conversation.id,owner.conversation_epoch,event.replyTo || event.quotedText || '']);
        if(bindings.length!==1 || bindings[0].delivery_id!==conversation.last_response_id || bindings[0].reference!==conversation.reference) stale='stale_revision';
      }
      if(!first && event.timestamp && event.timestamp<Math.floor(new Date(conversation.updated_at).getTime()/1000)) stale='stale_event';
      let next;
      let decision='processed';
      const promptText=(currentPrompt?.response || 'Digite MENU para começar novamente.').replace(/^(?:(?:Essa opção pertence a uma etapa anterior\. Escolha uma das opções da mensagem mais recente\.|Não encontrei essa opção\. Escolha uma das opções abaixo:)\n\n)+/, '');
      if(first || expired || reassociated || restart && !stale) {
        conversation.state={step:'MENU'};conversation.owner_epoch=owner.conversation_epoch;
        next=await transition(db,account,conversation,'menu',now);
        if(expired)next.text='Sua conversa expirou. Vamos começar novamente.\n'+next.text;
        if(reassociated)next.text='O contexto do atendimento mudou. Comece novamente.\n'+next.text;
      }else {
        if(conversation.last_response_id && currentPrompt?.status!=='sent') {
          if(!currentPrompt || currentPrompt.status==='failed') return receipt?finishPending('pending_delivery_failed'):decide('delivery_failed');
          if(receipt) return {ok:true,pending:true,reason:'awaiting_delivery'};
          const pending={instance:event.instance,text:event.text,reference:event.reference || null,timestamp:event.timestamp || null,replyTo:event.replyTo || null,quotedText:event.quotedText || null,hasReplyContext:Boolean(event.hasReplyContext)};
          await db.runAsync(`UPDATE whatsapp_conversation_inbox SET decision='awaiting_delivery',sender=$1,conversation_id=$2,
            expected_version=$3,expected_reference=$4,expected_response_id=$5,expected_step=$6,event_timestamp=$7,
            pending_event=$8::jsonb,pending_at=clock_timestamp() WHERE instance_key=$9 AND message_id=$10`,
            [event.phone,conversation.id,conversation.version,conversation.reference,conversation.last_response_id,conversation.state.step,event.timestamp || null,JSON.stringify(pending),key,event.messageId]);
          return {ok:true,pending:true,reason:'awaiting_delivery'};
        }
        if(stale) {
          decision=stale;
          next={state:conversation.state,text:'Essa opção pertence a uma etapa anterior. Escolha uma das opções da mensagem mais recente.\n\n'+promptText};
        } else {
          // Unquoted input belongs ONLY to the locked current state/options.
          // No historical option lookup and no visible correlation code.
          next=await transition(db,account,conversation,input,now);
          if(next.invalid) next={state:conversation.state,text:'Não encontrei essa opção. Escolha uma das opções abaixo:\n\n'+promptText};
        }
      }
      const ref=reference();let responseId=null;
      if(next.text!==null) {
        const text=next.text;
        const response=await db.runAsync(`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,conversation_managed) VALUES($1,$2,$3,$4,$5,true)`,[tenant,instance,event.phone,event.messageId,text]);
        responseId=response.lastID;
        await db.runAsync(`INSERT INTO whatsapp_conversation_responses(delivery_id,assinatura_id,conversation_id,owner_epoch,reference) VALUES($1,$2,$3,$4,$5)`,[responseId,tenant,conversation.id,owner.conversation_epoch,ref]);
      }
      await db.runAsync(`UPDATE whatsapp_conversations SET owner_epoch=$1,state=$2::jsonb,reference=$3,version=version+1,last_response_id=$4,updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 minutes' WHERE id=$5`,[owner.conversation_epoch,JSON.stringify(next.state),ref,responseId,conversation.id]);
      return {...await decide(decision),...(next.appointmentId?{appointmentId:next.appointmentId}:{})};
    });
  }
  async function consumePending({limit=50}={}) {
    if(!Number.isInteger(limit) || limit<1 || limit>200) throw Error('Invalid pending input limit');
    // Scan only actionable entries. Uncertain/pending deliveries never spin or
    // starve ready entries behind them. Authority is rechecked under transaction.
    const rows=await database.allAsync(`SELECT i.* FROM whatsapp_conversation_inbox i
      LEFT JOIN whatsapp_conversations c ON c.id=i.conversation_id AND c.assinatura_id=i.assinatura_id
      LEFT JOIN whatsapp_messages m ON m.id=i.expected_response_id AND m.assinatura_id=i.assinatura_id
      LEFT JOIN evolution_instance_owners o ON o.instance_key=i.instance_key COLLATE "C"
      WHERE i.decision='awaiting_delivery' AND (
        m.status IN ('sent','failed') OR m.id IS NULL OR c.id IS NULL OR c.expires_at<=clock_timestamp()
        OR c.version<>i.expected_version OR c.reference<>i.expected_reference
        OR c.last_response_id IS DISTINCT FROM i.expected_response_id OR c.state->>'step'<>i.expected_step
        OR c.owner_epoch<>i.owner_epoch OR o.conversation_epoch IS DISTINCT FROM i.owner_epoch
        OR o.model<>'principal' OR o.owner_id<>i.assinatura_id::text)
      ORDER BY i.received_order LIMIT $1`,[limit]);
    const results=[];
    for(const row of rows) results.push(await processEvent({...row.pending_event,phone:row.sender,messageId:row.message_id},row));
    return results;
  }
  return {process:event=>processEvent(event),consumePending};
}
async function validateConversationResponse(db,row) {
  const binding=await db.getAsync(`SELECT r.*,c.owner_epoch AS current_epoch,c.reference AS current_reference,c.last_response_id,
    c.instance_key,c.sender,c.expires_at FROM whatsapp_conversation_responses r
    JOIN whatsapp_conversations c ON c.id=r.conversation_id AND c.assinatura_id=r.assinatura_id WHERE r.delivery_id=$1`,[row.id]);
  if(!binding) return row.conversation_managed!==true; // Legacy and 020 remain unchanged; missing conversational context fails closed.
  const owner=await db.getAsync('SELECT conversation_epoch FROM evolution_instance_owners WHERE instance_key=$1 COLLATE "C"',[binding.instance_key]);
  const clock=(await db.getAsync('SELECT clock_timestamp() AS now')).now;
  return binding.assinatura_id===row.assinatura_id && binding.sender===row.phone &&
    binding.owner_epoch===binding.current_epoch && binding.owner_epoch===owner?.conversation_epoch &&
    binding.reference===binding.current_reference && binding.last_response_id===row.id && new Date(binding.expires_at)>new Date(clock);
}
module.exports = { createConversationProcessor, validateConversationResponse };
