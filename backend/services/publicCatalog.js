const SERVICE_FIELDS=Object.freeze(['id','nome','descricao','preco','duracao','foto','categoria']);
function publicService(row){
 const result={};
 for(const field of SERVICE_FIELDS){
  const value=row[field];
  if(value===null || ['string','number','boolean'].includes(typeof value))result[field]=value;
 }
 return result;
}
function publicProfessional(row){
 return {id:row.id,nome:typeof row.nome==='string'?row.nome:'',
  servicos:Array.isArray(row.servicos)?row.servicos.filter(id=>Number.isSafeInteger(id)&&id>0):[]};
}
module.exports={publicService,publicProfessional};
