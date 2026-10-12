const {Pool}=require('pg');
const {createPublicLimiter}=require('../../services/publicLimits');
if(!process.env.TEST_DATABASE_URL)throw Error('Test database required');
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${process.env.DATABASE_SCHEMA},public`});
Date.now=()=>Number(process.env.STATUS_TEST_CLOCK);
(async()=>{
 const db={getAsync:async(q,p)=>(await pool.query(q,p)).rows[0],runAsync:(q,p)=>pool.query(q,p)};
 const scope=process.env.STATUS_TEST_SCOPE,context=scope==='subscriptionStatus'?{tenantId:process.env.STATUS_TEST_TENANT}:undefined;
 const limiter=createPublicLimiter(db,scope);let accepted=0,limited=0;
 for(let i=0;i<3;i++){
  const res={set(){return this;},status(n){this.code=n;return this;},json(){if(this.code!==429)throw Error('Unexpected response');}};
  if(await limiter.check(res,context))accepted++;else limited++;
 }
 process.send({accepted,limited});
})().catch(()=>{process.exitCode=1;}).finally(()=>pool.end());
