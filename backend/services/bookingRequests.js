const crypto = require('node:crypto');
const { fail } = require('./studiofy');
const { createPublicBookings } = require('./publicBookings');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function requestIdentity(key, tenant, body) {
 if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail('Chave de confirmação inválida.');
 // Only the authoritative booking fields participate; mass-assignment is ignored.
 const fields = [String(body.nome_cliente ?? '').trim(), String(body.telefone ?? '').replace(/\D/g,''),
  Number(body.servico_id), Number(body.profissional_id), body.data, body.hora];
 return { keyHash:digest(key), requestHash:digest(JSON.stringify(fields)),
  token:digest(`studiofy:public-booking:v1:${tenant}:${key}`) };
}

// Must run inside the existing serialized booking transaction. The receipt,
// appointment and cancellation capability commit or roll back together.
async function confirmBooking(connection, studio, tenant, body, key) {
 if (key === undefined) {
  const booking = await studio.book(tenant, body), access = createPublicBookings(connection);
  const token = await access.issue(booking.id);
  return {token, agendamento:await access.get(token)};
 }
 const identity = requestIdentity(key, tenant, body);
 const prior = await connection.getAsync('SELECT request_hash,appointment_id FROM public_booking_requests WHERE assinatura_id=$1 AND key_hash=$2', [tenant,identity.keyHash]);
 const access = createPublicBookings(connection);
 if (prior) {
  if (prior.request_hash !== identity.requestHash) fail('Esta tentativa pertence a outros dados. Recupere a confirmação original.',409);
  // An identity change revokes access via the existing mechanism. Never reissue it.
  return {token:identity.token, agendamento:await access.get(identity.token)};
 }
 const booking = await studio.book(tenant, body);
 await access.issue(booking.id, identity.token);
 await connection.runAsync('INSERT INTO public_booking_requests (assinatura_id,key_hash,request_hash,appointment_id) VALUES ($1,$2,$3,$4)',[tenant,identity.keyHash,identity.requestHash,booking.id]);
 return {token:identity.token, agendamento:await access.get(identity.token)};
}
async function recoverBooking(connection,key,body,onValidated) {
 const identity=requestIdentity(key,0,body);
 const matches=await connection.allAsync('SELECT assinatura_id FROM public_booking_requests WHERE key_hash=$1 AND request_hash=$2 LIMIT 2',[identity.keyHash,identity.requestHash]);
 if(matches.length!==1){
  const error=Object.assign(Error('Não foi encontrada uma confirmação desta tentativa.'),{statusCode:404,publicCode:'CONFIRMATION_NOT_FOUND'});
  throw error;
 }
 const token=requestIdentity(key,matches[0].assinatura_id,body).token;
 // Same authority as the private reservation link, without creating anything.
 const access=createPublicBookings(connection);
 if(onValidated && !(await onValidated(await access.context(token))))return null;
 return {token,agendamento:await access.get(token)};
}
module.exports = { requestIdentity, confirmBooking, recoverBooking };
