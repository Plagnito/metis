'use strict';

// Nexus extends the canonical Atlas DB/outbox. Explicit init only: the Shadow
// runner uses a disposable DB; nothing registers a production route or worker.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const J = require('./metis-research-journal');
const C = require('./metiscollaboration');
const R = require('./metisresearch');
const F = require('./metis-access-fence');
const M = require('./metisdocs');
const { createRedactor } = require('./metis-nexus-redaction');
const KINDS = ['human_text','agent_text','tool_invocation','tool_result','tool_error','system_notice','github_event','provider_event'];
const now = () => new Date().toISOString();
const id = kind => kind + ':' + crypto.randomUUID();
const fail = (code, message = 'Opération Nexus refusée.') => { throw new R.ContractError(code, message); };
let ready = false;
let redact = createRedactor();
function init() {
  if (ready) return;
  C.init();
  db.exec('SAVEPOINT nexus_migration');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS metis_nexus_channels(
      id TEXT PRIMARY KEY, owner_account INTEGER NOT NULL REFERENCES player_accounts(id),
      visibility TEXT NOT NULL CHECK(visibility IN ('private','metis_readers')), data TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_nexus_acl(channel_id TEXT NOT NULL REFERENCES metis_nexus_channels(id),
      account INTEGER NOT NULL REFERENCES player_accounts(id), can_write INTEGER NOT NULL CHECK(can_write IN (0,1)), PRIMARY KEY(channel_id,account));
      CREATE TABLE IF NOT EXISTS metis_nexus_threads(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES metis_nexus_channels(id),data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_nexus_messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES metis_nexus_threads(id),
      channel_id TEXT NOT NULL REFERENCES metis_nexus_channels(id),server_seq INTEGER NOT NULL,actor_account INTEGER NOT NULL REFERENCES player_accounts(id),
      client TEXT NOT NULL,agent_id TEXT NOT NULL REFERENCES metis_research_agents(id),data TEXT NOT NULL,revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(channel_id,server_seq));
      CREATE INDEX IF NOT EXISTS idx_nexus_thread_seq ON metis_nexus_messages(thread_id,server_seq);
      CREATE TABLE IF NOT EXISTS metis_nexus_requests(actor TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
      object_id TEXT NOT NULL,PRIMARY KEY(actor,request_key));
      CREATE TABLE IF NOT EXISTS metis_nexus_receipts(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES metis_nexus_messages(id),
      consumer TEXT NOT NULL REFERENCES metis_research_agents(id),state TEXT NOT NULL CHECK(state IN ('delivered','read')),
      data TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(message_id,consumer,state));
      CREATE TABLE IF NOT EXISTS metis_nexus_cursors(id TEXT PRIMARY KEY,account INTEGER NOT NULL,client TEXT NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_nexus_connections(id TEXT PRIMARY KEY,owner_account INTEGER NOT NULL REFERENCES player_accounts(id),
      kind TEXT NOT NULL,active INTEGER NOT NULL,secret TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_nexus_deliveries(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES metis_nexus_connections(id),
      channel_id TEXT NOT NULL REFERENCES metis_nexus_channels(id),delivery_key TEXT NOT NULL,raw_hash TEXT NOT NULL,
      data TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(connection_id,delivery_key));
      CREATE TABLE IF NOT EXISTS metis_nexus_usage(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES metis_nexus_connections(id),
      owner_account INTEGER NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_nexus_usage_notes(id TEXT PRIMARY KEY,usage_id TEXT NOT NULL REFERENCES metis_nexus_usage(id),
      notification_key TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(usage_id,notification_key));
      CREATE TRIGGER IF NOT EXISTS nexus_usage_notes_immutable_update BEFORE UPDATE ON metis_nexus_usage_notes BEGIN SELECT RAISE(ABORT,'Immutable usage note'); END;
      CREATE TRIGGER IF NOT EXISTS nexus_usage_notes_immutable_delete BEFORE DELETE ON metis_nexus_usage_notes BEGIN SELECT RAISE(ABORT,'Immutable usage note'); END;
      CREATE INDEX IF NOT EXISTS idx_nexus_usage_connection ON metis_nexus_usage(connection_id);
      CREATE TRIGGER IF NOT EXISTS nexus_receipts_immutable_update BEFORE UPDATE ON metis_nexus_receipts BEGIN SELECT RAISE(ABORT,'Immutable receipt'); END;
      CREATE TRIGGER IF NOT EXISTS nexus_receipts_immutable_delete BEFORE DELETE ON metis_nexus_receipts BEGIN SELECT RAISE(ABORT,'Immutable receipt'); END;`);
    J.install(db);
    for (const op of ['INSERT','UPDATE','DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS nexus_acl_policy_${op.toLowerCase()} AFTER ${op} ON metis_nexus_acl BEGIN UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;`);
    db.function('atlas_nexus_readable', (key, user) => Number(canRead(Number(user), key)));
    db.exec('RELEASE nexus_migration'); ready = true;
  } catch (e) { db.exec('ROLLBACK TO nexus_migration; RELEASE nexus_migration'); J.invalidate(db); throw e; }
}
function transaction(fn) {
  db.exec('SAVEPOINT nexus_operation');
  // Reserve the SQLite writer BEFORE any snapshot read. A deferred savepoint
  // cannot safely upgrade after another process commits (SQLITE_BUSY_SNAPSHOT).
  try { db.prepare('UPDATE metis_research_policy SET generation=generation WHERE id=1').run(); const result = fn(); db.exec('RELEASE nexus_operation'); return result; }
  catch (e) { db.exec('ROLLBACK TO nexus_operation; RELEASE nexus_operation'); throw e; }
}
function row(table, key) { return db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(key); }
const tables = {channel:'metis_nexus_channels',thread:'metis_nexus_threads',message:'metis_nexus_messages',delivery:'metis_nexus_deliveries',connection:'metis_nexus_connections',usage:'metis_nexus_usage'};
function channelReadable(user, channel) {
  return !!channel && (channel.owner_account === user || channel.visibility === 'metis_readers' || !!db.prepare('SELECT 1 FROM metis_nexus_acl WHERE channel_id=? AND account=?').get(channel.id, user));
}
function canRead(user, key) {
  if (!ready || !M.peutLire(user) || typeof key !== 'string') return false;
  const table = tables[key.split(':')[0]];
  const item = table && row(table, key);
  if (!item) return false;
  if (key.startsWith('channel:')) return channelReadable(user, item);
  if (key.startsWith('connection:') || key.startsWith('usage:')) return item.owner_account === user;
  if (!channelReadable(user, row('metis_nexus_channels', item.channel_id))) return false;
  if (key.startsWith('message:') && !canRead(user,item.thread_id)) return false;
  const data = JSON.parse(item.data);
  if (data.connection_id && !row('metis_nexus_connections', data.connection_id)?.active) return false;
  if (key.startsWith('delivery:') && row('metis_nexus_connections', item.connection_id)?.owner_account !== user) return false;
  return (data.resource_refs || []).every(ref => F.canRead(user, ref.id));
}
function allowed(user, key) { if (!canRead(user, key)) fail('NOT_FOUND','Objet absent ou inaccessible.'); return row(tables[key.split(':')[0]], key); }
function self(user) { if (!M.peutLire(user)) fail('PERMISSION_DENIED'); return C.identity(user); }
function canWrite(user, channel) {
  if (!channelReadable(user, channel)) fail('NOT_FOUND','Objet absent ou inaccessible.');
  if (channel.owner_account !== user && !db.prepare('SELECT 1 FROM metis_nexus_acl WHERE channel_id=? AND account=? AND can_write=1').get(channel.id,user)) fail('PERMISSION_DENIED');
}
function revision(item, expected) { if (!Number.isSafeInteger(expected) || item.revision !== expected) fail('REVISION_CONFLICT','La révision a changé ; relire.'); }
function strict(args, fields) { if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key))) fail('INVALID_ARGUMENT','Champ Nexus inconnu ou identité auto-déclarée.'); }
function text(value, max = 160) { return C.text(value,'texte',max); }
function bounded(value, bytes) { if (Buffer.byteLength(JSON.stringify(value)) > bytes) fail('INVALID_ARGUMENT','Contenu au-delà de la limite.'); return value; }
function saveRevision(item, principal) {
  db.prepare('INSERT INTO metis_research_revisions VALUES(?,?,?,?,?,?)').run(item.id,item.revision,JSON.stringify(publicRow(item)), 'atlas:'+principal.account,principal.client,now());
}
function publicRow(item) {
  const { data, client, actor_account, agent_id, owner_account, secret, ...fields } = item;
  const body = JSON.parse(data || '{}');
  return redact({...fields,...body,...(actor_account ? {actor:{account_id:'atlas:'+actor_account,oauth_client:client,agent_id}} : {}),schema_version:'nexus/1',content_trust:'untrusted_data'});
}
function setRedactor(fn) { redact = fn; }
function createChannel(user, args) {
  init(); strict(args,['title','visibility','idempotency_key']); const principal = self(user); C.writer(user);
  if (!['private','metis_readers'].includes(args.visibility)) fail('INVALID_ARGUMENT');
  return mutation(principal,args,()=>{
    const item = {id:id('channel'),owner_account:user,visibility:args.visibility,data:JSON.stringify(redact({title:text(args.title),created_at:now()})),revision:1};
    db.prepare('INSERT INTO metis_nexus_channels VALUES(?,?,?,?,?)').run(item.id,user,item.visibility,item.data,1); return item;
  });
}
function grant(user, args) {
  init(); strict(args,['channel_id','account','can_write','expected_revision','idempotency_key']); const principal = self(user);
  return mutation(principal,args,()=>{
    const item = allowed(user,args.channel_id); if(item.owner_account!==user)fail('PERMISSION_DENIED'); revision(item,args.expected_revision);
    if(!Number.isSafeInteger(args.account)||!M.peutLire(args.account)||typeof args.can_write!=='boolean')fail('INVALID_ARGUMENT');
    db.prepare('INSERT INTO metis_nexus_acl VALUES(?,?,?) ON CONFLICT(channel_id,account) DO UPDATE SET can_write=excluded.can_write').run(item.id,args.account,Number(args.can_write));
    db.prepare('UPDATE metis_nexus_channels SET revision=revision+1 WHERE id=?').run(item.id); return row('metis_nexus_channels',item.id);
  });
}
function revoke(user,args) {
  init();strict(args,['channel_id','account','expected_revision','idempotency_key']);const principal=self(user);
  return mutation(principal,args,()=>{
    const item=allowed(user,args.channel_id);if(item.owner_account!==user)fail('PERMISSION_DENIED');revision(item,args.expected_revision);
    if(item.visibility!=='private')fail('INVALID_ARGUMENT','Un salon partagé doit devenir privé avant une révocation individuelle.');
    db.prepare('DELETE FROM metis_nexus_acl WHERE channel_id=? AND account=?').run(item.id,args.account);
    db.prepare('UPDATE metis_nexus_channels SET revision=revision+1 WHERE id=?').run(item.id);return row('metis_nexus_channels',item.id);
  });
}
function createThread(user,args) {
  init();strict(args,['channel_id','title','resource_refs','idempotency_key']);const principal=self(user);
  return mutation(principal,args,()=>{
    const channel=allowed(user,args.channel_id);canWrite(user,channel);
    const refs=C.pinned(user,args.resource_refs||[]);sharedRefs(user,channel,refs);
    const item={id:id('thread'),channel_id:channel.id,data:JSON.stringify(redact({title:text(args.title),resource_refs:refs})),revision:1};
    db.prepare('INSERT INTO metis_nexus_threads VALUES(?,?,?,?)').run(item.id,item.channel_id,item.data,1);return item;
  });
}
function sharedRefs(user,channel,refs) {
  if(channel.visibility==='metis_readers'&&refs.some(ref=>!['publie','metis_readers'].includes(R.resource(user,ref.id)?.visibility)))fail('PRIVACY_DENIED','Une source privée exige un salon privé.');
}
function mutation(principal,args,fn) {
  const key=text(args.idempotency_key,120),fingerprint=R.hash(args);
  return transaction(()=>{
    const previous=db.prepare('SELECT * FROM metis_nexus_requests WHERE actor=? AND request_key=?').get(principal.id,key);
    if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT');return publicRow(allowed(principal.account,previous.object_id));}
    const item=fn();saveRevision(item,principal);
    db.prepare('INSERT INTO metis_nexus_requests VALUES(?,?,?,?)').run(principal.id,key,fingerprint,item.id);return publicRow(item);
  });
}
function post(user,args,serverEvent=false) {
  init();strict(args,['thread_id','body','kind','resource_refs','parent_message','trace','idempotency_key']);const principal=self(user);
  return mutation(principal,args,()=>{
    const thread=allowed(user,args.thread_id),channel=allowed(user,thread.channel_id);canWrite(user,channel);
    if(!KINDS.includes(args.kind))fail('INVALID_ARGUMENT','Type non reconnu par nexus/1.');
    if(!serverEvent&&['system_notice','github_event','provider_event'].includes(args.kind))fail('PERMISSION_DENIED','Événement réservé au serveur.');
    if(args.kind==='agent_text'&&!principal.id)fail('PERMISSION_DENIED');
    if(args.parent_message&&allowed(user,args.parent_message).thread_id!==thread.id)fail('INVALID_ARGUMENT');
    const refs=C.pinned(user,args.resource_refs||[]);
    sharedRefs(user,channel,refs);
    const data=bounded(redact({body:text(args.body,32768),kind:args.kind,parent_message:args.parent_message||null,
      resource_refs:refs,trace:bounded(args.trace||{},8192),transport_state:'persisted',created_at:now()}),32768);
    if(Buffer.byteLength(JSON.stringify(args))>65536)fail('INVALID_ARGUMENT');
    const seq=db.prepare('SELECT COALESCE(MAX(server_seq),0)+1 n FROM metis_nexus_messages WHERE channel_id=?').get(channel.id).n;
    const item={id:id('message'),thread_id:thread.id,channel_id:channel.id,server_seq:seq,actor_account:user,client:principal.client,
      agent_id:principal.id,data:JSON.stringify(data),revision:1,created_at:now(),updated_at:now()};
    db.prepare('INSERT INTO metis_nexus_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(item.id,item.thread_id,item.channel_id,seq,user,item.client,item.agent_id,item.data,1,item.created_at,item.updated_at);
    return item;
  });
}
function edit(user,args) {
  init();strict(args,['id','body','expected_revision','idempotency_key']);const principal=self(user);
  return mutation(principal,args,()=>{
    const item=allowed(user,args.id);if(!args.id.startsWith('message:')||item.agent_id!==principal.id)fail('PERMISSION_DENIED');
    canWrite(user,allowed(user,item.channel_id));revision(item,args.expected_revision);
    const data=JSON.parse(item.data);data.body=redact(text(args.body,32768));data.edited_at=now();bounded(data,32768);
    db.prepare('UPDATE metis_nexus_messages SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),item.id);
    return row('metis_nexus_messages',item.id);
  });
}
function receipt(user,args) {
  init();strict(args,['message_id','state','idempotency_key']);const principal=self(user);
  if(!['delivered','read'].includes(args.state))fail('INVALID_ARGUMENT','Le cycle de mission passe par les handoffs Atlas.');
  return transaction(()=>{
    allowed(user,args.message_id);text(args.idempotency_key,120);
    if(args.state==='read'&&!db.prepare("SELECT 1 FROM metis_nexus_receipts WHERE message_id=? AND consumer=? AND state='delivered'").get(args.message_id,principal.id))fail('INVALID_ARGUMENT','Accuser livraison avant lecture.');
    db.prepare('INSERT OR IGNORE INTO metis_nexus_receipts VALUES(?,?,?,?,?,1)').run(id('receipt'),args.message_id,principal.id,args.state,JSON.stringify({observed_at:now(),oauth_client:principal.client}));
    return publicRow(db.prepare('SELECT * FROM metis_nexus_receipts WHERE message_id=? AND consumer=? AND state=?').get(args.message_id,principal.id,args.state));
  });
}
function cursor(user,data) {
  const principal=self(user),key=id('cursor');
  db.prepare('DELETE FROM metis_nexus_cursors WHERE expires<?').run(Date.now());
  if(db.prepare('SELECT count(*) n FROM metis_nexus_cursors WHERE account=?').get(user).n>=512)fail('QUOTA_EXCEEDED');
  db.prepare('INSERT INTO metis_nexus_cursors VALUES(?,?,?,?,?)').run(key,user,principal.client,Date.now()+3600000,JSON.stringify(data));
  return R.cursor({type:'nexus',key},user);
}
function decode(user,token,mode,scope) {
  const signed=R.decode(token,'nexus',user),principal=self(user);
  const item=db.prepare('SELECT * FROM metis_nexus_cursors WHERE id=? AND account=? AND client=?').get(signed.key,user,principal.client);
  if(!item||item.expires<Date.now())fail('RESYNC_REQUIRED','Curseur expiré ; refaire un instantané.');
  const data=JSON.parse(item.data);if(data.mode!==mode||data.scope!==scope)fail('INVALID_ARGUMENT');return data;
}
function messageView(user,key) {
  const item=allowed(user,key),out=publicRow(item);
  out.stale_refs=(out.resource_refs||[]).filter(ref=>C.reference(user,ref.id).revision!==ref.revision).map(ref=>ref.id);
  out.receipts=db.prepare('SELECT * FROM metis_nexus_receipts WHERE message_id=? AND consumer=?').all(key,self(user).id).map(publicRow);
  return out;
}
function messages(user,args) {
  init();self(user);allowed(user,args.thread_id);
  const limit=R.integer(args.limit,30,1,100,'limit');
  return transaction(()=>{
    const state=args.cursor?decode(user,args.cursor,'messages',args.thread_id):{after:0,upper:db.prepare('SELECT COALESCE(MAX(server_seq),0) n FROM metis_nexus_messages WHERE thread_id=?').get(args.thread_id).n};
    const items=db.prepare('SELECT id,server_seq FROM metis_nexus_messages WHERE thread_id=? AND server_seq>? AND server_seq<=? AND atlas_nexus_readable(id,?)=1 ORDER BY server_seq LIMIT ?').all(args.thread_id,state.after,state.upper,user,limit+1);
    const more=items.length>limit,selected=items.slice(0,limit);
    const next=more?cursor(user,{...state,mode:'messages',scope:args.thread_id,after:selected.at(-1).server_seq}):null;
    return {items:selected.map(item=>messageView(user,item.id)),next_cursor:next};
  });
}
function snapshot(user,channel_id) {
  init();self(user);allowed(user,channel_id);
  return transaction(()=>({channels:[publicRow(allowed(user,channel_id))],threads:db.prepare('SELECT * FROM metis_nexus_threads WHERE channel_id=? AND atlas_nexus_readable(id,?)=1 ORDER BY id LIMIT 100').all(channel_id,user).map(publicRow),cursor:cursor(user,{mode:'events',scope:channel_id,after:R.high()})}));
}
function events(user,args) {
  init();self(user);allowed(user,args.channel_id);
  return transaction(()=>{
    const state=decode(user,args.cursor,'events',args.channel_id),upper=state.upper??R.high();
    const rows=db.prepare(`SELECT e.* FROM metis_research_events e WHERE e.domain='nexus' AND e.seq>? AND e.seq<=?
      AND atlas_nexus_readable(e.resource_id,?)=1 ORDER BY e.seq LIMIT 1001`).all(state.after,upper,user);
    const channelRows=rows.filter(item=>{const table=tables[item.resource_id.split(':')[0]],resource=table&&row(table,item.resource_id);return resource?.channel_id===args.channel_id||resource?.id===args.channel_id;});
    const selected=channelRows.slice(0,100),scanFull=rows.length>1000,more=channelRows.length>100||scanFull;
    const after=channelRows.length>100?selected.at(-1).seq:scanFull?rows[999].seq:upper;
    const next=after===state.after&&!state.upper?args.cursor:cursor(user,{mode:'events',scope:args.channel_id,after,...(more?{upper}:{})});
    const secret=db.prepare('SELECT secret FROM metis_research_contract WHERE id=1').get().secret;
    return {items:selected.map(item=>({event_id:'evt:nexus:'+crypto.createHmac('sha256',secret).update(String(item.seq)).digest('hex'),kind:item.kind,resource_id:item.resource_id,
      resource:item.resource_id.startsWith('message:')?messageView(user,item.resource_id):publicRow(allowed(user,item.resource_id)),occurred_at:item.occurred_at})),cursor:next,has_more:more};
  });
}
function search(user,query) {
  init();self(user);text(query,200);
  return transaction(()=>db.prepare('SELECT id FROM metis_nexus_messages WHERE atlas_nexus_readable(id,?)=1 AND instr(atlas_fold(json_extract(data,\'$.body\')),atlas_fold(?))>0 ORDER BY created_at,id LIMIT 100').all(user,query).map(item=>messageView(user,item.id)));
}
function channels(user) {init();self(user);return db.prepare('SELECT * FROM metis_nexus_channels WHERE atlas_nexus_readable(id,?)=1 ORDER BY id LIMIT 100').all(user).map(publicRow);}
function inspect(user,key) {init();self(user);return transaction(()=>messageView(user,key));}
function exportThread(user,thread_id) {
  init();self(user);allowed(user,thread_id);
  return transaction(()=>{
    const items=db.prepare('SELECT id FROM metis_nexus_messages WHERE thread_id=? AND atlas_nexus_readable(id,?)=1 ORDER BY server_seq LIMIT 101').all(thread_id,user);
    if(items.length>100)fail('TRUNCATED','Exporter les pages de messages séparément.');
    return redact({thread:publicRow(allowed(user,thread_id)),messages:items.map(item=>messageView(user,item.id))});
  });
}
module.exports={init,transaction,canRead,allowed,self,canWrite,revision,strict,publicRow,setRedactor,createChannel,grant,revoke,createThread,post,postServer:(user,args)=>post(user,args,true),edit,receipt,messages,snapshot,events,search,channels,inspect,exportThread,KINDS};
