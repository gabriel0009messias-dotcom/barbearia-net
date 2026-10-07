const {Pool}=require('pg');
const {createPublicLimiter}=require('../../services/publicLimits');
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${process.env.DATABASE_SCHEMA},public`});
(async()=>{
 const db={getAsync:async(q,p)=>(await pool.query(q,p)).rows[0],runAsync:(q,p)=>pool.query(q,p)};
 const limiter=createPublicLimiter(db,'collective-worker',{limit:35,windowMs:86400000});let accepted=0,limited=0;
 await Promise.all(Array.from({length:20},async(_,i)=>{
  const res={headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(){if(this.code!==429||!Number(this.headers['Retry-After']))throw Error('Unexpected limit');limited++;}};
  await limiter({ip:`192.0.2.${i}`,socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':`198.51.100.${i}`}},res,()=>accepted++);
 }));process.send({accepted,limited});
})().catch(()=>{process.exitCode=1;}).finally(()=>pool.end());
