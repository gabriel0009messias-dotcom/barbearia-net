const {text,fail}=require('./studiofy');
const states=new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

async function profileInput(db,body) {
 const profile={};
 if(body.businessType!==undefined){
  profile.businessType=text(body.businessType,80);
  if(!await db.getAsync('SELECT code FROM business_types WHERE code=$1 AND active=true',[profile.businessType])) fail('Escolha um tipo de negócio disponível.');
 }
 for(const [key,max] of [['city',100],['address',250],['instagram',30]]) {
  if(body[key]!==undefined)profile[key]=text(body[key],max);
 }
 if(body.state!==undefined){
  profile.state=text(body.state,2).toUpperCase();
  if(profile.state && !states.has(profile.state))fail('Informe uma UF válida.');
 }
 if(profile.instagram!==undefined){
  profile.instagram=profile.instagram.replace(/^@/,'');
  if(profile.instagram && !/^[a-zA-Z0-9._]{1,30}$/.test(profile.instagram))fail('Informe somente o usuário do Instagram, sem link.');
 }
 return profile;
}
async function saveProfile(db,id,p) {
 await db.runAsync(`UPDATE assinaturas SET business_type_code=COALESCE($2,business_type_code),
  localizacao_cidade=COALESCE($3,localizacao_cidade),state_code=COALESCE($4,state_code),
  localizacao_rua=COALESCE($5,localizacao_rua),instagram_handle=COALESCE($6,instagram_handle) WHERE id=$1`,
 [id,p.businessType??null,p.city??null,p.state??null,p.address??null,p.instagram??null]);
}
function publicProfile(a){
 return {businessType:a.business_type_code||'other',city:a.localizacao_cidade||'',state:a.state_code||'',address:a.localizacao_rua||'',instagram:a.instagram_handle||''};
}
module.exports={profileInput,saveProfile,publicProfile};
