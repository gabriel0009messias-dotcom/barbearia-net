const crypto = require('node:crypto');
const { createEvolutionOwnershipResolver } = require('../evolutionOwnership');
const { avaliarAcessoAssinatura } = require('../access');
const { transition, normalize } = require('./conversationFlow');
const { capture, fingerprint } = require('./conversationCapture');
const reference = () => crypto.randomBytes(8).toString('hex');
const globalCommands = new Set(['oi','ola','bom dia','boa tarde','boa noite','menu','inicio','recomecar']);
// Suspicion boundary only, never a delay or a deduplication TTL. Inbound
// timestamps have second precision; adjacent timestamp buckets may overlap it.
const BURST_MS = 1000;
const choice = input => /^[1-9]\d*$/.test(input) || ['sim','confirmar','agendar','realizar agendamento','agendamento','precos','preco','endereco','cancelar','cancelar agendamento'].includes(normalize(input));
const canonical = value => JSON.stringify(value, (_key,v) => v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const plain = value => String(value || '').replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
function description(state,input) {
  const item=/^[1-9]\d*$/.test(input) ? state.options?.[Number(input)-1] : null;
  if(item) return typeof item==='string' ? plain(item) : plain(item.nome || item.servico_nome);
  if(state.step==='MENU') return ({'1':'Realizar agendamento','2':'Preços','3':'Endereço','4':'Cancelar agendamento'})[input];
  if(state.step==='EDIT') return ({'1':'alterar o serviço','2':'alterar o profissional','3':'alterar o dia','4':'alterar o horário','5':'alterar o nome'})[input];
  if(['REVIEW','CANCEL_REVIEW'].includes(state.step) && ['1','sim','confirmar'].includes(normalize(input))) return state.step==='REVIEW'?'confirmar este agendamento':'confirmar este cancelamento';
  if(state.step==='REVIEW') return ({'2':'alterar uma escolha','3':'recomeçar'})[input];
  return null;
}
function createConversationProcessor(database) {
  async function processCaptured(identity, resume=false) {
    let committedTransition;
    const outcome = await database.transaction(async db => {
      // Admission committed before entering this transaction or waiting for its
      // locks. A crash here leaves the original event available to the worker.
      await db.runAsync(`INSERT INTO whatsapp_conversation_inbox(instance_key,message_id,assinatura_id,owner_epoch,fingerprint,decision,
        sender,event_timestamp,received_at,capture_context,captured_event)
        SELECT instance_key,message_id,assinatura_id,owner_epoch,fingerprint,'captured',sender,event_timestamp,received_at,capture_context,captured_event
        FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2 AND decision='captured'
        AND EXISTS(SELECT 1 FROM assinaturas a WHERE a.id=whatsapp_conversation_captures.assinatura_id)
        ON CONFLICT(instance_key,message_id) DO NOTHING`,[identity.instance_key,identity.message_id]);
      const receipt=await db.getAsync('SELECT * FROM whatsapp_conversation_inbox WHERE instance_key=$1 AND message_id=$2 FOR UPDATE',[identity.instance_key,identity.message_id]);
      if(!receipt) await db.runAsync("UPDATE whatsapp_conversation_captures SET decision='pending_missing_account',captured_event=NULL WHERE instance_key=$1 AND message_id=$2 AND decision='captured'",[identity.instance_key,identity.message_id]);
      if(!receipt || !['captured','awaiting_delivery'].includes(receipt.decision)) return {ok:true,duplicate:true};
      if(receipt.decision==='awaiting_delivery' && !resume) return {ok:true,duplicate:true,pending:true};
      const wasPending=receipt.decision==='awaiting_delivery';
      const event=receipt.captured_event || {...receipt.pending_event,phone:receipt.sender,messageId:receipt.message_id};
      const decide=async decision=>{
        await db.runAsync('UPDATE whatsapp_conversation_inbox SET decision=$1,pending_event=NULL,captured_event=NULL,completed_at=clock_timestamp() WHERE instance_key=$2 AND message_id=$3',[decision,receipt.instance_key,receipt.message_id]);
        await db.runAsync('UPDATE whatsapp_conversation_captures SET decision=$1,captured_event=NULL WHERE instance_key=$2 AND message_id=$3',[decision,receipt.instance_key,receipt.message_id]);
        return {ok:true,...(decision==='processed'?{}:{ignored:true,reason:decision})};
      };
      if(!event || fingerprint(event)!==receipt.fingerprint || event.phone!==receipt.sender) return decide('pending_identity_mismatch');
      const instance=event.instance, key=receipt.instance_key;
      const schema=(await db.getAsync('SELECT current_schema() AS name')).name;
      if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid conversation schema');
      const registry=`"${schema}".evolution_instance_owners`;
      const hint=await db.getAsync(`SELECT * FROM ${registry} WHERE instance_key=$1 COLLATE "C"`,[key]);
      if(!hint || hint.model!=='principal' || hint.source_schema!==schema || !/^[1-9]\d*$/.test(hint.owner_id) || !Number.isSafeInteger(Number(hint.owner_id))) return decide('pending_ownership_changed');
      const tenant=Number(hint.owner_id);
      if(receipt.assinatura_id!==tenant || receipt.owner_epoch!==hint.conversation_epoch) return decide('pending_ownership_changed');
      // Same serialized processing/source-first ownership lock order as 021.
      // Admission has already committed and holds none of these locks.
      const account=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1 FOR UPDATE',[tenant]);
      const owner=await db.getAsync(`SELECT * FROM ${registry} WHERE instance_key=$1 COLLATE "C" FOR SHARE`,[key]);
      if(!account || !owner || owner.model!=='principal' || owner.source_schema!==schema || owner.owner_id!==String(tenant) || owner.instance_name!==instance || owner.conversation_epoch!==hint.conversation_epoch) return decide('pending_ownership_changed');
      try { await createEvolutionOwnershipResolver(db,{schema}).resolve(tenant,{expectedInstance:instance}); }
      catch { return decide('ownership_invalid'); }
      if(!avaliarAcessoAssinatura(account).liberado) return decide(wasPending?'pending_payment_required':'payment_required');
      if(await db.getAsync('SELECT id FROM whatsapp_messages WHERE instance=$1 AND message_id=$2',[instance,event.messageId])) return decide('legacy_event');
      const now=new Date((await db.getAsync('SELECT clock_timestamp() AS now')).now);
      if(event.timestamp && event.timestamp>Math.floor(now.getTime()/1000)+60) return decide('future_event');
      let conversation=await db.getAsync('SELECT * FROM whatsapp_conversations WHERE assinatura_id=$1 AND instance_key=$2 AND sender=$3 FOR UPDATE',[tenant,key,event.phone]);
      const expired=conversation && new Date(conversation.expires_at)<=now;
      const reassociated=conversation && conversation.owner_epoch!==owner.conversation_epoch;
      const observed=receipt.capture_context;
      if(wasPending) {
        if(!conversation) return decide('pending_missing_conversation');
        if(expired) return decide('pending_expired');
        if(reassociated) return decide('pending_ownership_changed');
        // Pre-022 pending rows retain their original strict 021 correlation.
        if((!observed && (conversation.id!==receipt.conversation_id || conversation.version!==receipt.expected_version || conversation.reference!==receipt.expected_reference || conversation.last_response_id!==receipt.expected_response_id)) || conversation.state.step!==receipt.expected_step) return decide('pending_obsolete');
      }
      const first=!conversation;
      if(first) {
        if(observed?.conversation_id) return decide('pending_missing_conversation');
        await db.runAsync(`INSERT INTO whatsapp_conversations(assinatura_id,instance_key,owner_epoch,sender,reference) VALUES($1,$2,$3,$4,$5)`,[tenant,key,owner.conversation_epoch,event.phone,reference()]);
        conversation=await db.getAsync('SELECT * FROM whatsapp_conversations WHERE assinatura_id=$1 AND instance_key=$2 AND sender=$3 FOR UPDATE',[tenant,key,event.phone]);
      }
      let input=event.text.trim(), supplied=event.reference || null;
      const qualified=input.match(/\s+([a-f0-9]{16})$/i);
      if(qualified) { supplied=qualified[1].toLowerCase();input=input.slice(0,qualified.index).trim(); }
      // The visual adapter uses the logical question UUID, never a naked
      // reusable row/button ID as authorization to answer a later question.
      const structured=input.match(/^sf:([a-f0-9-]{36}):([0-9]{1,2}|menu|mais|anterior|confirmar|agendar)$/i);
      if(structured) input=structured[2].toLowerCase();
      const command=normalize(input), restart=globalCommands.has(command);
      const currentPrompt=conversation.last_response_id ? await db.getAsync('SELECT status,response,sent_at FROM whatsapp_messages WHERE id=$1 AND assinatura_id=$2',[conversation.last_response_id,tenant]) : null;
      let stale=supplied && supplied!==conversation.reference ? 'stale_revision' : null, explicit=false;
      if(structured) {
        if(structured[1]===conversation.question_id) explicit=true;
        else stale='stale_revision';
      }
      if(event.replyTo || event.quotedText || event.hasReplyContext) {
        const bindings=await db.allAsync(`SELECT r.delivery_id,r.reference,r.question_id FROM whatsapp_conversation_responses r
          JOIN whatsapp_messages m ON m.id=r.delivery_id AND m.assinatura_id=r.assinatura_id
          WHERE r.assinatura_id=$1 AND r.conversation_id=$2 AND r.owner_epoch=$3
          AND ${event.replyTo?'r.provider_message_id=$4':'m.response=$4'}`,[tenant,conversation.id,owner.conversation_epoch,event.replyTo || event.quotedText || '']);
        explicit=bindings.length===1 && bindings[0].question_id===conversation.question_id;
        if(!explicit) stale='stale_revision';
      } else if(supplied && supplied===conversation.reference) explicit=true;
      if(!first && event.timestamp && event.timestamp<Math.floor(new Date(conversation.question_started_at).getTime()/1000)) stale='stale_event';
      // Captured observations never move forward to another logical question.
      // A re-prompt can change delivery/reference/version without changing it.
      if(!first && !expired && !reassociated && observed && (observed.conversation_id!==conversation.id || observed.question_id!==conversation.question_id) && !(restart && !stale)) return decide(wasPending?'pending_obsolete':'captured_obsolete');
      let next, decision='processed', questionId=conversation.question_id;
      let clarification=conversation.clarification, guard=conversation.input_guard;
      let acceptedInput=input, forceQuestion=false, accepted=false;
      const promptText=(currentPrompt?.response || 'Digite MENU para começar novamente.').replace(/^(?:(?:Essa opção pertence a uma etapa anterior\. Escolha uma das opções da mensagem mais recente\.|Não encontrei essa opção\. Escolha uma das opções abaixo:)\n\n)+/,'');
      if(first || expired || reassociated || restart && !stale) {
        conversation.state={step:'MENU'};conversation.owner_epoch=owner.conversation_epoch;
        next=await transition(db,account,conversation,'menu',now);
        clarification=null;guard={};forceQuestion=true;
        if(expired) next.text='Sua conversa expirou. Vamos começar novamente.\n'+next.text;
        if(reassociated) next.text='O contexto do atendimento mudou. Comece novamente.\n'+next.text;
      } else {
        if(conversation.last_response_id && currentPrompt?.status!=='sent') {
          if(!currentPrompt || currentPrompt.status==='failed') return decide(wasPending?'pending_delivery_failed':'delivery_failed');
          if(wasPending) return {ok:true,pending:true,reason:'awaiting_delivery'};
          await db.runAsync(`UPDATE whatsapp_conversation_inbox SET decision='awaiting_delivery',conversation_id=$1,
            expected_version=$2,expected_reference=$3,expected_response_id=$4,expected_step=$5,
            pending_event=$6::jsonb,pending_at=clock_timestamp() WHERE instance_key=$7 AND message_id=$8`,
            [conversation.id,conversation.version,conversation.reference,conversation.last_response_id,conversation.state.step,JSON.stringify(event),key,event.messageId]);
          return {ok:true,pending:true,reason:'awaiting_delivery'};
        }
        if(stale) {
          decision=stale;next={state:conversation.state,text:'Essa opção pertence a uma etapa anterior. Escolha uma das opções da mensagem mais recente.\n\n'+promptText};
        } else if(conversation.state.step==='COMPLETE' && choice(command)) {
          return decide('confirmation_repeat');
        } else if(clarification) {
          if(['confirmar','sim'].includes(command)) {
            acceptedInput=clarification.input;
            next=await transition(db,account,conversation,acceptedInput,now);
            clarification=null;accepted=!next.invalid;forceQuestion=true;
          } else if(command==='voltar' || input==='0') {
            next={state:conversation.state,text:clarification.return_text};
            clarification=null;guard={};forceQuestion=true;
          } else next={state:conversation.state,text:promptText};
        } else {
          const label=description(conversation.state,input);
          const received=new Date(receipt.received_at).getTime(), last=Date.parse(guard.at);
          const nearby=Number.isFinite(last) && Math.abs(received-last)<=BURST_MS;
          const providerNearby=event.timestamp && guard.timestamp && Math.abs(event.timestamp-guard.timestamp)<=1;
          const changedQuestion=guard.question_id && guard.question_id!==conversation.question_id;
          // Waiting for delivery does not make an unseen question observable.
          // Preserve that fact from admission, even if transport/restart takes
          // longer than the suspicion window and the provider has no timestamp.
          const unseenQuestion=observed && observed.question_id===conversation.question_id && observed.status!=='sent' && observed.question_delivered!==true;
          // 1/2 can be a correction of the old menu, not an answer to services.
          if(!explicit && label && choice(input) && changedQuestion && (nearby || providerNearby || unseenQuestion)) {
            clarification={input,return_text:promptText};forceQuestion=true;
            next={state:conversation.state,text:`Recebi duas respostas próximas. Você quer selecionar ${plain(label)}?\nResponda confirmar ou voltar.`};
            decision='clarification_requested';
          } else {
            acceptedInput=['sim','confirmar'].includes(command) && ['REVIEW','CANCEL_REVIEW'].includes(conversation.state.step)?'1':input;
            next=await transition(db,account,conversation,acceptedInput,now);accepted=!next.invalid;
          }
        }
        if(next.invalid) next={state:conversation.state,text:'Não encontrei essa opção. Escolha uma das opções abaixo:\n\n'+promptText};
      }
      const semanticChange=canonical(next.state)!==canonical(conversation.state);
      if(forceQuestion || semanticChange) questionId=crypto.randomUUID();
      if(accepted && semanticChange) guard=choice(acceptedInput)?{question_id:conversation.question_id,at:new Date(receipt.received_at).toISOString(),timestamp:event.timestamp || null}:{};
      const ref=reference();let responseId=null;
      if(next.text!==null) {
        const response=await db.runAsync(`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,conversation_managed) VALUES($1,$2,$3,$4,$5,true)`,[tenant,instance,event.phone,event.messageId,next.text]);
        responseId=response.lastID;
        await db.runAsync(`INSERT INTO whatsapp_conversation_responses(delivery_id,assinatura_id,conversation_id,owner_epoch,reference,question_id) VALUES($1,$2,$3,$4,$5,$6)`,[responseId,tenant,conversation.id,owner.conversation_epoch,ref,questionId]);
      }
      await db.runAsync(`UPDATE whatsapp_conversations SET owner_epoch=$1,state=$2::jsonb,reference=$3,version=version+1,last_response_id=$4,
        updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 minutes',
        question_started_at=CASE WHEN question_id<>$6::uuid THEN clock_timestamp() ELSE question_started_at END,
        question_id=$6,input_guard=$7::jsonb,clarification=$8::jsonb WHERE id=$5`,
        [owner.conversation_epoch,JSON.stringify(next.state),ref,responseId,conversation.id,questionId,JSON.stringify(guard),clarification?JSON.stringify(clarification):null]);
      committedTransition={step:next.state.step,reason:decision};
      return {...await decide(decision),...(next.appointmentId?{appointmentId:next.appointmentId}:{})};
    });
    if(committedTransition) require('./diagnostics').diagnostic('conversation_transition',committedTransition);
    return outcome;
  }
  async function process(event) {
    const admitted=await capture(database,event);
    return admitted.row?processCaptured(admitted.row):admitted;
  }
  async function consumePending({limit=50}={}) {
    if(!Number.isInteger(limit) || limit<1 || limit>200) throw Error('Invalid pending input limit');
    const rows=await database.allAsync(`SELECT i.instance_key,i.message_id,i.received_at FROM whatsapp_conversation_inbox i
      LEFT JOIN whatsapp_conversations c ON c.id=i.conversation_id AND c.assinatura_id=i.assinatura_id
      LEFT JOIN whatsapp_messages m ON m.id=c.last_response_id AND m.assinatura_id=i.assinatura_id
      LEFT JOIN evolution_instance_owners o ON o.instance_key=i.instance_key COLLATE "C"
      WHERE i.decision='captured' OR (i.decision='awaiting_delivery' AND (
        m.status IN ('sent','failed') OR m.id IS NULL OR c.id IS NULL OR c.expires_at<=clock_timestamp()
        OR (i.capture_context IS NULL AND (c.version<>i.expected_version OR c.reference<>i.expected_reference OR c.last_response_id IS DISTINCT FROM i.expected_response_id))
        OR (i.capture_context IS NOT NULL AND c.question_id::text IS DISTINCT FROM i.capture_context->>'question_id')
        OR c.state->>'step'<>i.expected_step OR c.owner_epoch<>i.owner_epoch OR o.conversation_epoch IS DISTINCT FROM i.owner_epoch
        OR o.model<>'principal' OR o.owner_id<>i.assinatura_id::text))
      UNION ALL
      SELECT a.instance_key,a.message_id,a.received_at FROM whatsapp_conversation_captures a
      WHERE a.decision='captured' AND NOT EXISTS(SELECT 1 FROM whatsapp_conversation_inbox i WHERE i.instance_key=a.instance_key AND i.message_id=a.message_id)
      ORDER BY received_at,instance_key,message_id LIMIT $1`,[limit]);
    const results=[];
    for(const row of rows) results.push(await processCaptured(row,true));
    return results;
  }
  return {process,capture:event=>capture(database,event),consumePending};
}
async function validateConversationResponse(db,row) {
  const binding=await db.getAsync(`SELECT r.*,c.owner_epoch AS current_epoch,c.reference AS current_reference,c.last_response_id,
    c.instance_key,c.sender,c.expires_at FROM whatsapp_conversation_responses r
    JOIN whatsapp_conversations c ON c.id=r.conversation_id AND c.assinatura_id=r.assinatura_id WHERE r.delivery_id=$1`,[row.id]);
  if(!binding) return row.conversation_managed!==true;
  const owner=await db.getAsync('SELECT conversation_epoch FROM evolution_instance_owners WHERE instance_key=$1 COLLATE "C"',[binding.instance_key]);
  const clock=(await db.getAsync('SELECT clock_timestamp() AS now')).now;
  return binding.assinatura_id===row.assinatura_id && binding.sender===row.phone &&
    binding.owner_epoch===binding.current_epoch && binding.owner_epoch===owner?.conversation_epoch &&
    binding.reference===binding.current_reference && binding.last_response_id===row.id && new Date(binding.expires_at)>new Date(clock);
}
module.exports={createConversationProcessor,validateConversationResponse};
