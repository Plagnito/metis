'use strict';
const crypto=require('node:crypto');
const {db}=require('../core/db'),R=require('./metisresearch'),C=require('./metiscollaboration'),S=require('./metisscience'),F=require('./metis-access-fence'),J=require('./metis-research-journal');
let architectureModule;
const A=()=>architectureModule??=require('./metisarchitecture'),M=()=>require('./metisdocs');
const reading=require('./metis-reading');
const NAMES=new Set(['save_session_state','resume_work','append_research_note','architecture_diff','dependency_path','coverage_matrix','protocol_contract','trace_scenario','architecture_consistency','migration_plan','suggest_connections','mcp_diagnostics','knowledge_export','change_subscriptions',...reading.NAMES]);
const WRITES=new Set(['save_session_state','append_research_note','change_subscriptions']);
const enabled=()=>process.env.METIS_RESEARCH_ENABLED==='1'&&process.env.METIS_COLLAB_ENABLED==='1'&&process.env.METIS_CONTINUITY_ENABLED==='1';
const fail=(code,message,retryable=false)=>{throw new R.ContractError(code,message,retryable);};
const now=()=>new Date().toISOString(),text=(v,k,max=2000)=>C.text(v,k,max),digest=v=>crypto.createHash('sha256').update(v).digest('hex');
let ready=false;
function init(){
 if(ready)return;C.init();if(S.enabled())S.init();db.exec('SAVEPOINT metis_continuity_migration');
 try{
  db.exec(`CREATE TABLE IF NOT EXISTS metis_continuity_objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('session','research_note','subscription')),owner_account INTEGER NOT NULL,owner_agent TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('private','metis_readers')),data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_continuity_owner ON metis_continuity_objects(owner_account,kind,id);
   CREATE INDEX IF NOT EXISTS idx_research_notes_work ON metis_continuity_objects(kind,json_extract(data,'$.work_ref.id'),id);`);
  J.install(db);const prior=db.prepare('SELECT version FROM metis_research_contract WHERE id=1').get().version;
  if(prior<5){db.prepare('UPDATE metis_research_contract SET version=5 WHERE id=1').run();db.prepare("INSERT INTO metis_research_events(domain,kind,object_id,resource_id,revision_before,revision_after,actor_id,client_id,occurred_at) VALUES('contract','contract.updated','contract:metis-mcp','contract:metis-mcp',?,5,atlas_actor_id(),atlas_client_id(),?)").run(prior,now());}
  db.exec('RELEASE metis_continuity_migration');ready=true;
 }catch(e){db.exec('ROLLBACK TO metis_continuity_migration; RELEASE metis_continuity_migration');J.invalidate(db);throw e;}
}
function row(id){return db.prepare('SELECT * FROM metis_continuity_objects WHERE id=?').get(id);}
function get(user,id,kind){text(id,'id',240);const r=row(id);if(!r||kind&&r.kind!==kind||!F.canRead(user,id))fail('NOT_FOUND','Objet absent ou inaccessible.');return r;}
function publicRow(r){const {page_key,...rest}=r;return C.publicRow(rest);}
function work(user,id){text(id,'work_item_id',240);const r=id.startsWith('work:')&&db.prepare('SELECT * FROM metis_work_items WHERE id=?').get(id);if(!r||!F.canRead(user,id))fail('NOT_FOUND','Travail absent ou inaccessible.');return r;}
function strings(value,key,max=12,length=1000){if(!Array.isArray(value)||value.length>max)fail('INVALID_ARGUMENT',key+': liste bornée requise.');return value.map(v=>text(v,key,length));}
function ids(value,key='object_ids',max=12){const list=strings(value,key,max,240);if(!list.length||new Set(list).size!==list.length)fail('INVALID_ARGUMENT',key+': IDs uniques non vides requis.');return list;}
function aclSql(alias,user){const account=Number(user);if(!Number.isSafeInteger(account))fail('PERMISSION_DENIED','Compte invalide.');return `((${alias}.owner_account=${account} OR (${alias}.kind='research_note' AND atlas_readable_ref(json_extract(${alias}.data,'$.work_ref.id'),${account})=1)) AND atlas_readable_payload(${alias}.data,${account})=1)`;}
function save(kind,data,args,user,self,existing){
 if(existing){if(existing.owner_account!==self.account)fail('PERMISSION_DENIED','État réservé au propriétaire.');C.cas(existing,args);}
 else if(kind!=='research_note'&&args.expected_revision!==0)fail('REVISION_CONFLICT','Création : expected_revision=0 requis.');
 const limits={session:100,subscription:50,research_note:2000};if(!existing)C.quota('SELECT count(*) n FROM metis_continuity_objects WHERE owner_account=? AND kind=?',[self.account,kind],limits[kind]);
 data.summary_dependencies=[...new Set([...(existing?F.dependencies(JSON.parse(existing.data)):[]),...F.dependencies(data)])];
 const id=existing?.id||kind+':'+crypto.randomUUID(),t=now();
 if(existing)db.prepare('UPDATE metis_continuity_objects SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),t,id);
 else db.prepare('INSERT INTO metis_continuity_objects VALUES(?,?,?,?,?,?,1,?,?)').run(id,kind,self.account,self.id,kind==='research_note'?work(user,data.work_ref.id).visibility:'private',JSON.stringify(data),t,t);
 const saved=row(id);C.writeRevision(saved,self);return publicRow(saved);
}
function page(user,args,type,read,request,map=publicRow,extra={},wrap=data=>data){
 const high=R.high(),policy=F.generation(),signature=R.hash({type,args:Object.fromEntries(Object.entries(args).filter(([k])=>!['cursor','limit','max_bytes','max_tokens'].includes(k)))}),limit=R.integer(args.limit,20,1,100,'limit');
 const state=args.cursor?R.decode(args.cursor,'continuity',user):null;
 if(state&&(state.high!==high||state.policy!==policy||state.signature!==signature))fail('STALE_CURSOR','La vue ou ses droits ont changé ; recommencer.',true);
 const rows=read(state?.after||'',limit+1),items=[];let after=state?.after||'';
 const make=more=>R.envelope(request,wrap({...extra,items,has_more:more,advisory:!['notes','subscriptions'].includes(type),content_trust:'untrusted_data'}),high,{next_cursor:more?R.cursor({type:'continuity',signature,high,policy,after},user):null,truncated:more});
 for(const [index,r] of rows.slice(0,limit).entries()){const before=after;items.push(map(r));after=r.page_key??r.id;const candidate=make(index+1<rows.length);if(Buffer.byteLength(JSON.stringify(candidate))>R.budget(args)){if(items.length===1)R.assertBudget(candidate,args);items.pop();after=before;return make(true);}}
 return make(rows.length>limit);
}
function execute(name,args,user,self){
 if(name==='save_session_state'){
  const existing=args.id?get(user,args.id,'session'):null,resource_refs=C.pinned(user,args.resource_refs||[]);
  const work_ref=args.work_item_id?C.reference(user,work(user,args.work_item_id).id):null;
  return save('session',{title:text(args.title,'title',160),goal:text(args.goal,'goal',2000),last_results:strings(args.last_results,'last_results',10,1000),open_questions:strings(args.open_questions,'open_questions',10,1000),next_action:text(args.next_action,'next_action',2000),resource_refs,work_ref,continuity_source:'voluntarily saved state; no automatic conversation memory'},args,user,self,existing);
 }
 if(name==='append_research_note'){
  const w=work(user,args.work_item_id);C.cas(w,args);
  if(w.owner_account!==self.account&&!db.prepare('SELECT 1 FROM metis_handoffs WHERE work_id=? AND to_agent=?').get(w.id,self.id))fail('PERMISSION_DENIED','Note réservée au propriétaire ou destinataire de mission.');
  C.quota("SELECT count(*) n FROM metis_continuity_objects WHERE kind='research_note' AND json_extract(data,'$.work_ref.id')=?",[w.id],100);
  return save('research_note',{title:text(args.title,'title',160),body:text(args.body,'body',4000),work_ref:C.reference(user,w.id),resource_refs:C.pinned(user,args.resource_refs||[]),author:self.id,note_semantics:'append-only; does not change WorkItem state'},args,user,self);
 }
 if(name==='change_subscriptions'){
  if(!['create','update'].includes(args.action))fail('INVALID_ARGUMENT','action : create|update|list|get|poll.');
  const existing=args.action==='update'?get(user,args.id,'subscription'):null;
  const domains=args.domains===undefined?[...R.DOMAINS]:strings(args.domains,'domains',R.DOMAINS.length,40);
  if(!domains.length||new Set(domains).size!==domains.length||domains.some(d=>!R.DOMAINS.includes(d)))fail('INVALID_ARGUMENT','Domaines connus et uniques requis.');
  const object_ids=args.object_ids===undefined?[]:strings(args.object_ids,'object_ids',12,240);if(new Set(object_ids).size!==object_ids.length)fail('INVALID_ARGUMENT','IDs uniques requis.');for(const id of object_ids)F.assertReadable(user,id);
  const status=args.status??'active';if(!['active','paused'].includes(status))fail('INVALID_ARGUMENT','status : active|paused.');
  let feed_cursor=args.feed_cursor;
  if(feed_cursor){const decoded=R.decode(feed_cursor,'changes',user);if(R.hash([...decoded.domains].sort())!==R.hash([...domains].sort()))fail('INVALID_ARGUMENT','Le curseur doit porter les mêmes domaines.');}
  else{const feed=R.call('changes_since',{domains},user);if(!feed.ok)fail(feed.error.code,feed.error.message);feed_cursor=feed.next_cursor;}
  return save('subscription',{title:text(args.title,'title',160),domains:[...domains].sort(),object_ids,feed_cursor,status,summary_dependencies:object_ids,delivery_model:'polling by caller; no scheduler, notification or continuous watch'},args,user,self,existing);
 }
 fail('INVALID_ARGUMENT','Mutation inconnue.');
}
function resume(user,args,request){
 if(!!args.session_id===!!args.work_item_id)fail('INVALID_ARGUMENT','session_id ou work_item_id, exclusivement.');
 let session=null,w=null;
 if(args.session_id){session=get(user,args.session_id,'session');const d=JSON.parse(session.data);if(d.work_ref)w=work(user,d.work_ref.id);}
 else{w=work(user,args.work_item_id);session=db.prepare(`SELECT * FROM metis_continuity_objects s WHERE kind='session' AND owner_account=? AND json_extract(data,'$.work_ref.id')=? AND ${aclSql('s',user)} ORDER BY updated_at DESC,id DESC LIMIT 1`).get(user,w.id);}
 const state=session?publicRow(session):null,refs=state?[...(state.resource_refs||[]),...(state.work_ref?[state.work_ref]:[])]:[],stale=[];
 for(const ref of refs){F.assertReadable(user,ref.id);const current=C.reference(user,ref.id);if(current.revision!==ref.revision||current.content_sha256!==ref.content_sha256)stale.push({id:ref.id,expected_revision:ref.revision,current_revision:current.revision});}
 const wrap=notes=>({session:state,work:w?C.publicRow(w):null,freshness:{valid:!stale.length,stale_refs:stale,epistemic_state:stale.length?'stale':state?'known':'unknown'},notes,memory_scope:'saved records only; no hidden conversation history'});
 if(w)return page(user,args,'notes',(after,count)=>db.prepare(`SELECT * FROM metis_continuity_objects n WHERE kind='research_note' AND json_extract(data,'$.work_ref.id')=? AND id>? AND ${aclSql('n',user)} ORDER BY id LIMIT ?`).all(w.id,after,count),request,publicRow,{},wrap);
 if(args.cursor)fail('INVALID_ARGUMENT','Aucune collection de notes à paginer.');return R.envelope(request,wrap({items:[],has_more:false}),R.high());
}
const typed=/^(document|sigle|expert|benchmark|pool|competence|measure|metric|architecture|work|handoff|review|agent|source|claim|evidence|decision|dataset|protocol|run|session|research_note|subscription):/;
function metadataRefs(data){const refs=[];for(const field of ['canonical_owner',...A().LISTS])for(const r of Array.isArray(data[field])?data[field]:data[field]?[data[field]]:[])if(typed.test(r))refs.push(r);for(const r of data.relations||[])if(typed.test(r.target))refs.push(r.target);return [...new Set(refs)];}
function graph(user){
 const snapshot=A().snapshot(user),nativeIds=new Set(snapshot.map(n=>n.id)),readableNative=F.nativeReadableSet(user,[...nativeIds]),blocked=new Set(),reverse=new Map();
 const canRead=id=>readableNative.has(id)||F.canRead(user,id);
 for(const n of snapshot){const refs=metadataRefs(n.metadata);if(!canRead(n.id)||!refs.every(canRead))blocked.add(n.id);for(const id of refs){const target=id.startsWith('architecture:')?id.slice(13):id;if(nativeIds.has(target)){if(!reverse.has(target))reverse.set(target,[]);reverse.get(target).push(n.id);}}}
 // Propagate hidden metadata dependencies in linear time, including cycles.
 const queue=[...blocked];for(let i=0;i<queue.length;i++)for(const parent of reverse.get(queue[i])||[])if(!blocked.has(parent)){blocked.add(parent);queue.push(parent);}
 const nodes=snapshot.filter(n=>!blocked.has(n.id));
 if(nodes.length>2000)fail('TRUNCATED','Graphe accessible au-delà de 2 000 nœuds ; réduire le registre.',true);
 const byId=new Map(nodes.map(n=>[n.id,n])),edges=A().edgesFor(nodes).filter(e=>byId.has(e.from)&&byId.has(e.to));
 if(edges.length>10000)fail('TRUNCATED','Graphe au-delà de 10 000 liens.',true);return {nodes,edges,byId};
}
function node(g,id){text(id,'object_id',240);const n=g.byId.get(id);if(!n)fail('NOT_FOUND','Objet absent ou inaccessible dans le graphe.');return n;}
function paths(g,start,depth,direction='outgoing',type='depends_on',target=null){
 const queue=[{id:start,path:[]}],seen=new Set([start]),adj=new Map();for(const e of g.edges){if(type&&e.type!==type)continue;for(const [from,to] of direction==='both'?[[e.from,e.to],[e.to,e.from]]:direction==='incoming'?[[e.to,e.from]]:[[e.from,e.to]]){if(!adj.has(from))adj.set(from,[]);adj.get(from).push({to,e});}}
 for(let i=0;i<queue.length;i++){const current=queue[i];if(current.id===target)return [current];if(current.path.length>=depth)continue;for(const {to,e} of adj.get(current.id)||[]){if(seen.has(to))continue;seen.add(to);const next={id:to,path:[...current.path,{...e,traversal_from:current.id}]};if(to===target)return [next];queue.push(next);if(!target&&queue.length>101)fail('TRUNCATED','Plus de 100 impacts ; réduire max_depth.',true);}}
 return queue;
}
function architecture(user,name,args,request){
 const g=graph(user),high=R.high(),out=data=>R.envelope(request,{...data,advisory:true,writes:false,runtime_state:'unknown; recorded declarations and links only',content_trust:'untrusted_data'},high);
 if(name==='architecture_diff'){
  const n=node(g,args.object_id),from=R.integer(args.from_revision,undefined,0,n.architecture_version,'from_revision'),to=R.integer(args.to_revision,n.architecture_version,0,n.architecture_version,'to_revision');
  if(from===undefined)fail('INVALID_ARGUMENT','from_revision requis.');
  const read=revision=>{if(revision===0)return {};const r=db.prepare('SELECT metadata FROM metis_architecture WHERE id=? AND version=? UNION ALL SELECT metadata FROM metis_architecture_versions WHERE id=? AND version=?').get(n.id,revision,n.id,revision);if(!r)fail('NOT_FOUND','Révision d’architecture absente.');const data=JSON.parse(r.metadata);for(const id of metadataRefs(data))F.assertReadable(user,id);return data;};
  const before=read(from),after=read(to);return out({object_id:n.id,from_revision:from,to_revision:to,native_revision:n.version,diff:A().FIELDS.filter(k=>stable(before[k]??null)!==stable(after[k]??null)).map(field=>({field,before:before[field]??null,after:after[field]??null})),scope:'architecture metadata only; document bodies and runtime not compared'});
 }
 if(name==='dependency_path'){
  const from=node(g,args.from_id),to=node(g,args.to_id),depth=R.integer(args.max_depth,6,1,8,'max_depth');const found=paths(g,from.id,depth,'outgoing','depends_on',to.id).find(p=>p.id===to.id);
  return out({from_id:from.id,to_id:to.id,path:found?.path??null,recorded_path_found:!!found,max_depth:depth,absence_interpretation:'No path within this accessible recorded graph and depth does not prove independence'});
 }
 if(name==='coverage_matrix'){
  const rows=ids(args.object_ids).map(id=>{const n=node(g,id),benchmarks=g.edges.filter(e=>e.from===id&&e.type==='measured_by').map(e=>e.to);const samples=n.kind==='expert'?db.prepare(`SELECT m.id,m.benchmark,m.metrique,m.valeur,m.le,
    CASE WHEN b.metrique=m.metrique THEN NULLIF(b.unite,'') END unite,
    CASE WHEN b.metrique=m.metrique AND b.unite!='' THEN 'current_benchmark_definition' END unit_source
    FROM metis_expert_mesures m LEFT JOIN metis_benchmarks b ON b.id=m.benchmark
    WHERE m.expert=? ORDER BY m.id DESC LIMIT 4`).all(id.slice(7)):[];
   return {id,architecture_revision:n.architecture_version,declared_lifecycle:n.lifecycle,benchmark_refs:benchmarks,evidence_refs:n.evidence_refs,recorded_measurements:samples.slice(0,3),measurement_samples_truncated:samples.length>3,measurement_state:samples.length?'known':'unknown',runtime_coverage:null};});return out({rows,coverage_scope:'recorded benchmark links and at most three imported measurement rows per expert; not test or runtime coverage'});
 }
 if(name==='trace_scenario'){
  const steps=ids(args.steps,'steps');steps.forEach(id=>node(g,id));const transitions=steps.slice(1).map((to,i)=>({from:steps[i],to,recorded_links:g.edges.filter(e=>e.from===steps[i]&&e.to===to)}));return out({steps,transitions,all_transitions_documented:transitions.every(t=>t.recorded_links.length),execution_performed:false});
 }
 if(name==='architecture_consistency'){
  const findings=A().auditData(g.nodes,g.edges).map(f=>({...f,id:'finding:'+R.hash(f)})).sort((a,b)=>a.id.localeCompare(b.id));
  const raw_counts={};for(const f of findings)raw_counts[f.code]=(raw_counts[f.code]||0)+1;
  return page(user,args,'consistency',(after,count)=>findings.filter(f=>f.id>after).slice(0,count),request,r=>({...r,epistemic_state:'known',provenance:'audit_registre algorithm over accessible graph',interpretation:'documentary signal; not a proven defect'}),{raw_count:findings.length,raw_counts,coverage:'accessible recorded graph only; legacy audit counts unchanged'});
 }
 if(name==='migration_plan'){
  const n=node(g,args.object_id);if(args.expected_architecture_revision!==n.architecture_version)fail('REVISION_CONFLICT','La révision d’architecture a changé.');
  const proposed_change=text(args.proposed_change,'proposed_change',2000),depth=R.integer(args.max_depth,3,1,6,'max_depth'),impacts=paths(g,n.id,depth,'both').slice(1).map(p=>({id:p.id,path:p.path,precondition:{native_revision:g.byId.get(p.id).version,architecture_revision:g.byId.get(p.id).architecture_version}}));
  return out({object_id:n.id,proposed_change,precondition:{native_revision:n.version,architecture_revision:n.architecture_version},impacts,steps:[{action:'review_declared_contracts',object_ids:[n.id,...impacts.map(p=>p.id)]},{action:'qualify_change_externally',criteria:'tests and measurements required; execution not performed by this tool'},{action:'prepare_reversible_patch',criteria:'CAS for each affected canonical object and backup before activation'}],automatic_commit:false,qualification:'unknown'});
 }
 if(name==='suggest_connections'){
  const n=node(g,args.object_id),terms=[...new Set((n.label+' '+(n.canonical_subject||'')).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=4))].slice(0,8),linked=new Set(g.edges.filter(e=>e.from===n.id||e.to===n.id).flatMap(e=>[e.from,e.to]));
  const items=g.nodes.filter(c=>c.id!==n.id&&!linked.has(c.id)).map(c=>({id:c.id,title:c.label,shared_terms:terms.filter(t=>(c.label+' '+(c.canonical_subject||'')).normalize('NFKC').toLowerCase().includes(t)),suggested_relation:'needs_review',confidence:'unknown'})).filter(c=>c.shared_terms.length).sort((a,b)=>a.id.localeCompare(b.id));
  return page(user,args,'suggestions',(after,count)=>items.filter(c=>c.id>after).slice(0,count),request,r=>({...r,source_id:n.id,method:'literal label/subject overlap only; no factual relation inferred'}));
 }
 fail('INVALID_ARGUMENT','Vue inconnue.');
}
function protocol(user,args,request){
 text(args.object_id,'object_id',240);F.assertReadable(user,args.object_id);
 if(args.object_id.startsWith('protocol:')){if(!S.enabled())fail('DEPENDENCY_UNAVAILABLE','Registre scientifique désactivé.');const result=S.call('get_research_object',{id:args.object_id},user);if(!result.ok)fail(result.error.code,result.error.message);const p=result.data;return R.envelope(request,{object_id:p.id,revision:p.revision,declared_method:p.method,validity_conditions:p.validity_conditions,comparison_conditions:p.comparison_conditions,resource_refs:p.resource_refs,formal_inputs:null,formal_outputs:null,formal_errors:null,advisory:true,runtime_verified:false},R.high());}
 const g=graph(user),n=node(g,args.object_id),r=R.resource(user,n.id);return R.envelope(request,{object_id:n.id,native_revision:n.version,architecture_revision:n.architecture_version,declared_type:n.architectural_type,reads:g.edges.filter(e=>e.from===n.id&&e.type==='reads_state'),writes:g.edges.filter(e=>e.from===n.id&&e.type==='writes_state'),governed_by:g.edges.filter(e=>e.from===n.id&&e.type==='governed_by'),source_excerpt:r?(r.description+'\n'+r.body).slice(0,1200):null,formal_inputs:null,formal_outputs:null,formal_errors:null,advisory:true,runtime_verified:false,unknowns:['formal schema, ordering and error contract are not inferred from prose']},R.high());
}
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
function exportRow(user,id,view={}){
 F.assertReadable(user,id);
 if(id.startsWith('architecture:')){const key=id.slice(13),n=node(view.graph||(view.graph=graph(user)),key),r=R.resource(user,id),refs=metadataRefs(n.metadata);return {id,data:{...r,metadata:n.metadata,summary_dependencies:[key,...refs,...refs.filter(ref=>db.prepare('SELECT 1 FROM metis_architecture WHERE id=?').get(ref)).map(ref=>'architecture:'+ref)]},visibility:r.visibility};}
 if(/^(session|research_note|subscription):/.test(id)){const r=get(user,id);return {id,data:publicRow(r),visibility:r.visibility};}
 if(/^(work|handoff|review|agent):/.test(id)){const table={work:'metis_work_items',handoff:'metis_handoffs',review:'metis_reviews',agent:'metis_research_agents'}[id.split(':')[0]],r=db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id);return {id,data:C.publicRow(r),visibility:r.visibility??'private'};}
 if(/^(source|claim|evidence|decision|dataset|protocol|run):/.test(id)){if(!S.enabled())fail('DEPENDENCY_UNAVAILABLE','Registre scientifique désactivé.');const r=db.prepare('SELECT * FROM metis_science_objects WHERE id=?').get(id);return {id,data:C.publicRow(r),visibility:r.visibility};}
 const r=R.resource(user,id);if(!r)fail('NOT_FOUND','Ressource absente ou inaccessible.');return {id,data:r,visibility:r.visibility};
}
function publiclyExportable(user,id,seen=new Set(),view={}){
 if(seen.has(id))return true;if(seen.size>=64)fail('DEPENDENCY_UNAVAILABLE','Graphe d’export au-delà de la borne.');seen.add(id);
 const r=exportRow(user,id,view);return r.visibility==='metis_readers'&&F.dependencies(r.data).every(ref=>publiclyExportable(user,ref,seen,view));
}
function exportDependencies(user,selected,view){
 const records=new Map(selected.map(r=>[r.id,r])),queue=[...records.keys()];
 for(let i=0;i<queue.length;i++)for(const id of F.dependencies(records.get(queue[i]).data)){
  if(records.has(id))continue;if(records.size>=512)fail('DEPENDENCY_UNAVAILABLE','Dépendances d’export au-delà de la borne.');
  F.assertReadable(user,id);records.set(id,exportRow(user,id,view));queue.push(id);
 }
 return digest(stable([...records].map(([id,r])=>({id,hash:digest(stable(r.data)),visibility:r.visibility})).sort((a,b)=>a.id.localeCompare(b.id))));
}
function knowledgeExport(user,args,request){
 const object_ids=ids(args.object_ids);if(args.include_private!==undefined&&typeof args.include_private!=='boolean')fail('INVALID_ARGUMENT','include_private : booléen.');
 const selected=[],view={};for(const id of object_ids){const r=exportRow(user,id,view);if(args.include_private===true||publiclyExportable(user,id,new Set(),view))selected.push(r);}
 const records=selected.map(r=>{const payload=Buffer.from(stable({format:'atlas-research-record/1',resource:r.data,content_trust:'untrusted_data'}));return {r,payload,manifest:{id:r.id,revision:r.data.revision??null,visibility:r.visibility,content_sha256:digest(payload),bytes:payload.length,provenance:'Atlas canonical tables; current ACL checked'}};});
 const manifest=records.map(r=>r.manifest),signature=R.hash({object_ids,include_private:args.include_private===true}),high=R.high(),policy=F.generation(),manifest_hash=digest(stable(manifest)),dependency_hash=exportDependencies(user,selected,view);
 const state=args.cursor?R.decode(args.cursor,'export',user):null;
 // Old cursors retain their conservative global fence. New cursors bind the
 // exact selected payloads and dependencies; every page rechecks current ACLs.
 if(state&&(state.signature!==signature||state.manifest_hash!==manifest_hash||(state.export_contract===2?state.dependency_hash!==dependency_hash:state.export_contract!==undefined||state.high!==high||state.policy!==policy)))fail('STALE_CURSOR','Sources sélectionnées, dépendances ou droits modifiés ; recommencer l’export.',true);
 const index=state?.index??0,offset=state?.offset??0;
 if(!Number.isSafeInteger(index)||index<0||index>records.length||!Number.isSafeInteger(offset)||offset<0)fail('INVALID_ARGUMENT','Position d’export invalide.');
 const current=records[index];if(current&&offset>=current.payload.length)fail('INVALID_ARGUMENT','Position d’export invalide.');
 let length=current?Math.min(8192,current.payload.length-offset):0;
 const make=()=>{let end=offset+length;if(current)while(end<current.payload.length&&(current.payload[end]&0xc0)===0x80)end--;const bytes=Math.max(0,end-offset),eof=!current||end===current.payload.length,more=!!current&&(!eof||index+1<records.length),next=more?R.cursor({type:'export',export_contract:2,signature,dependency_hash,manifest_hash,index:eof?index+1:index,offset:eof?0:end},user):null;
  return R.envelope(request,{format:'atlas-research-export/1',subject_id:'atlas:'+Number(user),created_at:now(),manifest,manifest_sha256:manifest_hash,dependency_manifest_sha256:dependency_hash,consistency:'selected records and transitive dependencies; current rights checked on every page',private_content_explicitly_requested:args.include_private===true,chunk:current?{id:current.r.id,offset_bytes:offset,bytes,eof,encoding:'utf-8',data:current.payload.subarray(offset,end).toString('utf8')}:null,has_more:more,assembly:'concatenate UTF-8 chunks by ID and byte offset; verify per-record SHA256; parse canonical JSON',content_trust:'untrusted_data'},high,{next_cursor:next,truncated:more});};
 while(Buffer.byteLength(JSON.stringify(make()))>R.budget(args)&&length>16)length=Math.floor(length/2);
 const out=make();R.assertBudget(out,args);if(current&&!out.data.chunk.bytes)fail('TRUNCATED','Le manifeste ne laisse aucun octet pour un fragment UTF-8.',false,{effective_budget_bytes:R.budget(args),accounting:'utf8_bytes',adjust_parameters:['max_bytes','max_tokens']});return out;
}
function diagnostics(user,args,request){
 const O=require('./metis-observability'),tools=require('../web/metis-mcp').outils(M().peutEcrire(user)).filter(t=>R.NAMES.has(t.name)||C.NAMES.has(t.name)||S.NAMES.has(t.name)||NAMES.has(t.name)||require('./metisprojects').NAMES.has(t.name)||require('./metisdevelopment').NAMES.has(t.name)).sort((a,b)=>a.name.localeCompare(b.name));
 return page(user,args,'diagnostics',(after,count)=>tools.filter(t=>t.name>after).slice(0,count).map(t=>({id:t.name,...t})),request,t=>({tool:t.name,schema_sha256:digest(stable(t.inputSchema)),strict_arguments:t.inputSchema.additionalProperties===false,read_only:t.annotations?.readOnlyHint===true,metrics:O.metrics(user,t.name)}),{
 observation:{since:O.started,volatile:true,account_scope:'current Atlas account only',latency_scope:'synchronous tool result, excluding OAuth and network transport',retained_samples_per_tool:32,max_series:2000,semantic_false_success_detection:'unknown; only structural envelope violations measured'},
 recent_errors:O.recentErrors(user),slow_tools:O.slowTools(user),attention:C.attention(user),selftest:M().estMaster(user)?(require('../host').fournit('selftest')?require('../host').get('selftest').summary():{status:'unavailable',reason:'no_selftest_host'}):{status:'restricted'},
 contract_revision:db.prepare('SELECT version FROM metis_research_contract WHERE id=1').get().version,
 contract_guards:{current_acl:true,idempotent_writes:true,cas:true,signed_snapshot_pagination:true,rate_per_account_tool_minute:120,max_argument_bytes:24000,max_envelope_bytes:15000,context_ttl_seconds:3600,continuous_scheduler:false}});
}
const allowed={...reading.allowed,save_session_state:['id','expected_revision','idempotency_key','title','goal','last_results','open_questions','next_action','resource_refs','work_item_id'],resume_work:['session_id','work_item_id','limit','cursor'],append_research_note:['work_item_id','expected_revision','idempotency_key','title','body','resource_refs'],architecture_diff:['object_id','from_revision','to_revision'],dependency_path:['from_id','to_id','max_depth'],coverage_matrix:['object_ids'],protocol_contract:['object_id'],trace_scenario:['steps'],architecture_consistency:['limit','cursor'],migration_plan:['object_id','expected_architecture_revision','proposed_change','max_depth'],suggest_connections:['object_id','limit','cursor'],mcp_diagnostics:['limit','cursor'],knowledge_export:['object_ids','include_private','cursor'],change_subscriptions:['action','id','expected_revision','idempotency_key','title','domains','object_ids','status','feed_cursor','cursor','limit']};
function call(name,args,user){
 const request=crypto.randomUUID();let active=false;
 try{
  if(!M().peutLire(user))fail('PERMISSION_DENIED','Accès Métis requis.');if(!enabled()||!NAMES.has(name))fail('DEPENDENCY_UNAVAILABLE','Lot continuité désactivé.');
  if(['resume_work','prepare_resume'].includes(name)&&args&&Object.hasOwn(args,'project_id')){
   if(args.session_id||args.work_item_id)fail('INVALID_ARGUMENT','Projet, session ou mission : choisir une seule entrée.');
   return require('./metisdevelopment').call('projets_ouvrir',args,user);
  }
  if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>24000||Object.keys(args).some(k=>!allowed[name].includes(k)&&!['max_bytes','max_tokens'].includes(k)))fail('INVALID_ARGUMENT','Arguments inconnus ou supérieurs à 24 Ko.');
  init();R.rate(user,name);db.exec('SAVEPOINT metis_continuity_operation');active=true;
  const write=WRITES.has(name)&&!(name==='change_subscriptions'&&['list','get','poll'].includes(args.action));let out;
  if(write){
   const self=C.identity(user),key=text(args.idempotency_key,'idempotency_key',120),fingerprint=require('./metis-idempotency').fingerprint(args),legacyFingerprint=digest(stable(args)),previous=db.prepare('SELECT * FROM metis_research_requests WHERE actor=? AND operation=? AND request_key=?').get(self.id,name,key);
   if(previous){if(!require('./metis-idempotency').matches(previous.fingerprint,fingerprint,legacyFingerprint))fail('IDEMPOTENCY_CONFLICT','Clé employée pour une autre requête.');const data=JSON.parse(previous.response);F.assertReadable(user,data.id);for(const id of F.dependencies(data))F.assertReadable(user,id);out=R.envelope(request,data,R.high());require('./metis-idempotency').upgrade(db,self.id,name,key,previous.fingerprint,fingerprint);}
   else{const data=execute(name,args,user,self);out=R.envelope(request,data,R.high());R.assertBudget(out,args);db.prepare('INSERT INTO metis_research_requests VALUES(?,?,?,?,?)').run(self.id,name,key,fingerprint,JSON.stringify(data));}
  }else if(reading.NAMES.has(name))out=reading.run(name,args,user,request);
  else if(name==='resume_work')out=resume(user,args,request);
  else if(name==='knowledge_export')out=knowledgeExport(user,args,request);
  else if(name==='mcp_diagnostics')out=diagnostics(user,args,request);
  else if(name==='protocol_contract')out=protocol(user,args,request);
  else if(name==='change_subscriptions'){
   if(!['list','get','poll'].includes(args.action))fail('INVALID_ARGUMENT','action : create|update|list|get|poll.');
   if(args.action==='list')out=page(user,args,'subscriptions',(after,count)=>db.prepare(`SELECT * FROM metis_continuity_objects s WHERE kind='subscription' AND id>? AND ${aclSql('s',user)} ORDER BY id LIMIT ?`).all(after,count),request);
   else{const subscription=publicRow(get(user,args.id,'subscription'));
    if(args.action==='get')out=R.envelope(request,subscription,R.high());
    else{if(subscription.status!=='active')fail('INVALID_ARGUMENT','Abonnement en pause.');const feed=R.call('changes_since',{cursor:args.cursor??subscription.feed_cursor,domains:subscription.domains,limit:args.limit??25,max_tokens:Math.max(512,R.budget(args)-512)},user);if(!feed.ok)fail(feed.error.code,feed.error.message,feed.error.retryable);feed.data.events=feed.data.events.filter(e=>!subscription.object_ids.length||subscription.object_ids.includes(e.object_id)||subscription.object_ids.includes(e.resource_id));feed.data.subscription_id=subscription.id;feed.data.scheduler_attached=false;feed.data.cursor_persisted=false;out=feed;}
   }
  }else out=architecture(user,name,args,request);
  R.assertBudget(out,args);
  db.exec('RELEASE metis_continuity_operation');active=false;return out;
 }catch(e){if(active)db.exec('ROLLBACK TO metis_continuity_operation; RELEASE metis_continuity_operation');const known=e instanceof R.ContractError;return {ok:false,error:{code:known?e.code:'DEPENDENCY_UNAVAILABLE',message:known?e.message:'Dépendance Atlas indisponible.',retryable:known?e.retryable:true,...(known&&e.details?{details:e.details}:{})},request_id:request,schema_version:'1'};}
}
module.exports={call:(name,args,user)=>require('./metis-observability').observe(user,name,()=>F.withScope(user,()=>call(name,args,user))),init,enabled,NAMES,WRITES,aclSql,metadataRefs};
