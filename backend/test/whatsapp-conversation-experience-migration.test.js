const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('026: official customer upgrade is additive, tenant-unique, repeatable and transactional',async t=>{
 const env=require('./helpers/postgres').testEnvironment(),directory=path.resolve(__dirname,'../database/migrations');
 const original=fs.readdirSync,discovery=t.mock.method(fs,'readdirSync',function(dir,...args){const files=original.call(this,dir,...args);return path.resolve(String(dir))===directory?files.filter(n=>n<'026_'):files;});
 const db=require('../database');try{await db.ready;}finally{discovery.mock.restore();}
 t.after(async()=>{await db.close();await env.cleanup();});const q=(s,a=[])=>db.pool.query(s,a);
 const legacy=(await q("INSERT INTO clientes(nome,telefone) VALUES('Legacy private name','5511999990001') RETURNING *")).rows[0];
 const before=(await q("SELECT name,checksum FROM schema_migrations WHERE name>='020_' ORDER BY name")).rows;
 const sql=fs.readFileSync(path.join(directory,'026_whatsapp_customer_identity.sql'),'utf8');
 const c=await db.pool.connect();try{await c.query('BEGIN');await c.query(sql);await c.query('ROLLBACK');}finally{c.release();}
 assert.deepEqual((await q('SELECT * FROM clientes')).rows,[legacy]);
 const {migrate}=require('../database/migrate');await Promise.all([migrate(db.pool,env.schema),migrate(db.pool,env.schema)]);await migrate(db.pool,env.schema);
 const row=(await q('SELECT * FROM clientes WHERE id=$1',[legacy.id])).rows[0];
 assert.deepEqual({id:row.id,nome:row.nome,telefone:row.telefone},legacy);assert.equal(row.assinatura_id,null);assert.equal(row.created_at,null);assert.equal(row.updated_at,null);
 for(const m of before){assert.equal((await q('SELECT checksum FROM schema_migrations WHERE name=$1',[m.name])).rows[0].checksum,m.checksum);assert.equal(m.checksum,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,m.name))).digest('hex'));}
 assert.equal((await q("SELECT count(*)::int n FROM configuracoes WHERE chave IN ('appointment_reminder_transport_policy_v1','return_outbox_delivery_enabled')")).rows[0].n,0);
 assert.equal((await q("SELECT count(*)::int n FROM schema_migrations WHERE name='026_whatsapp_customer_identity.sql'")).rows[0].n,1);
 assert.equal((await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('customers','whatsapp_customers')",[env.schema])).rows[0].n,0);
});
