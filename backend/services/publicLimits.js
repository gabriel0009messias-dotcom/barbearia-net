const crypto = require('node:crypto');

const POLICIES = Object.freeze({
 signup:{limit:600,windowMs:900000},
 booking:{limit:300,windowMs:900000,context:'tenant'},
 bookingGlobal:{limit:3000,windowMs:900000},
 navigation:{limit:1200,windowMs:60000,context:'tenant'},
 navigationGlobal:{limit:12000,windowMs:60000},
 reservationRead:{limit:240,windowMs:300000,context:'reservation'},
 reservationReadGlobal:{limit:12000,windowMs:300000},
 confirmationRecovery:{limit:60,windowMs:900000,context:'reservation'},
 confirmationRecoveryGlobal:{limit:3000,windowMs:900000},
 cancellation:{limit:30,windowMs:900000,context:'reservation'},
 cancellationGlobal:{limit:3000,windowMs:900000},
});
function contextId(value) {
 if (!['number','string','bigint'].includes(typeof value) ||
     (typeof value==='number' && !Number.isSafeInteger(value)) || !/^[1-9][0-9]*$/.test(String(value))) throw Error('Validated context required.');
 return String(value);
}
function budgetKey(scope,policy,context) {
 const identity=policy.context==='tenant' ? [contextId(context?.tenantId)] :
  policy.context==='reservation' ? [contextId(context?.tenantId),contextId(context?.reservationId)] : [];
 return crypto.createHash('sha256').update(JSON.stringify(['public-budget:v2',scope,...identity])).digest('hex');
}
function createPublicLimiter(db, scope, options = {}) {
 const policy={...POLICIES[scope],...options};
 if (!Number.isSafeInteger(policy.limit) || policy.limit<1 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs<1 ||
     ![undefined,'tenant','reservation'].includes(policy.context)) throw Error('Invalid rate-limit policy.');
 let lastCleanup=0;
 async function check(res,context,store=db){
  res.set('Cache-Control','no-store');
  try {
   const now=Date.now(),windowStart=Math.floor(now/policy.windowMs)*policy.windowMs,expiry=windowStart+policy.windowMs;
   const key=budgetKey(scope,policy,context);
   const row=await store.getAsync(`INSERT INTO public_request_limits (key_hash,window_start,hits,expires_at)
    VALUES ($1,$2,1,$3) ON CONFLICT (key_hash,window_start)
    DO UPDATE SET hits=LEAST(public_request_limits.hits::bigint+1,2147483647)::integer RETURNING hits`,[key,windowStart,new Date(expiry)]);
   if (now-lastCleanup>60000) {
    lastCleanup=now;
    await store.runAsync('DELETE FROM public_request_limits WHERE (key_hash,window_start) IN (SELECT key_hash,window_start FROM public_request_limits WHERE expires_at<$1 LIMIT 1000)',[new Date(now)]);
   }
   if (row.hits>policy.limit) {
    res.set('Retry-After',String(Math.max(1,Math.ceil((expiry-now)/1000))));
    res.status(429).json({error:'Muitas tentativas. Aguarde antes de tentar novamente.'});
    return false;
   }
   return true;
  } catch {
   res.set('Retry-After','5');
   res.status(503).json({error:'Não foi possível verificar esta solicitação. Tente novamente em instantes.'});
   return false;
  }
 }
 const middleware=async(_req,res,next)=>{if(await check(res))next();};
 middleware.check=check;
 return middleware;
}
module.exports={createPublicLimiter,POLICIES,budgetKey};
