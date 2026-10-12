// Never log request bodies, headers, error objects or parser messages.
function createHttpErrorHandler(logger=console){
 return (err,_req,res,next)=>{
  const invalidJson=err instanceof SyntaxError && err.status===400 && 'body' in err;
  const status=Number.isInteger(err.status) && err.status>=400 && err.status<=599 ? err.status : 500;
  logger.error('Erro HTTP',{type:invalidJson?'invalid_json':'request_error',status});
  if(res.headersSent)return next(err);
  res.set('Cache-Control','no-store');
  res.status(status).json({error:invalidJson?'JSON invalido na requisicao.':'Não foi possível concluir a solicitação.'});
 };
}
module.exports={createHttpErrorHandler};
