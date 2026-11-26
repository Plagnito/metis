'use strict';
// The counter is an invalidation marker. Atlas' existing ACLs remain authoritative.
const {db}=require('../core/db');
const M=()=>require('./metisdocs');
const R=()=>require('./metisresearch');
const tables={work:'metis_work_items',handoff:'metis_handoffs',review:'metis_reviews',agent:'metis_research_agents'};
let registered=false,scope=null;
const statements=new Map();
function query(sql){if(!statements.has(sql))statements.set(sql,db.prepare(sql));return statements.get(sql);}
function generation(){return query('SELECT generation FROM metis_research_policy WHERE id=1').get().generation;}
// This cache lives only inside one synchronous transaction. A write invalidates it.
function withScope(user,fn){const previous=scope;scope={user:Number(user),generation:null,readable:null,writer:null,allowed:new Map()};try{return fn();}finally{scope=previous;}}
function readable(user){
 if(scope?.user!==Number(user))return M().peutLire(user);
 const current=generation();if(scope.generation!==current){scope.generation=current;scope.readable=M().peutLire(user);scope.writer=M().peutEcrire(user);scope.allowed.clear();}
 return scope.readable;
}
function writer(user){return scope?.user===Number(user)&&scope.writer!==null?scope.writer:M().peutEcrire(user);}
// Ephemeral selection inside the caller's read transaction. Never an ACL cache.
// Graph snapshots already contain native IDs; checking them in one SQL call avoids
// a JavaScript/SQLite round trip for every node and every native edge.
function nativeReadableSet(user,ids){
 if(!readable(user))return new Set();
 const sql=`WITH wanted(id) AS (SELECT value FROM json_each(?)), native(id) AS (
 SELECT 'document:'||slug FROM metis_docs WHERE statut='publie' OR ?=1
 UNION ALL SELECT 'sigle:'||sigle FROM metis_glossaire
 UNION ALL SELECT 'expert:'||id FROM metis_experts
 UNION ALL SELECT 'benchmark:'||id FROM metis_benchmarks
 UNION ALL SELECT 'pool:'||id FROM metis_pools
 UNION ALL SELECT 'competence:'||id FROM metis_competences
 UNION SELECT 'metric:'||metrique FROM metis_benchmarks WHERE metrique!=''
 UNION SELECT 'metric:'||metrique FROM metis_expert_mesures WHERE metrique!='')
 SELECT DISTINCT wanted.id FROM wanted JOIN native ON native.id=wanted.id`;
 return new Set(query(sql).all(JSON.stringify(ids),Number(writer(user))).map(row=>row.id).filter(id=>require('./metis-app-permissions').canRead(user,id)));
}
function dependencies(data){
 const refs=[];
 for(const key of ['resource_refs','pinned_refs','evidence_refs','claim_refs','summary_dependencies','blocking_ids','run_refs'])for(const r of data[key]||[])refs.push(typeof r==='string'?r:r.id||r.object_id);
 for(const key of ['source_ref','protocol_ref','dataset_ref','run_ref','work_ref'])if(data[key])refs.push(data[key].id);
 for(const key of ['subject_id','work_item_id'])if(data[key])refs.push(data[key]);
 if(data.work_snapshot)refs.push(...dependencies(data.work_snapshot));
 for(const reply of data.replies||[])refs.push(...dependencies(reply));
 return [...new Set(refs.filter(Boolean))];
}
function canRead(user,id,seen=new Set()){
 if(!readable(user)||typeof id!=='string')return false;
 if(!require('./metis-app-permissions').canRead(user,id))return false;
 if(scope?.user===Number(user)&&scope.allowed.has(id))return scope.allowed.get(id);
 const result=check(user,id,seen);
 // Do not memoize a cycle shortcut or a partially checked dependency subtree.
 if(!seen.size&&scope?.user===Number(user))scope.allowed.set(id,result);
 return result;
}
function check(user,id,seen){
 if(seen.has(id))return true;
 seen.visits=(seen.visits||0)+1;
 if(seen.size>=64||seen.visits>512)throw new (R().ContractError)('DEPENDENCY_UNAVAILABLE','Graphe de confidentialité au-delà de la borne.',false);
 seen.add(id);
 try{return checkRow(user,id,seen);}finally{seen.delete(id);}
}
function checkRow(user,id,seen){
 if(id.startsWith('project:')){const P=require('./metisprojects');if(!P.rawReadable(user,id))return false;const r=query('SELECT data FROM metis_projects WHERE id=?').get(id);return dependencies(JSON.parse(r.data)).every(ref=>canRead(user,ref,seen));}
 if(/^(task|project_note|milestone):/.test(id)){const r=require('./metisprojects').childContainer(id);return !!r&&canRead(user,r.project_id,seen);}
 if(/^project_(context|checkpoint|evidence|document|session):/.test(id)){const D=require('./metisdevelopment');if(!D.rawReadable(user,id))return false;const r=query('SELECT project_id,data FROM metis_development_objects WHERE id=?').get(id);return canRead(user,r.project_id,seen)&&dependencies(JSON.parse(r.data)).every(ref=>canRead(user,ref,seen));}
 if(id.startsWith('command:')){
  if(!query("SELECT 1 FROM sqlite_master WHERE name='metis_command_records'").get())return false;
  const row=query('SELECT * FROM metis_command_records WHERE id=? AND owner_account=?').get(id,user);
  return !!row&&dependencies(JSON.parse(row.data)).every(ref=>canRead(user,ref,seen));
 }
 if(/^(channel|thread|message|connection|delivery|usage):/.test(id))return require('./metisnexus').canRead(user,id);
 const kind=id.split(':')[0];let data=null;
 if(kind==='document'){const d=query('SELECT statut FROM metis_docs WHERE slug=?').get(id.slice(9));return !!d&&(d.statut==='publie'||writer(user));}
 if(kind==='architecture'){const key=id.slice(13);return !!query('SELECT 1 FROM metis_architecture WHERE id=?').get(key)&&(!key.startsWith('document:')||canRead(user,key,seen));}
 if(kind==='note'){const n=query('SELECT d.slug FROM metis_notes n JOIN metis_docs d ON d.id=n.doc WHERE n.id=?').get(id.slice(5));return !!n&&canRead(user,'document:'+n.slug,seen);}
 if(kind==='measure'){const m=query('SELECT expert FROM metis_expert_mesures WHERE id=?').get(id.slice(8));return !!m&&canRead(user,'expert:'+m.expert,seen);}
 if(kind==='metric')return !!query('SELECT 1 FROM metis_benchmarks WHERE metrique=? UNION ALL SELECT 1 FROM metis_expert_mesures WHERE metrique=? LIMIT 1').get(id.slice(7),id.slice(7));
 const native={sigle:['metis_glossaire','sigle'],expert:['metis_experts','id'],benchmark:['metis_benchmarks','id'],pool:['metis_pools','id'],competence:['metis_competences','id']};
 if(native[kind]){const [table,key]=native[kind];return !!query('SELECT 1 FROM '+table+' WHERE '+key+'=?').get(id.slice(kind.length+1));}
 if(tables[kind]){
  const C=require('./metiscollaboration');if(!C.rawCanReadResource(user,id))return false;
  const row=query('SELECT * FROM '+tables[kind]+' WHERE id=?').get(id);data=JSON.parse(row.data||'{}');
  if(kind==='review'&&!canRead(user,row.subject_id,seen))return false;
 }else if(['session','research_note','subscription'].includes(kind)){
  if(!query("SELECT 1 FROM sqlite_master WHERE name='metis_continuity_objects'").get())return false;
  const row=query('SELECT * FROM metis_continuity_objects WHERE id=?').get(id);if(!row)return false;data=JSON.parse(row.data);
  if(row.owner_account!==Number(user)&&(kind!=='research_note'||!canRead(user,data.work_ref?.id,seen)))return false;
 }else if(['source','claim','evidence','decision','dataset','protocol','run'].includes(kind)){
  if(!query("SELECT 1 FROM sqlite_master WHERE name='metis_science_objects'").get())return false;
  const row=query('SELECT * FROM metis_science_objects WHERE id=?').get(id);
  if(!row||(row.owner_account!==Number(user)&&row.visibility!=='metis_readers'))return false;data=JSON.parse(row.data);
 }else return id.startsWith('contract:');
 return dependencies(data).every(ref=>canRead(user,ref,seen));
}
function assertReadable(user,id){if(!canRead(user,id))throw new (R().ContractError)('PERMISSION_DENIED','Ressource ou dépendance devenue inaccessible.',false);}
function register(){if(registered)return;db.function('atlas_readable_ref',(id,user)=>Number(canRead(Number(user),id)));db.function('atlas_readable_payload',(payload,user)=>Number(dependencies(JSON.parse(payload)).every(id=>canRead(Number(user),id))));registered=true;}
function stamp(out){if(out.ok)out.policy_generation=generation();return out;}
function denied(out){return require('./metis-recovery').decorate({ok:false,request_id:out.request_id,schema_version:'1',error:{code:'PERMISSION_DENIED',message:'Politique modifiée avant restitution ; vérifier les droits.',retryable:false}});}
function deliver(result,send,authorize){
 const out=result?.structuredContent;if(!out?.ok||out.policy_generation===undefined)return send(result);
 let active=false,sent=false;
 try{
  db.exec('BEGIN IMMEDIATE');active=true;
  if((authorize&&!authorize())||out.policy_generation!==generation()){const error=denied(out);result={isError:true,content:[{type:'text',text:JSON.stringify(error)}],structuredContent:error};}
  sent=true;const returned=send(result);db.exec('COMMIT');active=false;return returned;
 }catch(e){if(active)db.exec('ROLLBACK');if(sent)throw e;const error=require('./metis-recovery').decorate({...denied(out),error:{code:'DEPENDENCY_UNAVAILABLE',message:'Contrôle ACL indisponible.',retryable:true}});return send({isError:true,content:[{type:'text',text:JSON.stringify(error)}],structuredContent:error});}
}
module.exports={generation,dependencies,canRead,assertReadable,register,stamp,deliver,withScope,readable,nativeReadableSet};
