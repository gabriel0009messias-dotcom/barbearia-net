const crypto = require('node:crypto');
const BUCKETS = 4096;
const POLICIES = Object.freeze({
  ownerLogin: { limit: 20, windowMs: 300000 },
  adminLogin: { limit: 20, windowMs: 300000 },
  recoveryRequest: { limit: 10, windowMs: 900000 },
  recoveryStatus: { limit: 60, windowMs: 60000 },
  recoveryReset: { limit: 20, windowMs: 900000 },
  checkoutPassword: { limit: 20, windowMs: 300000 },
  checkoutOwner: { limit: 20, windowMs: 60000, private: true },
});
function createSecurityLimits(db) {
  let secretPromise;
  function secret() {
    if (!secretPromise) secretPromise = db.getAsync(`INSERT INTO configuracoes(chave,valor)
      VALUES ('security_limit_key_v1',$1) ON CONFLICT(chave) DO UPDATE SET valor=configuracoes.valor RETURNING valor`,
    [crypto.randomBytes(32).toString('hex')]).then(row => {
      if (!/^[a-f0-9]{64}$/.test(row?.valor || '')) throw Error('Invalid internal key');
      return row.valor;
    }).catch(error => { secretPromise = null; throw error; });
    return secretPromise;
  }
  async function budgetKey(scope, identity) {
    const policy = POLICIES[scope];
    if (!policy) throw Error('Invalid internal policy');
    let context;
    if (policy.private) {
      if (!Number.isSafeInteger(identity) || identity < 1) throw Error('Validated owner required');
      context = String(identity); // Caller supplies authenticated account, never raw route/body IDs.
    } else {
      const normalized = typeof identity === 'string' && identity.length <= 254 ? identity : 'invalid';
      context = String(crypto.createHmac('sha256', await secret()).update(normalized).digest().readUInt32BE(0) % BUCKETS);
    }
    return crypto.createHash('sha256').update(JSON.stringify(['security-budget:v1',scope,context])).digest('hex');
  }
  async function check(res, scope, identity) {
    res.set('Cache-Control','no-store');
    try {
      const policy=POLICIES[scope],key=await budgetKey(scope,identity);
      const result=await db.transaction(async store=>{
        const row=await store.getAsync(`WITH moment AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS at
        ), frame AS (
          SELECT at, (at / $2::bigint) * $2::bigint AS start FROM moment
        ) INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at)
          SELECT $1,start,1,to_timestamp((start+$2::bigint)/1000.0) FROM frame
          ON CONFLICT(key_hash,window_start) DO UPDATE
            SET hits=LEAST(public_request_limits.hits::bigint+1,$3::bigint+1)::integer
          RETURNING hits,ceil(extract(epoch FROM (expires_at-clock_timestamp())))::integer AS retry`,
        [key,policy.windowMs,policy.limit]);
        if (!Number.isSafeInteger(row?.hits) || row.hits < 1 || !Number.isSafeInteger(row.retry)) throw Error('Invalid internal counter');
        await store.runAsync(`DELETE FROM public_request_limits WHERE (key_hash,window_start) IN
          (SELECT key_hash,window_start FROM public_request_limits WHERE expires_at<=clock_timestamp() LIMIT 1000)`);
        return row;
      });
      if (result.hits > policy.limit) {
        res.set('Retry-After',String(Math.max(1,result.retry)));
        res.status(429).json({error:'Muitas tentativas. Aguarde antes de tentar novamente.'});
        return false;
      }
      return true;
    } catch {
      // No request, identity, original error or sensitive data is ever logged.
      res.set('Retry-After','5');
      res.status(503).json({error:'Nao foi possivel verificar esta solicitacao. Tente novamente em instantes.'});
      return false;
    }
  }
  return {check,budgetKey};
}
module.exports={createSecurityLimits,POLICIES,BUCKETS};
