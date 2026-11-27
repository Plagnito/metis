'use strict';
// Reads immutable Git objects from one fixed origin. Never executes source,
// follows repository URLs/symlinks, evaluates manifests, or calls a model.
const crypto=require('node:crypto'),I=require('../core/sqlite-context');
const E=require('./metis-securite-engine'),S=require('./metis-securite');
const redact=require('./metis-nexus-redaction').createRedactor(()=>[require('./metis-securite').jetonGithub(),process.env.METIS_SECURITY_WEBHOOK_SECRET]);
const SHA=/^[a-f0-9]{40}$/;
const fail=(code,message,status=400)=>{throw new S.ErreurSecurite(code,message,status);};
const digest=(bytes)=>crypto.createHash('sha256').update(bytes).digest('hex');
const sensitive=(path)=>/(^|\/)(?:\.env[^/]*|\.git|[^/]*(?:credential|secret|password|service[-_]?account|id_rsa|id_ed25519)[^/]*)(\/|$)|\.(?:pem|p12|pfx|key)$/i.test(path);
const source=(path)=>/\.(?:[cm]?js|jsx|tsx?|py|go|rs|java|php|rb|cs|ya?ml|json)$/i.test(path)&&!/(^|\/)(?:vendor|node_modules|dist|build|package-lock\.json|[^/]*\.min\.js)(\/|$)/.test(path)&&!sensitive(path);
const rules=[
 ['network_entry',/\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|use|route)\s*\(|\b(?:serveHTTP|createServer)\s*\(/i],
 ['identity_check',/\b(?:authorization|authenticate|estMaster|canRead|csrf|verifyToken|session|permission)\b/i],
 ['network_egress',/\b(?:fetch|axios|requests\.(?:get|post)|https?\.(?:request|get))\s*\(/i],
 ['process_launch',/\b(?:child_process|subprocess|execFile|spawn|os\.system|Runtime\.exec)\b/i],
 ['data_store',/\b(?:db\.prepare|sqlite|writeFile|readFile|INSERT INTO|SELECT .+ FROM)\b/i],
];
let pending=false;
function pathValid(path){return typeof path==='string'&&path.length>0&&path.length<=512&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some(p=>p==='..'||p==='.'||!p)&&!/[\u0000-\u001f\u007f]/.test(path);}
function treeOf(data,sha){
  if(data?.sha!==sha||typeof data.truncated!=='boolean'||!Array.isArray(data.tree)||data.tree.length>4000)fail('SOURCE_INVALID','Arbre Git absent, incohérent ou trop grand.',502);
  const rows=new Map();
  for(const r of data.tree){
    if(!pathValid(r.path)||!SHA.test(r.sha||'')||!['blob','tree','commit'].includes(r.type)||!['100644','100755','120000','040000','160000'].includes(r.mode)||rows.has(r.path))fail('SOURCE_INVALID','Entrée Git invalide.',502);
    if((r.type==='tree')!==(r.mode==='040000')||(r.type==='commit')!==(r.mode==='160000')||r.type==='blob'&&(!Number.isSafeInteger(r.size)||r.size<0))fail('SOURCE_INVALID','Type Git incohérent.',502);
    rows.set(r.path,{path:r.path,sha:r.sha,type:r.type,mode:r.mode,...(r.type==='blob'?{size:r.size}:{})});
  }
  return {complete:!data.truncated,rows};
}
async function collect(task,{fetchImpl=fetch,check=()=>{},token,now=()=>Date.now()}={}){
  if(!SHA.test(task.head_sha||'')||!SHA.test(task.base_sha||''))fail('FAILED_PRECONDITION','Une base et un HEAD exacts sont obligatoires pour comparer deux instantanés.',409);
  const repository=S.resoudreDepot(task.depot);
  if(repository.archive||S.importanceDe(repository).niveau==='mort')fail('FAILED_PRECONDITION','Dépôt archivé ou exclu des audits.',409);
  const depot=repository.nom_complet,root='https://api.github.com/repos/'+depot.split('/').map(encodeURIComponent).join('/');
  const started=now(),receipts=[],limits={max_requests:12,max_response_bytes:1048576,max_total_bytes:2500000,max_tree_entries:4000,max_source_bytes:65536,max_sources:8};
  let bytes=0,requests=0;
  async function get(path,cap=limits.max_response_bytes){
    check();if(++requests>limits.max_requests||now()-started>=90000)fail('SOURCE_LIMIT','Budget de lecture atteint.',409);
    const headers={Accept:'application/vnd.github+json','User-Agent':'metis-security-center','X-GitHub-Api-Version':'2022-11-28'};
    if(token)headers.Authorization='Bearer '+token;
    let r;try{r=await fetchImpl(root+path,{headers,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(8000,90000-(now()-started))))});}catch{fail('SOURCE_UNAVAILABLE','Lecture GitHub indisponible.',502);}
    if(!r.ok){await r.body?.cancel();fail(r.status===429||r.status===403&&r.headers.get('x-ratelimit-remaining')==='0'?'RATE_LIMITED':'SOURCE_UNAVAILABLE','GitHub n’a pas fourni la source demandée.',502);}
    if(r.url&&r.url!==root+path){await r.body?.cancel();fail('SOURCE_INVALID','Redirection de source refusée.',502);}
    if(Number(r.headers.get('content-length'))>cap){await r.body?.cancel();fail('SOURCE_LIMIT','Source au-delà de la limite de lecture.',409);}
    const reader=r.body?.getReader();if(!reader)fail('SOURCE_INVALID','Corps de source absent.',502);
    const chunks=[];let size=0;
    try{while(true){check();const {value,done}=await reader.read();if(done)break;size+=value.length;bytes+=value.length;if(size>cap||bytes>limits.max_total_bytes)fail('SOURCE_LIMIT','Budget de lecture atteint.',409);chunks.push(Buffer.from(value));}}
    catch(e){await reader.cancel().catch(()=>{});if(e instanceof S.ErreurSecurite)throw e;fail('SOURCE_UNAVAILABLE','Lecture de source interrompue.',502);}
    const raw=Buffer.concat(chunks);let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('SOURCE_INVALID','Réponse GitHub invalide.',502);}
    receipts.push({endpoint:path,sha256:digest(raw),bytes:size});return data;
  }
  async function snapshot(sha){
    const commit=await get('/git/commits/'+sha);
    if(commit?.sha!==sha||!SHA.test(commit.tree?.sha||''))fail('SOURCE_INVALID','Commit différent de la révision demandée.',502);
    return {commit_sha:sha,tree_sha:commit.tree.sha,...treeOf(await get('/git/trees/'+commit.tree.sha+'?recursive=1'),commit.tree.sha)};
  }
  const base=await snapshot(task.base_sha),head=task.base_sha===task.head_sha?base:await snapshot(task.head_sha);
  const out={method:'git-tree-snapshot-v1',depot,base_sha:task.base_sha,head_sha:task.head_sha,base_tree_sha:base.tree_sha,head_tree_sha:head.tree_sha,
    content_trust:'untrusted_repository_data',coverage:{tree_complete:base.complete&&head.complete,changed_count:null,changes_list_complete:false,sources_read:0,boundaries_complete:false},
    changes:[],sources:[],boundary_candidates:[],gaps:[],receipts,limits,interpretation:'Static preparation only. Candidates are lexical observations, not verified trust boundaries, findings, executed tests or approval to merge.'};
  if(!out.coverage.tree_complete){out.gaps.push({reason:'github_tree_truncated',detail:'Aucun delta exhaustif déduit des arbres partiels.'});return out;}
  const paths=[...new Set([...base.rows.keys(),...head.rows.keys()])].sort(),changes=[];
  for(const path of paths){const before=base.rows.get(path),after=head.rows.get(path);if(before?.type==='tree'&&after?.type==='tree')continue;
    if(before?.sha===after?.sha&&before?.mode===after?.mode)continue;
    if(before?.type==='tree'&&!after||after?.type==='tree'&&!before)continue;
    changes.push({path,status:!before?'added':!after?'removed':before.type!==after.type?'type_changed':before.sha===after.sha?'mode_changed':'modified',before:before?{sha:before.sha,mode:before.mode,type:before.type}:null,after:after?{sha:after.sha,mode:after.mode,type:after.type}:null});
  }
  out.coverage.changed_count=changes.length;out.changes=changes.slice(0,40);out.coverage.changes_list_complete=changes.length<=40;
  const changed=changes.map(c=>({entry:head.rows.get(c.path)||base.rows.get(c.path),at:head.rows.has(c.path)?head:base,scope:'changed'}));
  const changedPaths=new Set(changes.map(c=>c.path));
  const context=[...head.rows.values()].filter(r=>!changedPaths.has(r.path)&&source(r.path)&&/(^|\/)(?:[^/]*(?:auth|secur|route)[^/]*|server|index|app|package)\.(?:[cm]?js|tsx?|py|json)$/i.test(r.path)).map(entry=>({entry,at:head,scope:'unchanged_context'}));
  const selected=[],used=new Set();
  for(const item of [...changed.filter(r=>source(r.entry.path)).slice(0,6),...context,...changed]){
    if(selected.length===limits.max_sources)break;if(used.has(item.entry.path)||!source(item.entry.path)||item.entry.type!=='blob')continue;
    used.add(item.entry.path);selected.push(item);
  }
  for(const {entry,at,scope}of selected){
    if(!['100644','100755'].includes(entry.mode)){out.gaps.push({path:entry.path,reason:'symlink_not_followed'});continue;}
    if(entry.size>limits.max_source_bytes){out.gaps.push({path:entry.path,reason:'source_too_large'});continue;}
    const blob=await get('/git/blobs/'+entry.sha,100000);
    if(blob?.sha!==entry.sha||blob.encoding!=='base64'||blob.size!==entry.size||typeof blob.content!=='string'||!/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content))fail('SOURCE_INVALID','Blob Git incohérent.',502);
    const raw=Buffer.from(blob.content.replace(/[\r\n]/g,''),'base64');
    if(raw.length!==entry.size||crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex')!==entry.sha)fail('INTEGRITY_ERROR','Le contenu ne correspond pas au blob Git.',502);
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(text.includes('\0'))throw Error();}catch{out.gaps.push({path:entry.path,reason:'binary_or_non_utf8'});continue;}
    const url='https://github.com/'+depot+'/blob/'+at.commit_sha+'/'+entry.path.split('/').map(encodeURIComponent).join('/');
    out.sources.push({path:entry.path,commit_sha:at.commit_sha,blob_sha:entry.sha,sha256:digest(raw),scope,url,bytes:raw.length});
    const lines=text.split(/\r?\n/);let kept=0;
    for(let n=0;n<lines.length&&kept<2&&out.boundary_candidates.length<16;n++)for(const [kind,pattern]of rules){if(pattern.test(lines[n])){const clean=redact(lines[n]);out.boundary_candidates.push({kind,path:entry.path,commit_sha:at.commit_sha,blob_sha:entry.sha,line:n+1,quote:clean.slice(0,160),quote_redacted:lines[n]!==clean,quote_truncated:clean.length>160,url:url+'#L'+(n+1),verdict:'candidate_requires_review'});kept++;break;}}
  }
  out.coverage.sources_read=out.sources.length;
  out.gaps.push({reason:'bounded_static_sample',detail:'Au plus huit sources textuelles ; fichiers sensibles exclus ; pas de résolution de flux, sous-modules, dépendances installées ou preuve runtime.'});
  if(changes.some(c=>sensitive(c.path)))out.gaps.push({reason:'sensitive_paths_not_read'});
  if(changes.some(c=>c.after?.mode==='160000'||c.before?.mode==='160000'))out.gaps.push({reason:'submodules_not_read'});
  while(Buffer.byteLength(JSON.stringify(out))>23500){if(out.boundary_candidates.length)out.boundary_candidates.pop();else if(out.changes.length){out.changes.pop();out.coverage.changes_list_complete=false;}else fail('SOURCE_LIMIT','Manifeste trop grand.',409);}
  return out;
}
async function prepare(account,args,{current,fetchImpl=fetch}={}){
  // Capture only a verified transport identity; never accept client/actor fields.
  const replay=E.analysisReplay(account,args),observed=I.identity();
  if(typeof current!=='function'||!current())fail('PERMISSION_DENIED','Transport courant vérifiable requis.',403);
  if(replay)return replay;
  const task=E.analysisLease(account,args);
  if(pending)fail('BUSY','Une lecture différentielle est déjà en cours.',409);
  const check=()=>{if(!current())fail('PERMISSION_DENIED','Transport révoqué pendant la lecture.',403);return I.withIdentity(account,observed.client,()=>E.analysisLease(account,args));};
  pending=true;
  try{
    const token=require('./metis-securite').jetonGithub();
    const data=await collect(task,{fetchImpl,check,token});check();
    return I.withIdentity(account,observed.client,()=>E.saveAnalysis(account,args,data));
  }finally{pending=false;}
}
module.exports={prepare,collect};
