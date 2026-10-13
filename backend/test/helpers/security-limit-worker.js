// Separate application instance sharing only the parent's isolated PostgreSQL schema.
const db=require('../../database');
const {createSecurityLimits}=require('../../services/securityLimits');
(async()=>{
  await db.ready;
  const limiter=createSecurityLimits(db),results=[];
  for(let i=0;i<Number(process.argv[4]||1);i++){
    const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(){return this;}};
    await limiter.check(res,process.argv[2],process.argv[3]);results.push(res.statusCode);
  }
  await db.close();process.send?.({results});
})().catch(async()=>{await db.close().catch(()=>{});process.exitCode=1;});
