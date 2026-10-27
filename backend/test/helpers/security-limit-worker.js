// Separate application instance sharing only the parent's isolated PostgreSQL schema.
const db=require('../../database');
const {createTracedSecurityLimits}=require('./securityLimitTrace');
(async()=>{
  await db.ready;
  const limiter=createTracedSecurityLimits(db,{namespace:new URL(process.env.DATABASE_URL).pathname+':'+process.env.DATABASE_SCHEMA}),results=[];
  for(let i=0;i<Number(process.argv[4]||1);i++){
    const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(){return this;}};
    await limiter.check(res,process.argv[2],process.argv[3]);results.push(res.statusCode);
  }
  await db.close();process.send?.({results,trace:limiter.decisionTrace()});
})().catch(async()=>{await db.close().catch(()=>{});process.exitCode=1;});
