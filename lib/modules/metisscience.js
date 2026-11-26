'use strict';
// Imported research records in Atlas' canonical SQLite, never an execution service.
const crypto=require('node:crypto');
const {db}=require('../core/db');
const C=require('./metiscollaboration'),R=require('./metisresearch'),F=require('./metis-access-fence'),J=require('./metis-research-journal');
const M=()=>require('./metisdocs');
const KINDS=['source','claim','evidence','decision','dataset','protocol','run'];
const STATES=['hypothesis','author_claim','observed','independently_reproduced','refuted','unknown'];
const NAMES=new Set(['register_source','get_source','find_related_sources','register_claim','link_evidence','verify_claim','find_contradictions','decision_registry','decision_history','register_dataset','register_protocol','register_run','compare_runs','get_research_object']);
const WRITES=new Set(['register_source','register_claim','link_evidence','verify_claim','decision_registry','register_dataset','register_protocol','register_run']);
const enabled=()=>process.env.METIS_RESEARCH_ENABLED==='1'&&process.env.METIS_COLLAB_ENABLED==='1'&&process.env.METIS_SCIENCE_ENABLED==='1';
const fail=(code,message,retryable=false)=>{throw new R.ContractError(code,message,retryable);};
const now=()=>new Date().toISOString();
let ready=false;
function init(){
 if(ready)return;C.init();db.exec('SAVEPOINT metis_science_migration');
 try{
  db.exec(`CREATE TABLE IF NOT EXISTS metis_science_objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('source','claim','evidence','decision','dataset','protocol','run')),owner_account INTEGER NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('private','metis_readers')),data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_science_kind ON metis_science_objects(kind,id);
   CREATE INDEX IF NOT EXISTS idx_science_owner ON metis_science_objects(owner_account,kind,id);`);
  J.install(db);
  const prior=db.prepare('SELECT version FROM metis_research_contract WHERE id=1').get().version;
  if(prior<3){db.prepare('UPDATE metis_research_contract SET version=3 WHERE id=1').run();db.prepare("INSERT INTO metis_research_events(domain,kind,object_id,resource_id,revision_before,revision_after,actor_id,client_id,occurred_at) VALUES('contract','contract.updated','contract:metis-mcp','contract:metis-mcp',?,3,atlas_actor_id(),atlas_client_id(),?)").run(prior,now());}
  db.exec('RELEASE metis_science_migration');ready=true;
 }catch(e){db.exec('ROLLBACK TO metis_science_migration; RELEASE metis_science_migration');J.invalidate(db);throw e;}
}
function row(id){return db.prepare('SELECT * FROM metis_science_objects WHERE id=?').get(id);}
function aclSql(alias,user){const account=Number(user);if(!Number.isSafeInteger(account))fail('PERMISSION_DENIED','Compte invalide.');return `((${alias}.owner_account=${account} OR ${alias}.visibility='metis_readers') AND atlas_readable_payload(${alias}.data,${account})=1)`;}
function get(user,id,kind){C.text(id,'id',240);const r=row(id);if(!r||kind&&r.kind!==kind||!F.canRead(user,id))fail('NOT_FOUND','Objet absent ou inaccessible.');return r;}
function view(r){const {page_key,...rest}=r;return C.publicRow(rest);}
function text(value,key,max=2000){return C.text(value,key,max);}
function nullable(value,key,max=1000){if(value===null)return null;return text(value,key,max);}
function object(value,key){if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_ARGUMENT',key+': objet JSON requis.');return value;}
function digest(value){if(value===null)return null;if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail('INVALID_ARGUMENT','sha256 : empreinte hexadécimale ou null.');return value.toLowerCase();}
function url(value){if(value===null)return null;try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();return u.href;}catch{fail('INVALID_ARGUMENT','URL HTTP(S) sans identifiants requise.');}}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))fail('INVALID_ARGUMENT','Date ISO-8601 avec fuseau requise.');return new Date(value).toISOString();}
function enumValue(value,values,key){if(!values.includes(value))fail('INVALID_ARGUMENT',key+': valeur inconnue.');return value;}
function ref(user,value,kind){const refs=C.pinned(user,[value]);if(kind&&!refs[0].id.startsWith(kind+':'))fail('INVALID_ARGUMENT','Type de référence attendu : '+kind+'.');return refs[0];}
function refs(user,value){return C.pinned(user,value||[]);}
function imported(args){return {origin:text(args.origin,'origin',1000),validation_scope:'imported declaration; no fetch, local execution or independent verification'};}
function store(kind,data,args,user,self,existing){
 C.writer(user);
 if(existing){if(existing.owner_account!==self.account)fail('PERMISSION_DENIED','Modification réservée au propriétaire.');C.cas(existing,args);}
 else{if(args.expected_revision!==0)fail('REVISION_CONFLICT','Création : expected_revision=0 requis.');C.quota('SELECT count(*) n FROM metis_science_objects WHERE owner_account=?',[self.account],5000);}
 const visibility=enumValue(args.visibility??existing?.visibility??'private',['private','metis_readers'],'visibility');
 // Removing a citation cannot declassify text derived from it. Rebuild a new object to start a new lineage.
 data.summary_dependencies=[...new Set([...(existing?F.dependencies(JSON.parse(existing.data)):[]),...F.dependencies(data)])];
 const id=existing?.id||kind+':'+crypto.randomUUID(),t=now();
 if(existing)db.prepare('UPDATE metis_science_objects SET visibility=?,data=?,revision=revision+1,updated_at=? WHERE id=?').run(visibility,JSON.stringify(data),t,id);
 else db.prepare('INSERT INTO metis_science_objects VALUES(?,?,?,?,?,1,?,?)').run(id,kind,self.account,visibility,JSON.stringify(data),t,t);
 const saved=row(id);C.writeRevision(saved,self);return view(saved);
}
function page(user,args,type,read,request){
 const limit=R.integer(args.limit,20,1,100,'limit'),high=R.high(),signature=R.hash({type,query:args.query??null,scope:args.scope??null,id:args.id??null,subject:args.subject??null});
 const state=args.cursor?R.decode(args.cursor,'science',user):null;
 if(state&&(state.high!==high||state.signature!==signature||state.policy!==F.generation()))fail('STALE_CURSOR','La vue ou ses autorisations ont changé ; recommencer.',true);
 const rows=read(state?.after||'',limit+1),items=[];let after=state?.after||'';
 const make=more=>R.envelope(request,{items,has_more:more,content_trust:'untrusted_data'},high,{next_cursor:more?R.cursor({type:'science',high,signature,policy:F.generation(),after},user):null,truncated:more});
 for(const r of rows.slice(0,limit)){const prior=after;items.push(view(r));after=r.page_key??r.id;if(Buffer.byteLength(JSON.stringify(make(true)))>R.budget(args)){items.pop();after=prior;if(!items.length)fail('TRUNCATED','Objet au-delà du budget ; augmenter le budget.',true);return make(true);}}
 return make(rows.length>limit);
}
function list(user,args,kind,request){
 const query=args.query===undefined?'':text(args.query,'query',200),scope=args.scope??null;
 return page(user,args,kind,(after,count)=>db.prepare(`SELECT * FROM metis_science_objects s WHERE kind=? AND id>? AND ${aclSql('s',user)} AND instr(atlas_fold(data),atlas_fold(?))>0 AND (? IS NULL OR json_extract(data,'$.scope')=?) ORDER BY id LIMIT ?`).all(kind,after,query,scope,scope,count),request);
}
function execute(name,args,user,self){
 const existing=args.id&&['register_source','register_claim','register_dataset','register_protocol','register_run'].includes(name)?get(user,args.id):null;
 if(name==='register_source'){
  if(existing&&existing.kind!=='source')fail('INVALID_ARGUMENT','ID source requis.');
  const doi=args.doi===null?null:text(args.doi,'doi',300);if(doi!==null&&!/^10\.\d{4,9}\/\S+$/.test(doi))fail('INVALID_ARGUMENT','DOI normalisé attendu.');
  const sourceUrl=url(args.url);if(!doi&&!sourceUrl)fail('INVALID_ARGUMENT','URL ou DOI requis.');
  return store('source',{title:text(args.title,'title',160),url:sourceUrl,doi,version:nullable(args.version,'version',300),access_date:date(args.access_date),author:nullable(args.author,'author',500),license:nullable(args.license,'license',500),sha256:digest(args.sha256??null),description:text(args.description,'description',4000),resource_refs:refs(user,args.resource_refs),...imported(args)},args,user,self,existing);
 }
 if(name==='register_claim'){
  if(existing&&existing.kind!=='claim')fail('INVALID_ARGUMENT','ID claim requis.');
  const status=enumValue(args.status,['hypothesis','author_claim','unknown'],'status');
  if(existing&&!['hypothesis','author_claim','unknown'].includes(JSON.parse(existing.data).status))fail('INVALID_ARGUMENT','Une affirmation évaluée se modifie avec verify_claim.');
  return store('claim',{title:text(args.title,'title',160),statement:text(args.statement,'statement',4000),subject:text(args.subject,'subject',200),scope:text(args.scope,'scope',1000),predicate:nullable(args.predicate,'predicate',500),polarity:enumValue(args.polarity,['positive','negative','unspecified'],'polarity'),status,source_ref:ref(user,args.source_ref,'source'),resource_refs:refs(user,args.resource_refs),evidence_refs:existing?JSON.parse(existing.data).evidence_refs:[],...imported(args)},args,user,self,existing);
 }
 if(name==='link_evidence'){
  const claim=get(user,args.claim_id,'claim');if(claim.owner_account!==self.account)fail('PERMISSION_DENIED','Affirmation réservée au propriétaire.');C.cas(claim,args);
  const data=JSON.parse(claim.data);C.fresh(user,data.resource_refs||[]);
  if(data.evidence_refs.length>=30)fail('INVALID_ARGUMENT','30 preuves par affirmation maximum.');
  const run_ref=args.run_ref?ref(user,args.run_ref,'run'):null;
  const type=enumValue(args.type,['citation','observation','reproduction','counterexample'],'type');
  if(type==='reproduction'&&!run_ref)fail('INVALID_ARGUMENT','Une reproduction doit référencer un run externe.');
  const evidence=store('evidence',{title:text(args.title,'title',160),type,relation:enumValue(args.relation,['supports','refutes','qualifies'],'relation'),source_ref:ref(user,args.source_ref,'source'),claim_refs:[C.reference(user,claim.id)],run_ref,passage:text(args.passage,'passage',4000),locator:text(args.locator,'locator',1000),confidence:args.confidence===null?null:enumValue(args.confidence,['low','medium','high'],'confidence'),external_record_id:args.external_record_id===undefined?null:nullable(args.external_record_id,'external_record_id',300),...imported(args)},{...args,expected_revision:0,visibility:claim.visibility},user,self);
  data.evidence_refs.push(C.reference(user,evidence.id));
  const saved=store('claim',data,{...args,expected_revision:claim.revision,visibility:claim.visibility},user,self,claim);
  return {claim:saved,evidence};
 }
 if(name==='verify_claim'){
  const claim=get(user,args.id,'claim'),data=JSON.parse(claim.data);C.cas(claim,args);
  const status=enumValue(args.status,STATES,'status'),evidence_refs=refs(user,args.evidence_refs),run_refs=refs(user,args.run_refs);
  if(evidence_refs.some(r=>!r.id.startsWith('evidence:'))||run_refs.some(r=>!r.id.startsWith('run:')))fail('INVALID_ARGUMENT','Références de preuves/runs typées requises.');
  const records=evidence_refs.map(r=>JSON.parse(get(user,r.id,'evidence').data));
  if(records.some(e=>!e.claim_refs.some(r=>r.id===claim.id)))fail('INVALID_ARGUMENT','Preuves rattachées à cette affirmation requises.');
  if(['observed','independently_reproduced','refuted'].includes(status)&&!records.some(e=>e.type!=='citation'))fail('INVALID_ARGUMENT','Une citation ne prouve ni observation ni reproduction ni réfutation.');
  if(status==='observed'&&!records.some(e=>e.type==='observation'&&e.relation==='supports'))fail('INVALID_ARGUMENT','Observation favorable requise.');
  if(status==='refuted'&&!records.some(e=>e.relation==='refutes'&&e.type==='counterexample'))fail('INVALID_ARGUMENT','Contre-exemple requis.');
  if(status==='independently_reproduced'){
   if(!records.some(e=>e.type==='reproduction'&&e.relation==='supports'&&run_refs.some(r=>r.id===e.run_ref?.id)))fail('INVALID_ARGUMENT','Preuve de reproduction et run correspondant requis.');
   if(!run_refs.length||run_refs.some(r=>{const run=JSON.parse(get(user,r.id,'run').data);return run.validity!=='reported_valid'||!run.independent_of_source||run.source_ref.id!==data.source_ref.id;}))fail('INVALID_ARGUMENT','Run valide déclaré indépendant de la source de cette affirmation requis.');
  }
  return store('claim',{...data,status,rationale:text(args.rationale,'rationale',2000),evidence_refs,run_refs,assessment_scope:'authenticated assessment of imported reports; not verified by Atlas'},args,user,self,claim);
 }
 if(name==='decision_registry'){
  const existing=args.id?get(user,args.id,'decision'):null;
  if(args.action==='update'&&!existing)fail('INVALID_ARGUMENT','ID décision requis.');
  if(args.action==='create'&&existing)fail('INVALID_ARGUMENT','Création sans ID attendue.');
  enumValue(args.action,['create','update'],'action');
  if(!Array.isArray(args.alternatives)||!args.alternatives.length||args.alternatives.length>12)fail('INVALID_ARGUMENT','1 à 12 alternatives requises.');
  if((args.claim_refs||[]).some(r=>!r.id?.startsWith('claim:'))||(args.evidence_refs||[]).some(r=>!r.id?.startsWith('evidence:')))fail('INVALID_ARGUMENT','Références d’affirmations et de preuves typées requises.');
  return store('decision',{title:text(args.title,'title',160),alternatives:args.alternatives.map(a=>text(a,'alternative',1000)),rationale:text(args.rationale,'rationale',4000),status:enumValue(args.status,['proposed','accepted','superseded','rejected'],'status'),owner:existing?JSON.parse(existing.data).owner:self.id,revisit_condition:text(args.revisit_condition,'revisit_condition',2000),claim_refs:refs(user,args.claim_refs),evidence_refs:refs(user,args.evidence_refs),resource_refs:refs(user,args.resource_refs)},args,user,self,existing);
 }
 if(name==='register_dataset'){
  if(existing&&existing.kind!=='dataset')fail('INVALID_ARGUMENT','ID dataset requis.');
  return store('dataset',{title:text(args.title,'title',160),version:nullable(args.version,'version',300),license:nullable(args.license,'license',500),sha256:digest(args.sha256??null),source_ref:ref(user,args.source_ref,'source'),description:text(args.description,'description',4000),...imported(args)},args,user,self,existing);
 }
 if(name==='register_protocol'){
  if(existing&&existing.kind!=='protocol')fail('INVALID_ARGUMENT','ID protocole requis.');
  return store('protocol',{title:text(args.title,'title',160),method:text(args.method,'method',4000),validity_conditions:text(args.validity_conditions,'validity_conditions',4000),comparison_conditions:text(args.comparison_conditions,'comparison_conditions',2000),resource_refs:refs(user,args.resource_refs),...imported(args)},args,user,self,existing);
 }
 if(name==='register_run'){
  if(existing&&existing.kind!=='run')fail('INVALID_ARGUMENT','ID run requis.');
  if(args.execution_location!=='external')fail('INVALID_ARGUMENT','Import externe uniquement ; aucune exécution locale.');
  const machine=object(args.machine,'machine'),code=object(args.code,'code');
  if(Object.keys(machine).some(k=>!['name','architecture'].includes(k))||Object.keys(code).some(k=>!['repository','revision'].includes(k)))fail('INVALID_ARGUMENT','Métadonnées machine/code inconnues.');
  if(args.seed!==null&&!Number.isSafeInteger(args.seed))fail('INVALID_ARGUMENT','seed entier ou null requis.');
  const budgets=object(args.budgets,'budgets');for(const [k,v] of Object.entries(budgets)){text(k,'budget',100);object(v,'budget');if(Object.keys(v).some(k=>!['value','unit'].includes(k))||v.value!==null&&(!Number.isFinite(v.value)||v.value<0))fail('INVALID_ARGUMENT','Budget : valeur positive ou null, unité requise.');text(v.unit,'unit',100);}
  if(!Array.isArray(args.metrics)||!args.metrics.length||args.metrics.length>30)fail('INVALID_ARGUMENT','1 à 30 métriques requises.');
  const metrics=args.metrics.map(m=>{object(m,'metric');if(Object.keys(m).some(k=>!['metric','value','unit'].includes(k))||m.value!==null&&!Number.isFinite(m.value))fail('INVALID_ARGUMENT','Mesure numérique finie ou null requise.');return {metric:text(m.metric,'metric',100),value:m.value,unit:text(m.unit,'unit',100)};});
  if(new Set(metrics.map(m=>m.metric)).size!==metrics.length)fail('INVALID_ARGUMENT','Noms de métriques uniques requis.');
  if(typeof args.independent_of_source!=='boolean')fail('INVALID_ARGUMENT','independent_of_source : déclaration booléenne requise.');
  return store('run',{title:text(args.title,'title',160),execution_location:'external',machine:{name:text(machine.name,'machine.name',200),architecture:nullable(machine.architecture,'machine.architecture',200)},code:{repository:url(code.repository),revision:nullable(code.revision,'code.revision',300)},seed:args.seed,parameters:object(args.parameters,'parameters'),budgets,metrics,validity:enumValue(args.validity,['unknown','reported_valid','reported_invalid'],'validity'),validity_basis:text(args.validity_basis,'validity_basis',2000),independent_of_source:args.independent_of_source,source_ref:ref(user,args.source_ref,'source'),dataset_ref:ref(user,args.dataset_ref,'dataset'),protocol_ref:ref(user,args.protocol_ref,'protocol'),resource_refs:refs(user,args.resource_refs),...imported(args)},args,user,self,existing);
 }
 fail('INVALID_ARGUMENT','Opération inconnue.');
}
function compare(user,args,request){
 if(!Array.isArray(args.run_ids)||args.run_ids.length!==2||args.run_ids[0]===args.run_ids[1])fail('INVALID_ARGUMENT','Deux IDs run distincts requis.');
 const runs=args.run_ids.map(id=>view(get(user,id,'run'))),reasons=[];
 for(const run of runs){for(const ref of [run.source_ref,run.dataset_ref,run.protocol_ref,...run.resource_refs])C.fresh(user,[ref]);if(run.validity!=='reported_valid')reasons.push('validity_not_reported_valid');if(run.seed===null||run.code.revision===null)reasons.push('unknown_execution_conditions');}
 for(const key of ['dataset_ref','protocol_ref','seed','parameters','budgets','code'])if(stable(runs[0][key])!==stable(runs[1][key]))reasons.push('different_'+key);
 const knownBudgets=runs.every(run=>Object.keys(run.budgets).length&&Object.values(run.budgets).every(v=>v.value!==null));if(!knownBudgets)reasons.push('unknown_budgets');
 const comparable=!reasons.length;
 const metrics=runs[0].metrics.map(a=>{const b=runs[1].metrics.find(b=>b.metric===a.metric);return {metric:a.metric,unit:a.unit,left:a.value,right:b?.value??null,delta:comparable&&b&&a.unit===b.unit&&a.value!==null&&b.value!==null?b.value-a.value:null,comparable:comparable&&!!b&&a.unit===b.unit&&a.value!==null&&b.value!==null};});
 return R.envelope(request,{run_refs:runs.map(run=>C.reference(user,run.id)),comparable,reasons:[...new Set(reasons)],metrics,comparison_scope:'identical declared protocol, dataset, code, seed, parameters and budgets; imported validity only',execution_performed:false,epistemic_state:comparable?'known':'unknown',content_trust:'untrusted_data'},R.high());
}
function contradictions(user,args,request){
 const subject=text(args.subject,'subject',200),scope=text(args.scope,'scope',1000);
 const candidates=db.prepare("SELECT id FROM metis_science_objects WHERE kind='claim' AND json_extract(data,'$.subject')=? AND json_extract(data,'$.scope')=? AND atlas_readable_ref(id,?)=1 LIMIT 101").all(subject,scope,user);
 if(candidates.length>100)fail('TRUNCATED','Plus de 100 affirmations dans cette portée ; préciser subject/scope.',true);
 return page(user,args,'contradictions',(after,count)=>db.prepare(`SELECT a.id||'|'||b.id page_key,a.id,1 revision,a.created_at,a.updated_at,json_object('left',json(a.data),'right',json(b.data),'left_id',a.id,'right_id',b.id,'advisory',json('true'),'assessment','opposite declared polarities for an identical subject/scope/predicate; no automatic verdict') data FROM metis_science_objects a JOIN metis_science_objects b ON a.id<b.id AND a.kind='claim' AND b.kind='claim' AND json_extract(a.data,'$.subject')=json_extract(b.data,'$.subject') AND json_extract(a.data,'$.scope')=json_extract(b.data,'$.scope') AND json_extract(a.data,'$.predicate')=json_extract(b.data,'$.predicate') AND json_extract(a.data,'$.polarity')!=json_extract(b.data,'$.polarity') AND json_extract(a.data,'$.polarity')!='unspecified' AND json_extract(b.data,'$.polarity')!='unspecified' WHERE json_extract(a.data,'$.subject')=? AND json_extract(a.data,'$.scope')=? AND a.id||'|'||b.id>? AND atlas_readable_ref(a.id,?)=1 AND atlas_readable_ref(b.id,?)=1 ORDER BY page_key LIMIT ?`).all(subject,scope,after,user,user,count),request);
}
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
const allowed={register_source:['id','title','url','doi','version','access_date','author','license','sha256','description','origin','resource_refs'],get_source:['id','revision'],find_related_sources:['query','scope','limit','cursor'],register_claim:['id','title','statement','subject','scope','predicate','polarity','status','source_ref','resource_refs','origin'],link_evidence:['claim_id','title','source_ref','run_ref','type','relation','passage','locator','confidence','origin','external_record_id'],verify_claim:['id','status','rationale','evidence_refs','run_refs'],find_contradictions:['subject','scope','limit','cursor'],decision_registry:['action','id','title','alternatives','rationale','status','revisit_condition','claim_refs','evidence_refs','resource_refs','query','scope','limit','cursor'],decision_history:['id','limit','cursor'],register_dataset:['id','title','version','license','sha256','source_ref','description','origin'],register_protocol:['id','title','method','validity_conditions','comparison_conditions','resource_refs','origin'],register_run:['id','title','execution_location','machine','code','seed','parameters','budgets','metrics','validity','validity_basis','independent_of_source','source_ref','dataset_ref','protocol_ref','resource_refs','origin'],compare_runs:['run_ids'],get_research_object:['id','revision']};
function call(name,args,user){
 const request=crypto.randomUUID();let active=false;
 try{
  if(!M().peutLire(user))fail('PERMISSION_DENIED','Accès Métis requis.');
  if(!enabled()||!NAMES.has(name))fail('DEPENDENCY_UNAVAILABLE','Lot scientifique désactivé.');
  object(args,'arguments');if(Buffer.byteLength(JSON.stringify(args))>24000||Object.keys(args).some(k=>!allowed[name].includes(k)&&!['expected_revision','idempotency_key','visibility','max_bytes','max_tokens'].includes(k)))fail('INVALID_ARGUMENT','Arguments inconnus ou supérieurs à 24 Ko.');
  init();R.rate(user,name);db.exec('SAVEPOINT metis_science_operation');active=true;
  const write=WRITES.has(name)&&!(name==='decision_registry'&&args.action==='list');let out;
  if(write){
   C.writer(user);const self=C.identity(user),key=text(args.idempotency_key,'idempotency_key',120),fingerprint=require('./metis-idempotency').fingerprint(args),legacyFingerprint=R.hash(stable(args));
   const previous=db.prepare('SELECT * FROM metis_research_requests WHERE actor=? AND operation=? AND request_key=?').get(self.id,name,key);
   if(previous){if(!require('./metis-idempotency').matches(previous.fingerprint,fingerprint,legacyFingerprint))fail('IDEMPOTENCY_CONFLICT','Clé déjà employée avec une autre requête.');const data=JSON.parse(previous.response);const ids=[data.id,data.claim?.id,data.evidence?.id,...F.dependencies(data)].filter(Boolean);if(ids.some(id=>!F.canRead(user,id)))fail('PERMISSION_DENIED','Résultat idempotent devenu inaccessible.');out=R.envelope(request,data,R.high());require('./metis-idempotency').upgrade(db,self.id,name,key,previous.fingerprint,fingerprint);}
   else{const data=execute(name,args,user,self);out=R.envelope(request,data,R.high());R.assertBudget(out,args);db.prepare('INSERT INTO metis_research_requests VALUES(?,?,?,?,?)').run(self.id,name,key,fingerprint,JSON.stringify(data));}
  }else if(['get_source','get_research_object'].includes(name)){
   const current=get(user,args.id,name==='get_source'?'source':undefined);
   if(args.revision===undefined)out=R.envelope(request,view(current),R.high());
   else{const revision=R.integer(args.revision,undefined,1,current.revision,'revision'),saved=db.prepare('SELECT payload FROM metis_research_revisions WHERE object_id=? AND revision=?').get(current.id,revision);if(!saved)fail('NOT_FOUND','Révision absente.');const data=JSON.parse(saved.payload);if(!F.dependencies(data).every(id=>F.canRead(user,id)))fail('PERMISSION_DENIED','Révision devenue inaccessible.');out=R.envelope(request,{...data,historical:revision!==current.revision,current_revision:current.revision},R.high());}
  }
  else if(name==='find_related_sources')out=list(user,args,'source',request);
  else if(name==='decision_registry'){enumValue(args.action,['list'],'action');out=list(user,args,'decision',request);}
  else if(name==='decision_history'){
   get(user,args.id,'decision');out=page(user,args,'decision-history',(after,count)=>db.prepare(`SELECT payload FROM metis_research_revisions WHERE object_id=? AND printf('%012d',revision)>? AND atlas_readable_payload(payload,?)=1 ORDER BY revision LIMIT ?`).all(args.id,after,user,count).map(r=>{const value=JSON.parse(r.payload);return {...value,page_key:String(value.revision).padStart(12,'0')};}),request);
  }else if(name==='compare_runs')out=compare(user,args,request);
  else if(name==='find_contradictions')out=contradictions(user,args,request);
  R.assertBudget(out,args);
  db.exec('RELEASE metis_science_operation');active=false;return out;
 }catch(e){if(active)db.exec('ROLLBACK TO metis_science_operation; RELEASE metis_science_operation');const known=e instanceof R.ContractError;return {ok:false,error:{code:known?e.code:'DEPENDENCY_UNAVAILABLE',message:known?e.message:'Dépendance Atlas indisponible.',retryable:known?e.retryable:true,...(known&&e.details?{details:e.details}:{})},request_id:request,schema_version:'1'};}
}
function overview(user){return {available:true,epistemic_state:'known',recent:db.prepare("SELECT id,json_extract(data,'$.title') title,json_extract(data,'$.status') status,revision FROM metis_science_objects WHERE kind='decision' AND atlas_readable_ref(id,?)=1 ORDER BY updated_at DESC,id LIMIT 4").all(user),details_tool:'decision_registry'};}
module.exports={call:(name,args,user)=>require('./metis-observability').observe(user,name,()=>F.withScope(user,()=>call(name,args,user))),init,enabled,NAMES,WRITES,KINDS,STATES,overview,aclSql};
