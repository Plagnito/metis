'use strict';

const crypto=require('node:crypto');
const {db}=require('../core/db');
const context=require('../core/sqlite-context');
const J=require('./metis-research-journal');
const M=()=>require('./metisdocs');
const R=()=>require('./metisresearch');
const STATES=['open','claimed','in_progress','blocked','review','done','cancelled'];
const NAMES=new Set(['register_agent','agent_directory','create_work_item','list_work_items','get_work_item','update_work_item','create_handoff','agent_inbox','get_handoff','reply_to_handoff','acknowledge_handoff','request_review','get_review','submit_review','resolve_discussion']);
const WRITE=new Set([...NAMES].filter(n=>!['agent_directory','list_work_items','get_work_item','agent_inbox','get_handoff','get_review'].includes(n)));
let ready=false;
const now=()=>new Date().toISOString();
const id=kind=>kind+':'+crypto.randomUUID();
const error=(code,message,retryable=false)=>{throw new (R().ContractError)(code,message,retryable);};
function init(){
  if(ready)return;
  R().init();
  db.exec('SAVEPOINT metis_collaboration_migration');
  try{
    db.exec(`CREATE TABLE IF NOT EXISTS metis_research_agents(id TEXT PRIMARY KEY,account INTEGER NOT NULL,client TEXT NOT NULL,label TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,accept_assignments INTEGER NOT NULL DEFAULT 0,UNIQUE(account,client));
      CREATE TABLE IF NOT EXISTS metis_work_items(id TEXT PRIMARY KEY,owner_account INTEGER NOT NULL,owner_agent TEXT NOT NULL,visibility TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_handoffs(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES metis_work_items(id),from_agent TEXT NOT NULL,to_agent TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_reviews(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,subject_revision INTEGER NOT NULL,requester TEXT NOT NULL,reviewer TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_research_revisions(object_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,actor_id TEXT NOT NULL,client_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(object_id,revision));
      CREATE TABLE IF NOT EXISTS metis_read_receipts(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,resource_id TEXT NOT NULL,exact_revision INTEGER NOT NULL,read_at TEXT NOT NULL,client_identity TEXT NOT NULL,UNIQUE(recipient,resource_id,exact_revision));
      CREATE TABLE IF NOT EXISTS metis_research_requests(actor TEXT NOT NULL,operation TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(actor,operation,request_key));
      CREATE INDEX IF NOT EXISTS idx_handoff_inbox ON metis_handoffs(to_agent,created_at);
      CREATE INDEX IF NOT EXISTS idx_work_owner ON metis_work_items(owner_account,created_at);
      CREATE INDEX IF NOT EXISTS idx_review_inbox ON metis_reviews(reviewer,created_at);
      CREATE TRIGGER IF NOT EXISTS metis_revisions_immutable_update BEFORE UPDATE ON metis_research_revisions BEGIN SELECT RAISE(ABORT,'Immutable research revision'); END;
      CREATE TRIGGER IF NOT EXISTS metis_revisions_immutable_delete BEFORE DELETE ON metis_research_revisions BEGIN SELECT RAISE(ABORT,'Immutable research revision'); END;
      CREATE TRIGGER IF NOT EXISTS metis_receipts_immutable_update BEFORE UPDATE ON metis_read_receipts BEGIN SELECT RAISE(ABORT,'Immutable read receipt'); END;
      CREATE TRIGGER IF NOT EXISTS metis_receipts_immutable_delete BEFORE DELETE ON metis_read_receipts BEGIN SELECT RAISE(ABORT,'Immutable read receipt'); END;`);
    J.install(db);
    const prior=db.prepare('SELECT version FROM metis_research_contract WHERE id=1').get().version;
    if(prior<2){db.prepare('UPDATE metis_research_contract SET version=2 WHERE id=1').run();db.prepare("INSERT INTO metis_research_events(domain,kind,object_id,resource_id,revision_before,revision_after,actor_id,client_id,occurred_at) VALUES('contract','contract.updated','contract:metis-mcp','contract:metis-mcp',?,2,atlas_actor_id(),atlas_client_id(),?)").run(prior,now());}
    db.exec('RELEASE metis_collaboration_migration');ready=true;
  }catch(e){db.exec('ROLLBACK TO metis_collaboration_migration; RELEASE metis_collaboration_migration');J.invalidate(db);throw e;}
}
function agentId(user,client){return 'agent:'+crypto.createHash('sha256').update(JSON.stringify([Number(user),client])).digest('hex').slice(0,32);}
function identity(user,requireRegistration=true){
  const c=context.identity();
  if(!c||c.actor!=='atlas:'+Number(user)||!c.client)error('PERMISSION_DENIED','Identité OAuth Atlas/client observée requise.');
  const self=agentId(user,c.client);
  if(requireRegistration&&!db.prepare('SELECT 1 FROM metis_research_agents WHERE id=?').get(self))error('NOT_FOUND','Enregistrer ce client avec register_agent avant la collaboration.');
  return {id:self,account:Number(user),client:c.client};
}
function agent(target,assignment=false){text(target,'to_agent',100);const a=db.prepare('SELECT * FROM metis_research_agents WHERE id=?').get(target);if(!a||!M().peutLire(a.account))error('NOT_FOUND','Agent absent ou accès révoqué.');if(assignment&&!a.accept_assignments)error('PERMISSION_DENIED','Le destinataire doit autoriser les missions/revues par register_agent.');return a;}
function row(table,key){return db.prepare('SELECT * FROM '+table+' WHERE id=?').get(key)||null;}
function workReadable(user,w){
  if(!w)return false;
  if(w.owner_account===Number(user)||w.visibility==='metis_readers')return true;
  return !!db.prepare(`SELECT 1 FROM metis_handoffs h JOIN metis_research_agents a ON a.id=h.to_agent WHERE h.work_id=? AND a.account=?
    UNION ALL SELECT 1 FROM metis_reviews r JOIN metis_research_agents a ON a.id=r.reviewer WHERE r.subject_id=? AND a.account=? LIMIT 1`).get(w.id,Number(user),w.id,Number(user));
}
function rawCanReadResource(user,key){
  init();
  if(!require('./metis-access-fence').readable(user)||typeof key!=='string')return false;
  if(key.startsWith('work:'))return workReadable(user,row('metis_work_items',key));
  if(key.startsWith('agent:')){const a=row('metis_research_agents',key);return !!a&&a.account===Number(user);}
  if(key.startsWith('handoff:')){const h=row('metis_handoffs',key);return !!h&&[row('metis_research_agents',h.from_agent)?.account,row('metis_research_agents',h.to_agent)?.account].includes(Number(user));}
  if(key.startsWith('review:')){const r=row('metis_reviews',key);return !!r&&[row('metis_research_agents',r.requester)?.account,row('metis_research_agents',r.reviewer)?.account].includes(Number(user));}
  return false;
}
function canReadResource(user,key){return require('./metis-access-fence').canRead(user,key);}
function publicRow(r){
  if(!r)return null;
  const {data,owner_account,client,...fields}=r;
  if(fields.work_id){fields.work_item_id=fields.work_id;delete fields.work_id;}
  if(Object.hasOwn(fields,'accept_assignments'))fields.accept_assignments=!!fields.accept_assignments;
  return {...fields,...(data?JSON.parse(data):{}),epistemic_state:'known',provenance:'Atlas Research Fabric',content_trust:'untrusted_data'};
}
function get(user,key){
  text(key,'id',240);
  const table=key.startsWith('work:')?'metis_work_items':key.startsWith('handoff:')?'metis_handoffs':key.startsWith('review:')?'metis_reviews':key.startsWith('agent:')?'metis_research_agents':null;
  const r=table&&row(table,key);if(!r||!canReadResource(user,key))error('NOT_FOUND','Objet absent ou inaccessible.');return r;
}
function reference(user,key){
  text(key,'resource_id',240);
  if(/^(work|handoff|review|agent):/.test(key)){const value=publicRow(get(user,key));return {id:key,revision:value.revision,content_sha256:R().hash(value)};}
  const value=R().resource(user,key);if(!value)error('NOT_FOUND','Référence absente ou inaccessible.');return {id:key,revision:value.revision,content_sha256:R().hash(value)};
}
function pinned(user,refs){
  if(!Array.isArray(refs)||refs.length>12)error('INVALID_ARGUMENT','Références : au plus 12 objets {id,revision}.');
  return refs.map(ref=>{
    if(!ref||typeof ref.id!=='string'||ref.id.length>240||!Object.hasOwn(ref,'revision'))error('INVALID_ARGUMENT','Référence : ID et révision exacte requis.');
    if(Object.keys(ref).some(key=>!['id','revision','content_sha256'].includes(key))||ref.revision!==null&&(!Number.isSafeInteger(ref.revision)||ref.revision<0)||Object.hasOwn(ref,'content_sha256')&&(typeof ref.content_sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.content_sha256)))error('INVALID_ARGUMENT','Référence : révision entière ou null, empreinte SHA256 hexadécimale canonique et champs connus requis.');
    const current=reference(user,ref.id);
    if(current.revision!==ref.revision)error('REVISION_CONFLICT','Une référence épinglée a changé.');
    if(ref.content_sha256&&ref.content_sha256!==current.content_sha256)error('REVISION_CONFLICT','Une référence épinglée a changé.');
    return current;
  });
}
function fresh(user,refs){for(const ref of refs){const current=reference(user,ref.id);if(current.revision!==ref.revision||current.content_sha256!==ref.content_sha256)error('REVISION_CONFLICT','Une référence épinglée est périmée.');}}
function text(value,name,max,required=true){if(value===undefined&&!required)return '';if(typeof value!=='string'||(required&&!value.trim())||value.length>max)error('INVALID_ARGUMENT',name+': texte borné requis.');return value.trim();}
function cas(r,args){if(!Number.isSafeInteger(args.expected_revision)||args.expected_revision!==r.revision)error('REVISION_CONFLICT','expected_revision doit égaler la révision actuelle.');}
function writeRevision(r,self){db.prepare('INSERT INTO metis_research_revisions VALUES(?,?,?,?,?,?)').run(r.id,r.revision,JSON.stringify(publicRow(r)),'atlas:'+self.account,self.client,now());}
function save(table,r,self){const next={...r,revision:r.revision+1,updated_at:now()};db.prepare('UPDATE '+table+' SET data=?,revision=?,updated_at=?'+(table==='metis_handoffs'?',state=?':table==='metis_reviews'?',status=?':'')+' WHERE id=? AND revision=?').run(next.data,next.revision,next.updated_at,...(table==='metis_handoffs'?[next.state]:table==='metis_reviews'?[next.status]:[]),next.id,r.revision);writeRevision(next,self);return publicRow(next);}
function writer(user){if(!M().peutEcrire(user))error('PERMISSION_DENIED','Création réservée à Master/éditeur.');}
function participant(w,self){return w.owner_account===self.account||!!db.prepare('SELECT 1 FROM metis_handoffs WHERE work_id=? AND to_agent=?').get(w.id,self.id);}
function mission(w){const d=JSON.parse(w.data);return {work_item_id:w.id,revision:w.revision,title:d.title,goal:d.goal,resource_refs:d.resource_refs};}
function missionHash(w){const {revision,...content}=mission(w);return R().hash(content);}
function quota(sql,params,max){if(Number(db.prepare(sql).get(...params).n)>=max)error('INVALID_ARGUMENT','Quota de collaboration atteint.');}
function page(user,args,kind,read,request){
  const limit=R().integer(args.limit,20,1,100,'limit'),max=R().budget(args),high=R().high();
  const signature=R().hash({kind,state:args.state??null,client:context.identity().client});const state=args.cursor?R().decode(args.cursor,'collaboration',user):null;
  if(state&&(state.signature!==signature||state.high!==high))error('STALE_CURSOR','La vue a changé ; recommencer.',true);
  const remaining=read(state?.after||'',limit+1);
  const data={items:[],has_more:false,delivery_model:'persistent inbox; polling only; no wake integration'};let after=state?.after||'';
  const make=more=>R().envelope(request,{...data,has_more:more},high,{next_cursor:more?R().cursor({type:'collaboration',high,signature,after},user):null,truncated:more});
  for(const [index,r] of remaining.slice(0,limit).entries()){const previous=after;data.items.push(publicRow(r));after=r.id;const candidate=make(index+1<remaining.length);if(Buffer.byteLength(JSON.stringify(candidate))>max){if(data.items.length===1)R().assertBudget(candidate,args,12000,'Objet indivisible au-delà du budget ; augmenter max_tokens/max_bytes.');data.items.pop();after=previous;return make(true);}}
  return make(remaining.length>limit);
}
function execute(name,args,user,self){
  if(name==='register_agent'){
    const label=text(args.label,'label',80);let a=row('metis_research_agents',self.id);
    if(args.accept_assignments!==undefined&&typeof args.accept_assignments!=='boolean')error('INVALID_ARGUMENT','accept_assignments: booléen.');
    const accepts=args.accept_assignments===undefined?(a?.accept_assignments||0):Number(args.accept_assignments);
    if(a){cas(a,args);db.prepare('UPDATE metis_research_agents SET label=?,accept_assignments=?,revision=revision+1,updated_at=? WHERE id=?').run(label,accepts,now(),a.id);a=row('metis_research_agents',a.id);}
    else{if(args.expected_revision!==undefined&&args.expected_revision!==0)error('REVISION_CONFLICT','Nouvel agent : révision initiale 0.');quota('SELECT count(*) n FROM metis_research_agents WHERE account=?',[self.account],20);const t=now();db.prepare('INSERT INTO metis_research_agents VALUES(?,?,?,?,1,?,?,?)').run(self.id,self.account,self.client,label,t,t,accepts);a=row('metis_research_agents',self.id);}
    writeRevision(a,self);return {agent:publicRow(a),identity_source:'authenticated Atlas account and observed OAuth client; label is self-declared',observed_required_scope:'metis',scope_coverage:'required MCP scope only; not the full grant',wake_supported:false};
  }
  if(name==='create_work_item'){
    writer(user);const t=now(),key=id('work');
    quota('SELECT count(*) n FROM metis_work_items WHERE owner_account=?',[self.account],2000);
    if(args.visibility!==undefined&&!['private','metis_readers'].includes(args.visibility))error('INVALID_ARGUMENT','visibility: private|metis_readers.');
    const priority=args.priority||'normal';if(!['low','normal','high','urgent'].includes(priority))error('INVALID_ARGUMENT','priority invalide.');
    const blocking=args.blocking_ids||[];if(!Array.isArray(blocking)||blocking.length>20)error('INVALID_ARGUMENT','blocking_ids: au plus 20.');for(const key of blocking)get(user,key);
    const resource_refs=pinned(user,args.resource_refs||[]);
    const data={title:text(args.title,'title',160),goal:text(args.goal,'goal',2000),state:'open',priority,blocking_ids:blocking,resource_refs,summary_dependencies:resource_refs.map(r=>r.id)};
    db.prepare('INSERT INTO metis_work_items VALUES(?,?,?,?,?,1,?,?)').run(key,self.account,self.id,args.visibility||'private',JSON.stringify(data),t,t);const w=row('metis_work_items',key);writeRevision(w,self);return publicRow(w);
  }
  if(name==='update_work_item'){
    const w=get(user,args.id);if(!w.id.startsWith('work:')||!participant(w,self))error('PERMISSION_DENIED','Seul le propriétaire ou un destinataire de mission peut modifier ce travail.');cas(w,args);
    const data=JSON.parse(w.data);if(args.resource_refs===undefined)fresh(user,data.resource_refs);
    if(args.state!==undefined){if(!STATES.includes(args.state))error('INVALID_ARGUMENT','state invalide.');data.state=args.state;}
    for(const [key,max] of [['title',160],['goal',2000]])if(args[key]!==undefined){if(w.owner_account!==self.account)error('PERMISSION_DENIED','Contenu réservé au propriétaire.');data[key]=text(args[key],key,max);}
    if(args.resource_refs!==undefined){
      data.summary_dependencies=[...new Set([...(data.summary_dependencies||[]),...data.resource_refs.map(r=>r.id),...args.resource_refs.map(r=>r.id)])];
      data.resource_refs=pinned(user,args.resource_refs);
      const recipients=db.prepare('SELECT DISTINCT a.account FROM metis_handoffs h JOIN metis_research_agents a ON a.id=h.to_agent WHERE h.work_id=? UNION SELECT a.account FROM metis_reviews r JOIN metis_research_agents a ON a.id=r.reviewer WHERE r.subject_id=?').all(w.id,w.id);
      for(const recipient of recipients)for(const ref of data.resource_refs)if(ref.id!==w.id)reference(recipient.account,ref.id);
    }
    return save('metis_work_items',{...w,data:JSON.stringify(data)},self);
  }
  if(name==='create_handoff'){
    writer(user);const w=get(user,args.work_item_id);if(!w.id.startsWith('work:')||w.owner_account!==self.account)error('PERMISSION_DENIED','Seul le propriétaire peut transmettre ce travail.');
    const target=agent(args.to_agent,true);if(target.id===self.id)error('INVALID_ARGUMENT','Destinataire distinct requis.');
    quota("SELECT count(*) n FROM metis_handoffs WHERE to_agent=? AND state<>'completed'",[target.id],100);
    quota('SELECT count(*) n FROM metis_handoffs WHERE work_id=?',[w.id],100);
    cas(w,args);const refs=pinned(user,args.pinned_refs||JSON.parse(w.data).resource_refs);for(const ref of refs)if(ref.id!==w.id)reference(target.account,ref.id);
    let summaryDependencies=[];
    if(args.context_pack_id){const check=R().call('validate_context_pack',{pack_id:args.context_pack_id},user);if(!check.ok||!check.data.valid)error('REVISION_CONFLICT','Context pack absent ou périmé.');if(target.account!==self.account)error('PERMISSION_DENIED','Un context pack lié au compte ne peut pas être transmis à un autre compte.');summaryDependencies=R().decode(args.context_pack_id,'pack',user).refs.map(r=>r.object_id);}
    if(args.context_pack_id!==undefined)text(args.context_pack_id,'context_pack_id',12000);
    const data={message:text(args.message,'message',4000,false),expected_output:text(args.expected_output,'expected_output',1000),pinned_refs:refs,work_snapshot:mission(w),mission_hash:missionHash(w),summary_dependencies:summaryDependencies,context_pack_id:args.context_pack_id||null,replies:[],state_observation:'created_in_inbox',deadline:args.deadline===undefined?null:text(args.deadline,'deadline',80)};
    if(data.deadline&&(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(data.deadline)||!Number.isFinite(Date.parse(data.deadline))))error('INVALID_ARGUMENT','deadline: ISO-8601 avec fuseau.');
    const key=id('handoff'),t=now();db.prepare('INSERT INTO metis_handoffs VALUES(?,?,?,?,?,?,1,?,?)').run(key,w.id,self.id,target.id,'sent',JSON.stringify(data),t,t);const h=row('metis_handoffs',key);writeRevision(h,self);return {...publicRow(h),queued:true,wake_supported:false};
  }
  if(name==='acknowledge_handoff'||name==='reply_to_handoff'){
    const h=get(user,args.id);if(!h.id.startsWith('handoff:')||h.to_agent!==self.id)error('PERMISSION_DENIED','Seul le client destinataire peut accuser réception/répondre.');cas(h,args);const data=JSON.parse(h.data);fresh(user,data.pinned_refs);
    if(missionHash(get(user,h.work_id))!==data.mission_hash)error('REVISION_CONFLICT','Le contenu de la mission transmise a changé.');
    if(name==='acknowledge_handoff'){
      if(!['delivered','read','accepted'].includes(args.state))error('INVALID_ARGUMENT','Accusé: delivered|read|accepted.');
      const order=['sent','delivered','read','accepted','completed'];if(order.indexOf(args.state)<order.indexOf(h.state))error('REVISION_CONFLICT','Un accusé ne peut pas revenir en arrière.');
      if(args.state===h.state)return publicRow(h);
      if(['read','accepted'].includes(args.state)){
        db.prepare('INSERT OR IGNORE INTO metis_read_receipts VALUES(?,?,?,?,?,?)').run(id('receipt'),self.id,h.id,h.revision,now(),self.client);
        data.read_receipt={...db.prepare('SELECT * FROM metis_read_receipts WHERE recipient=? AND resource_id=? AND exact_revision=?').get(self.id,h.id,h.revision)};
      }
      data.state_observation='explicit_recipient_acknowledgement';return save('metis_handoffs',{...h,state:args.state,data:JSON.stringify(data)},self);
    }
    if(!['read','accepted'].includes(h.state))error('REVISION_CONFLICT','Accuser lecture/acceptation avant le résultat.');
    if(args.completed!==undefined&&typeof args.completed!=='boolean')error('INVALID_ARGUMENT','completed: booléen.');
    data.replies.push({id:id('reply'),from_agent:self.id,message:text(args.message,'message',4000),resource_refs:pinned(user,args.resource_refs||[]),reported_at:now(),content_trust:'untrusted_data'});
    if(data.replies.length>20)error('INVALID_ARGUMENT','Quota de réponses atteint.');data.state_observation=args.completed===true?'completion_reported_by_recipient':'reply_reported_by_recipient';
    return save('metis_handoffs',{...h,state:args.completed===true?'completed':h.state,data:JSON.stringify(data)},self);
  }
  if(name==='request_review'){
    writer(user);const target=agent(args.to_agent,true),subject=reference(user,args.subject_id);if(!Number.isSafeInteger(subject.revision)||subject.revision!==args.subject_revision)error('REVISION_CONFLICT','Révision native exacte du sujet requise.');
    quota("SELECT count(*) n FROM metis_reviews WHERE reviewer=? AND status='requested'",[target.id],100);
    if(args.subject_id.startsWith('work:')){const w=get(user,args.subject_id);if(w.owner_account!==self.account)error('PERMISSION_DENIED','Seul le propriétaire demande une revue.');for(const ref of JSON.parse(w.data).resource_refs)if(ref.id!==w.id)reference(target.account,ref.id);}
    else reference(target.account,args.subject_id);
    const key=id('review'),t=now(),data={subject_hash:subject.content_sha256,message:text(args.message,'message',2000,false),findings:[],decision:null};
    db.prepare('INSERT INTO metis_reviews VALUES(?,?,?,?,?,?,?,1,?,?)').run(key,args.subject_id,subject.revision,self.id,target.id,'requested',JSON.stringify(data),t,t);const review=row('metis_reviews',key);writeRevision(review,self);return publicRow(review);
  }
  if(name==='submit_review'||name==='resolve_discussion'){
    const review=get(user,args.id);if(!review.id.startsWith('review:'))error('NOT_FOUND','Revue absente.');cas(review,args);const data=JSON.parse(review.data),subject=reference(user,review.subject_id);
    if(subject.revision!==review.subject_revision||subject.content_sha256!==data.subject_hash)error('REVISION_CONFLICT','Le sujet de la revue a changé.');
    if(name==='submit_review'){
      if(review.reviewer!==self.id||review.status!=='requested')error('PERMISSION_DENIED','Seul le reviewer demandé peut soumettre une fois.');
      if(!['approve','request_changes','needs_evidence','reject'].includes(args.decision))error('INVALID_ARGUMENT','decision invalide.');
      if(!Array.isArray(args.findings)||args.findings.length>30)error('INVALID_ARGUMENT','findings: au plus 30 textes.');
      data.findings=args.findings.map(f=>({id:id('discussion'),text:text(f,'finding',2000),resolved:false}));data.decision=args.decision;data.submitted_at=now();
      return save('metis_reviews',{...review,status:'submitted',data:JSON.stringify(data)},self);
    }
    if(![review.requester,review.reviewer].includes(self.id)||review.status!=='submitted')error('PERMISSION_DENIED','Discussion non résoluble par ce client.');
    const finding=data.findings.find(f=>f.id===args.discussion_id);if(!finding)error('NOT_FOUND','Discussion absente.');finding.resolved=true;finding.resolution=text(args.resolution,'resolution',2000);finding.resolved_by=self.id;finding.resolved_at=now();
    return save('metis_reviews',{...review,data:JSON.stringify(data)},self);
  }
  error('INVALID_ARGUMENT','Opération inconnue.');
}
function call(name,args,user){
  const request=crypto.randomUUID();
  try{
    if(!M().peutLire(user))error('PERMISSION_DENIED','Accès Métis requis.');
    if(process.env.METIS_RESEARCH_ENABLED!=='1'||process.env.METIS_COLLAB_ENABLED!=='1')error('DEPENDENCY_UNAVAILABLE','Lot P1 désactivé.');
    if(!args||typeof args!=='object'||Array.isArray(args))error('INVALID_ARGUMENT','Arguments objet requis.');
    const allowed={register_agent:['label','accept_assignments','expected_revision','idempotency_key'],agent_directory:['limit','cursor'],create_work_item:['title','goal','priority','blocking_ids','resource_refs','visibility','idempotency_key'],list_work_items:['state','limit','cursor'],get_work_item:['id'],update_work_item:['id','expected_revision','state','title','goal','resource_refs','idempotency_key'],create_handoff:['work_item_id','expected_revision','to_agent','message','expected_output','pinned_refs','context_pack_id','deadline','idempotency_key'],agent_inbox:['state','limit','cursor'],get_handoff:['id'],reply_to_handoff:['id','expected_revision','message','resource_refs','completed','idempotency_key'],acknowledge_handoff:['id','expected_revision','state','idempotency_key'],request_review:['subject_id','subject_revision','to_agent','message','idempotency_key'],get_review:['id'],submit_review:['id','expected_revision','decision','findings','idempotency_key'],resolve_discussion:['id','expected_revision','discussion_id','resolution','idempotency_key']}[name];
    if(!allowed||Object.keys(args).some(k=>!allowed.includes(k)&&!['max_bytes','max_tokens'].includes(k)))error('INVALID_ARGUMENT','Paramètre inconnu.');
    if(Buffer.byteLength(JSON.stringify(args))>24000)error('INVALID_ARGUMENT','Arguments limités à 24 Ko.');
    R().rate(user,name);init();const self=identity(user,name!=='register_agent');
    if(!WRITE.has(name)){
      if(args.state!==undefined&&(typeof args.state!=='string'||(name==='list_work_items'?!STATES.includes(args.state):!['sent','delivered','read','accepted','completed','requested','submitted'].includes(args.state))))error('INVALID_ARGUMENT','state invalide.');
      db.exec('SAVEPOINT metis_collaboration_read');
      try{
        let out;
        if(name==='agent_directory')out=page(user,args,name,(after,count)=>db.prepare('SELECT * FROM metis_research_agents WHERE account=? AND id>? ORDER BY id LIMIT ?').all(self.account,after,count),request);
        else if(name==='list_work_items')out=page(user,args,name,(after,count)=>db.prepare(`SELECT * FROM metis_work_items w WHERE id>? AND (? IS NULL OR json_extract(data,'$.state')=?) AND ${workAclSql('w',user)} ORDER BY id LIMIT ?`).all(after,args.state??null,args.state??null,count),request);
        else if(name==='agent_inbox')out=page(user,args,name,(after,count)=>db.prepare(`SELECT * FROM (SELECT id,state,'metis_handoffs' source FROM metis_handoffs WHERE to_agent=? UNION ALL SELECT id,status state,'metis_reviews' source FROM metis_reviews WHERE reviewer=?) WHERE id>? AND atlas_readable_ref(id,${self.account})=1 AND (? IS NULL OR state=?) ORDER BY id LIMIT ?`).all(self.id,self.id,after,args.state??null,args.state??null,count).map(x=>row(x.source,x.id)),request);
        else out=R().envelope(request,publicRow(get(user,args.id)),R().high());
        require('./metis-access-fence').stamp(out);R().assertBudget(out,args);
        db.exec('RELEASE metis_collaboration_read');return out;
      }catch(e){db.exec('ROLLBACK TO metis_collaboration_read; RELEASE metis_collaboration_read');throw e;}
    }
    const key=text(args.idempotency_key,'idempotency_key',120),fingerprint=require('./metis-idempotency').fingerprint(args),legacyFingerprint=R().hash(args);
    db.exec('SAVEPOINT metis_collaboration_write');
    try{
      const previous=db.prepare('SELECT * FROM metis_research_requests WHERE actor=? AND operation=? AND request_key=?').get(self.id,name,key);
      if(previous){if(!require('./metis-idempotency').matches(previous.fingerprint,fingerprint,legacyFingerprint))error('IDEMPOTENCY_CONFLICT','Cette clé a déjà une autre requête.');const data=JSON.parse(previous.response);if(!canReadResource(user,data.id||data.agent?.id)||!require('./metis-access-fence').dependencies(data).every(id=>canReadResource(user,id)))error('PERMISSION_DENIED','Résultat idempotent devenu inaccessible.');const out=require('./metis-access-fence').stamp(R().envelope(request,data,R().high()));R().assertBudget(out,args);require('./metis-idempotency').upgrade(db,self.id,name,key,previous.fingerprint,fingerprint);db.exec('RELEASE metis_collaboration_write');return out;}
      const data=execute(name,args,user,self),out=require('./metis-access-fence').stamp(R().envelope(request,data,R().high()));
      R().assertBudget(out,args);
      db.prepare('INSERT INTO metis_research_requests VALUES(?,?,?,?,?)').run(self.id,name,key,fingerprint,JSON.stringify(data));db.exec('RELEASE metis_collaboration_write');return out;
    }catch(e){db.exec('ROLLBACK TO metis_collaboration_write; RELEASE metis_collaboration_write');throw e;}
  }catch(e){const known=e instanceof R().ContractError;return {ok:false,error:{code:known?e.code:'DEPENDENCY_UNAVAILABLE',message:known?e.message:'Dépendance Atlas indisponible.',retryable:known?e.retryable:true,...(known&&e.details?{details:e.details}:{})},request_id:request,schema_version:'1'};}
}
function workAclSql(alias,user){const account=Number(user);if(!Number.isSafeInteger(account))error('PERMISSION_DENIED','Compte invalide.');return `((${alias}.owner_account=${account} OR ${alias}.visibility='metis_readers' OR EXISTS(SELECT 1 FROM metis_handoffs ah JOIN metis_research_agents aa ON aa.id=ah.to_agent WHERE ah.work_id=${alias}.id AND aa.account=${account}) OR EXISTS(SELECT 1 FROM metis_reviews ar JOIN metis_research_agents aa ON aa.id=ar.reviewer WHERE ar.subject_id=${alias}.id AND aa.account=${account})) AND atlas_readable_payload(${alias}.data,${account})=1)`;}
function workOverview(user){init();const acl=workAclSql('w',user);return {available:true,epistemic_state:'known',states:db.prepare(`SELECT json_extract(data,'$.state') state,count(*) count FROM metis_work_items w WHERE ${acl} GROUP BY state ORDER BY state`).all(),recent:db.prepare(`SELECT id,json_extract(data,'$.title') title,json_extract(data,'$.state') state,revision,updated_at FROM metis_work_items w WHERE ${acl} ORDER BY updated_at DESC,id LIMIT 4`).all(),details_tool:'list_work_items',delivery_model:'persistent inbox; polling only'};}
function attention(user){
 init();let self;try{self=identity(user,false);}catch(e){if(!(e instanceof R().ContractError)||e.code!=='PERMISSION_DENIED')throw e;return {registered:null,identity_observed:false,pending_handoffs:null,pending_reviews:null,detail_tool:'agent_inbox',wake_supported:false};}
 if(!row('metis_research_agents',self.id))return {registered:false,pending_handoffs:null,pending_reviews:null,detail_tool:'agent_inbox',wake_supported:false};
 const handoffs=db.prepare("SELECT count(*) n FROM metis_handoffs WHERE to_agent=? AND state!='completed' AND atlas_readable_ref(id,?)=1").get(self.id,user).n;
 const reviews=db.prepare("SELECT count(*) n FROM metis_reviews WHERE reviewer=? AND status='requested' AND atlas_readable_ref(id,?)=1").get(self.id,user).n;
 return {registered:true,pending_handoffs:handoffs,pending_reviews:reviews,detail_tool:'agent_inbox',wake_supported:false,scope:'observed OAuth client only; reading creates no acknowledgement'};
}
module.exports={init,call:(name,args,user)=>require('./metis-observability').observe(user,name,()=>require('./metis-access-fence').withScope(user,()=>call(name,args,user))),NAMES,WRITE,STATES,canReadResource,rawCanReadResource,publicRow,workReadable,workAclSql,workOverview,attention,identity,pinned,fresh,reference,writeRevision,text,cas,writer,quota};
