'use strict';

// State/control only. No model, repository code, shell or network is executed.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const identity = require('../core/sqlite-context');
const S = require('./metis-securite');
const canonical = require('./metis-idempotency');
const redact = require('./metis-nexus-redaction').createRedactor(() => [process.env.METIS_SECURITY_WEBHOOK_SECRET]);
const enabled = () => process.env.METIS_SECURITY_ENGINE_ENABLED === '1';
const KINDS = ['audit', 'counter_audit', 'test_generation', 'before_after', 'ci_repair', 'revalidation'];
const STATES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'];
const HASH = /^[a-f0-9]{40}$/;
let ready = false;
let clock = () => Date.now();
const fail = (code, message, status = 400) => { throw new S.ErreurSecurite(code, message, status); };
const text = (x, max = 300) => {
  if (typeof x !== 'string' || !x.trim() || x.length > max) fail('INVALID_ARGUMENT', 'Texte borné requis.');
  return x.trim();
};
const object = (x, keys) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((k) => !keys.includes(k))) fail('INVALID_ARGUMENT', 'Champs inconnus ou objet invalide.');
};
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
function init() {
  if (!enabled() || ready) return;
  S.init();
  db.exec('SAVEPOINT security_engine_schema');
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS securite_engine_control (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, stopped INTEGER NOT NULL,
      reason TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO securite_engine_control VALUES(1,1,0,'',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TABLE IF NOT EXISTS securite_engine_tasks (
      id TEXT PRIMARY KEY, depot TEXT NOT NULL, kind TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT,
      goal TEXT NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL, revision INTEGER NOT NULL,
      fence INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER, checkpoint TEXT NOT NULL DEFAULT '{}',
      result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(state IN ('queued','running','paused','succeeded','failed','cancelled')));
    CREATE UNIQUE INDEX IF NOT EXISTS securite_engine_one_running ON securite_engine_tasks((1)) WHERE state='running';
    CREATE INDEX IF NOT EXISTS securite_engine_queue ON securite_engine_tasks(state,priority DESC,created_at,id);
    CREATE TABLE IF NOT EXISTS securite_engine_dependencies (
      task_id TEXT NOT NULL REFERENCES securite_engine_tasks(id), dependency_id TEXT NOT NULL REFERENCES securite_engine_tasks(id),
      PRIMARY KEY(task_id,dependency_id), CHECK(task_id<>dependency_id));
    CREATE TABLE IF NOT EXISTS securite_engine_keys (
      actor TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(actor,operation,request_key));
    CREATE TABLE IF NOT EXISTS securite_engine_events (
      seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT, data TEXT NOT NULL, previous_sha256 TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS securite_engine_events_no_update BEFORE UPDATE ON securite_engine_events
      BEGIN SELECT RAISE(ABORT,'Immutable security event'); END;
    CREATE TRIGGER IF NOT EXISTS securite_engine_events_no_delete BEFORE DELETE ON securite_engine_events
      BEGIN SELECT RAISE(ABORT,'Immutable security event'); END;
    CREATE TABLE IF NOT EXISTS securite_engine_deliveries (
      delivery TEXT PRIMARY KEY, event TEXT NOT NULL, body_sha256 TEXT NOT NULL, result TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS securite_engine_analyses (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES securite_engine_tasks(id),body TEXT NOT NULL,
      sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS securite_engine_analyses_no_update BEFORE UPDATE ON securite_engine_analyses
      BEGIN SELECT RAISE(ABORT,'Immutable security analysis'); END;
    CREATE TRIGGER IF NOT EXISTS securite_engine_analyses_no_delete BEFORE DELETE ON securite_engine_analyses
      BEGIN SELECT RAISE(ABORT,'Immutable security analysis'); END;
    `);
    db.exec('RELEASE security_engine_schema');
  } catch(e) { db.exec('ROLLBACK TO security_engine_schema; RELEASE security_engine_schema'); throw e; }
  ready = true;
}
function guard(account) {
  if (!enabled()) fail('FEATURE_DISABLED', 'Moteur Security Center désactivé.', 404);
  if (!require('./metisdocs').estMaster(account)) fail('PERMISSION_DENIED', 'Réservé au propriétaire de l’instance.', 403);
  const who = identity.identity();
  if (who?.actor !== 'atlas:' + Number(account) || !who.client) fail('PERMISSION_DENIED', 'Identité de transport observée requise.', 403);
  init();
  return who.actor + '/' + who.client;
}
const now = () => new Date(clock()).toISOString();
const control = () => { const r=db.prepare('SELECT revision,stopped,reason,updated_at FROM securite_engine_control WHERE id=1').get();return redact({...r,stopped:!!r.stopped}); };
function running() {
  if (control().stopped) fail('STOPPED', 'Arrêt d’urgence actif ; aucun nouveau travail admis.', 409);
}
function append(actor, source, action, target, data) {
  const last = db.prepare('SELECT seq,sha256 FROM securite_engine_events ORDER BY seq DESC LIMIT 1').get();
  const row = { seq: (last?.seq || 0) + 1, at: now(), actor, source, action, target: target || null,
    data: JSON.stringify(redact(data)), previous_sha256: last?.sha256 || '0'.repeat(64) };
  const sha = hash(row);
  db.prepare('INSERT INTO securite_engine_events VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.seq,row.at,row.actor,row.source,row.action,row.target,row.data,row.previous_sha256,sha);
  return row.seq;
}
function transaction(fn) {
  // The application normally uses NORMAL. An acknowledged delivery must also
  // survive a power loss, so sync this commit and restore the connection setting.
  const previous=db.prepare('PRAGMA synchronous').get().synchronous;
  db.exec('PRAGMA synchronous=FULL');
  let started=false;
  try { db.exec('BEGIN IMMEDIATE'); started=true; const out = fn(); db.exec('COMMIT'); started=false; return out; }
  catch (e) { if(started)db.exec('ROLLBACK'); throw e; }
  finally { db.exec('PRAGMA synchronous='+previous); }
}
function mutate(account, operation, args, fn) {
  const actor = guard(account), key = text(args.idempotency_key, 120), fingerprint = canonical.fingerprint(args);
  if (Buffer.byteLength(JSON.stringify(args)) > 16000) fail('INVALID_ARGUMENT', 'Arguments au-delà de 16 Ko.');
  return transaction(() => {
    const prior = db.prepare('SELECT fingerprint,result FROM securite_engine_keys WHERE actor=? AND operation=? AND request_key=?').get(actor,operation,key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Clé employée pour une autre intention.', 409);
      const result=JSON.parse(prior.result);
      if(operation==='claim'){
        const current=row(result.id);running();
        if(current.state!=='running'||current.fence!==result.fence||current.owner!==actor||current.lease_until<=clock())fail('STALE_LEASE','La réservation historique n’est plus active.',409);
      }
      return redact({ ...result, replayed: true });
    }
    const result = fn(actor);
    if(db.prepare('SELECT count(*) n FROM securite_engine_keys').get().n>=50000)fail('QUOTA_EXCEEDED','Plafond des commandes conservées atteint.',409);
    db.prepare('INSERT INTO securite_engine_keys VALUES(?,?,?,?,?)').run(actor,operation,key,fingerprint,JSON.stringify(result));
    return result;
  });
}
function row(id) {
  if (typeof id !== 'string' || !/^security:[a-f0-9-]{36}$/.test(id)) fail('INVALID_ARGUMENT', 'Identifiant de travail invalide.');
  const r = db.prepare('SELECT * FROM securite_engine_tasks WHERE id=?').get(id);
  if (!r) fail('NOT_FOUND', 'Travail absent.', 404);
  return r;
}
function view(r) {
  const dependencies = db.prepare('SELECT dependency_id FROM securite_engine_dependencies WHERE task_id=? ORDER BY dependency_id').all(r.id).map((d) => d.dependency_id);
  return redact({ ...r, checkpoint: JSON.parse(r.checkpoint), result: r.result ? JSON.parse(r.result) : null, dependencies });
}
function cas(r, args) {
  if (!Number.isSafeInteger(args.expected_revision) || r.revision !== args.expected_revision) fail('REVISION_CONFLICT', 'Relire la révision du travail.', 409);
}
function createTask(args, actor, source) {
  const repository = S.resoudreDepot(text(args.depot, 140)),depot=repository.nom_complet;
  if(repository.archive||S.importanceDe(repository).niveau==='mort')fail('FAILED_PRECONDITION','Dépôt archivé ou hors audit ; modifier son classement avant admission.',409);
  if (!KINDS.includes(args.kind) || !HASH.test(args.head_sha || '') || args.base_sha != null && !HASH.test(args.base_sha)) fail('INVALID_ARGUMENT', 'Type ou révision Git invalide.');
  const dependencies = args.dependencies || [];
  if (!Array.isArray(dependencies) || dependencies.length > 12 || new Set(dependencies).size !== dependencies.length) fail('INVALID_ARGUMENT', 'Au plus 12 dépendances distinctes.');
  for (const id of dependencies) row(id);
  if (db.prepare('SELECT count(*) n FROM securite_engine_tasks').get().n >= 10000) fail('QUOTA_EXCEEDED', 'Archivage opérateur requis avant de nouveaux travaux.', 409);
  const priority = args.priority ?? 50;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) fail('INVALID_ARGUMENT', 'Priorité entière entre 0 et 100.');
  const id = 'security:' + crypto.randomUUID(), at = now();
  db.prepare('INSERT INTO securite_engine_tasks(id,depot,kind,head_sha,base_sha,goal,state,priority,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,1,?,?)')
    .run(id,depot,args.kind,args.head_sha,args.base_sha || null,redact(text(args.goal, 1000)),'queued',priority,at,at);
  for (const dependency of dependencies) db.prepare('INSERT INTO securite_engine_dependencies VALUES(?,?)').run(id,dependency);
  append(actor,source,'task_created',id,{ depot,kind:args.kind,head_sha:args.head_sha,dependencies });
  return view(row(id));
}
function create(account, args) {
  object(args,['depot','kind','head_sha','base_sha','goal','priority','dependencies','idempotency_key']);
  return mutate(account,'create',args,(actor) => { running(); return createTask(args,actor,'operator'); });
}
function claim(account, args) {
  object(args,['id','expected_revision','lease_seconds','head_sha','idempotency_key']);
  return mutate(account,'claim',args,(actor) => {
    running();
    const r = row(args.id); cas(r,args);
    if (r.state !== 'queued') fail('FAILED_PRECONDITION', 'Le travail doit être en attente.', 409);
    if (r.head_sha !== args.head_sha) fail('REVISION_CONFLICT', 'Le HEAD demandé ne correspond pas au travail.', 409);
    if (db.prepare("SELECT 1 FROM securite_engine_tasks WHERE state='running'").get()) fail('BUSY', 'Un travail est déjà actif ; son expiration ne prouve pas son arrêt.', 409);
    if (db.prepare("SELECT 1 FROM securite_engine_dependencies d JOIN securite_engine_tasks t ON t.id=d.dependency_id WHERE d.task_id=? AND t.state<>'succeeded'").get(r.id)) fail('FAILED_PRECONDITION', 'Une dépendance n’est pas terminée avec succès.', 409);
    const seconds = args.lease_seconds ?? 120;
    if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 900) fail('INVALID_ARGUMENT', 'Bail de 10 à 900 secondes.');
    db.prepare("UPDATE securite_engine_tasks SET state='running',owner=?,lease_until=?,fence=fence+1,revision=revision+1,updated_at=? WHERE id=?")
      .run(actor,clock()+seconds*1000,now(),r.id);
    append(actor,'operator','task_claimed',r.id,{ fence:r.fence+1,lease_seconds:seconds });
    return view(row(r.id));
  });
}
function active(r, args, actor) {
  cas(r,args); running();
  if (r.state !== 'running' || r.owner !== actor || r.fence !== args.fence || r.lease_until <= clock()) fail('STALE_LEASE', 'Bail absent, expiré ou remplacé ; résultat refusé.', 409);
}
function checkpoint(account, args) {
  object(args,['id','expected_revision','fence','summary','refs','lease_seconds','idempotency_key']);
  return mutate(account,'checkpoint',args,(actor) => {
    const r = row(args.id); active(r,args,actor);
    const refs = args.refs || [];
    if (!Array.isArray(refs) || refs.length > 12 || refs.some((r) => typeof r !== 'string' || r.length > 240)) fail('INVALID_ARGUMENT', 'Références bornées requises.');
    const data = redact({ summary:text(args.summary,1000),refs,head_sha:r.head_sha,at:now() });
    const seconds=args.lease_seconds??120;
    if(!Number.isSafeInteger(seconds)||seconds<10||seconds>900)fail('INVALID_ARGUMENT','Bail de 10 à 900 secondes.');
    db.prepare('UPDATE securite_engine_tasks SET checkpoint=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),clock()+seconds*1000,now(),r.id);
    append(actor,'operator','task_checkpoint',r.id,{ fence:r.fence,head_sha:r.head_sha });
    return view(row(r.id));
  });
}
function transition(account, args) {
  object(args,['id','expected_revision','fence','state','summary','idempotency_key']);
  return mutate(account,'transition',args,(actor) => {
    const r = row(args.id); cas(r,args);
    const next = args.state, summary = redact(text(args.summary,1000));
    if (!['paused','queued','succeeded','failed','cancelled'].includes(next)) fail('INVALID_ARGUMENT', 'Transition invalide.');
    if (next === 'queued') { running(); if (r.state !== 'paused') fail('FAILED_PRECONDITION', 'Seul un travail suspendu peut reprendre.', 409); }
    else if (['succeeded','failed'].includes(next)) active(r,args,actor);
    else if (!['queued','running','paused'].includes(r.state)) fail('FAILED_PRECONDITION', 'Un travail terminal ne se réécrit pas.', 409);
    // An expired lease cannot finish; explicit pause/cancel revokes its fence.
    db.prepare('UPDATE securite_engine_tasks SET state=?,owner=NULL,lease_until=NULL,fence=fence+1,revision=revision+1,result=?,updated_at=? WHERE id=?')
      .run(next,JSON.stringify({ summary,at:now() }),now(),r.id);
    append(actor,'operator','task_'+next,r.id,{ fence:r.fence+1 });
    return view(row(r.id));
  });
}
function stop(account, args) {
  object(args,['expected_revision','stopped','reason','idempotency_key']);
  return mutate(account,'control',args,(actor) => {
    const current = control();
    if (args.expected_revision !== current.revision) fail('REVISION_CONFLICT', 'Relire le contrôle courant.', 409);
    if (typeof args.stopped !== 'boolean') fail('INVALID_ARGUMENT', 'stopped : booléen requis.');
    const reason = redact(text(args.reason,500));
    db.prepare('UPDATE securite_engine_control SET stopped=?,reason=?,revision=revision+1,updated_at=? WHERE id=1').run(args.stopped?1:0,reason,now());
    if (args.stopped) {
      for (const task of db.prepare("SELECT id,fence FROM securite_engine_tasks WHERE state='running'").all()) {
        db.prepare("UPDATE securite_engine_tasks SET state='paused',owner=NULL,lease_until=NULL,fence=fence+1,revision=revision+1,updated_at=? WHERE id=?").run(now(),task.id);
        append(actor,'operator','task_fenced',task.id,{ fence:task.fence+1 });
      }
      // Legacy routines have no fencing token. Closing their current passage
      // makes a late completion fail rather than overwrite the emergency stop.
      for(const audit of db.prepare("SELECT id FROM securite_creneaux WHERE etat='en_cours'").all()) {
        db.prepare("UPDATE securite_creneaux SET etat='reporte',fin_le=?,resume=? WHERE id=?").run(now(),'Arrêt d’urgence : '+reason,audit.id);
        append(actor,'legacy_auditeur','audit_interrupted',String(audit.id),{reason});
      }
      for(const passage of db.prepare("SELECT id FROM securite_passages WHERE etat='en_cours'").all()) {
        db.prepare("UPDATE securite_passages SET etat='interrompu',fin_le=?,erreur=? WHERE id=?").run(now(),'Arrêt d’urgence : '+reason,passage.id);
        append(actor,'legacy_gestionnaire','management_interrupted',String(passage.id),{reason});
      }
    }
    append(actor,'operator',args.stopped?'emergency_stop':'emergency_released',null,{ reason });
    return control();
  });
}
function status(account, args = {}) {
  guard(account); object(args,['state','limit','offset']);
  const limit = args.limit ?? 25, offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || args.state != null && !STATES.includes(args.state)) fail('INVALID_ARGUMENT', 'Pagination ou état invalide.');
  const tasks = db.prepare('SELECT * FROM securite_engine_tasks WHERE (? IS NULL OR state=?) ORDER BY priority DESC,created_at,id LIMIT ? OFFSET ?').all(args.state || null,args.state || null,limit,offset);
  const total = db.prepare('SELECT count(*) n FROM securite_engine_tasks WHERE (? IS NULL OR state=?)').get(args.state || null,args.state || null).n;
  const out={ enabled:true,control:control(),total,tasks:[],next_offset:null,
    execution:'state machine only; no repository code, model call or worker launched',
    expired_running:[] };
  for(const task of tasks){const item=view(task);if(Buffer.byteLength(JSON.stringify({...out,tasks:[...out.tasks,item]}))>30000)break;out.tasks.push(item);}
  out.next_offset=offset+out.tasks.length<total?offset+out.tasks.length:null;
  out.expired_running=out.tasks.filter((t)=>t.state==='running'&&t.lease_until<=clock()).map((t)=>t.id);
  return out;
}
function journal(account, args = {}) {
  guard(account); object(args,['after','limit']);
  const after=args.after ?? 0,limit=args.limit ?? 50;
  if (!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100) fail('INVALID_ARGUMENT','Pagination invalide.');
  const rows=db.prepare('SELECT * FROM securite_engine_events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit+1);
  const out={ events:[],next_after:null,guarantee:'append-only SQLite triggers and SHA256 chaining; not proof against a database administrator' };
  for(const r of rows.slice(0,limit)){const event={...r,data:redact(JSON.parse(r.data))};if(Buffer.byteLength(JSON.stringify({...out,events:[...out.events,event]}))>30000)break;out.events.push(event);}
  out.next_after=rows.length>out.events.length?out.events.at(-1)?.seq??after:null;
  return out;
}
function verifyJournal(account,args={}) {
  guard(account);object(args,[]);
  let previous='0'.repeat(64),seq=0;
  for (const r of db.prepare('SELECT * FROM securite_engine_events ORDER BY seq').iterate()) {
    const {sha256,...payload}=r;
    if (r.seq!==seq+1||r.previous_sha256!==previous||hash(payload)!==sha256) return {valid:false,sequence:r.seq};
    previous=sha256;seq=r.seq;
  }
  return {valid:true,events:seq,last_sha256:previous};
}
const analysisKeys=['id','expected_revision','fence','idempotency_key'];
function analysisLease(account,args) {
  object(args,analysisKeys);const actor=guard(account);text(args.idempotency_key,120);
  const r=row(args.id);active(r,args,actor);return view(r);
}
function analysisReplay(account,args) {
  object(args,analysisKeys);const actor=guard(account),key=text(args.idempotency_key,120);
  const prior=db.prepare('SELECT fingerprint,result FROM securite_engine_keys WHERE actor=? AND operation=? AND request_key=?').get(actor,'analysis',key);
  if(!prior)return null;
  if(prior.fingerprint!==canonical.fingerprint(args))fail('IDEMPOTENCY_CONFLICT','Clé employée pour une autre intention.',409);
  return redact({...JSON.parse(prior.result),replayed:true});
}
// Internal producer only: MCP never accepts a body supplied by the caller.
function saveAnalysis(account,args,body) {
  object(args,analysisKeys);
  return mutate(account,'analysis',args,(actor)=>{
    const r=row(args.id);active(r,args,actor);
    if(!body||body.depot!==r.depot||body.head_sha!==r.head_sha||body.base_sha!==r.base_sha||body.method!=='git-tree-snapshot-v1')fail('FAILED_PRECONDITION','Sources différentes du travail réservé.',409);
    const json=JSON.stringify(body);
    if(Buffer.byteLength(json)>24000)fail('QUOTA_EXCEEDED','Analyse au-delà de 24 Ko.',409);
    if(db.prepare('SELECT count(*) n FROM securite_engine_analyses').get().n>=2000)fail('QUOTA_EXCEEDED','Plafond des analyses conservées atteint.',409);
    const id='security-analysis:'+crypto.randomUUID(),digest=hash(json),at=now();
    db.prepare('INSERT INTO securite_engine_analyses VALUES(?,?,?,?,?)').run(id,r.id,json,digest,at);
    const checkpoint=redact({summary:'Analyse différentielle conservée ; couverture à lire avant conclusion.',refs:[id],head_sha:r.head_sha,at});
    db.prepare('UPDATE securite_engine_tasks SET checkpoint=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(checkpoint),at,r.id);
    append(actor,'github_read','analysis_saved',id,{task_id:r.id,sha256:digest,head_sha:r.head_sha,base_sha:r.base_sha,tree_complete:body.coverage.tree_complete});
    return {id,sha256:digest,task_id:r.id,task_revision:r.revision+1,head_sha:r.head_sha,base_sha:r.base_sha};
  });
}
function readAnalysis(account,args) {
  guard(account);object(args,['id']);
  if(typeof args.id!=='string'||!/^security-analysis:[a-f0-9-]{36}$/.test(args.id))fail('INVALID_ARGUMENT','Identifiant d’analyse invalide.');
  const r=db.prepare('SELECT * FROM securite_engine_analyses WHERE id=?').get(args.id);
  if(!r)fail('NOT_FOUND','Analyse absente.',404);
  if(hash(r.body)!==r.sha256)fail('INTEGRITY_ERROR','Le corps ne correspond plus au hash conservé.',409);
  return {id:r.id,task_id:r.task_id,sha256:r.sha256,created_at:r.created_at,data:redact(JSON.parse(r.body))};
}
function receiveGithub({body,signature,delivery,event}) {
  if (!enabled()) fail('FEATURE_DISABLED','Moteur désactivé.',404);
  const secret=process.env.METIS_SECURITY_WEBHOOK_SECRET;
  if (typeof secret!=='string'||Buffer.byteLength(secret)<32) fail('DEPENDENCY_UNAVAILABLE','Secret webhook dédié non configuré.',503);
  if (!Buffer.isBuffer(body)||body.length>262144) fail('INVALID_ARGUMENT','Payload au-delà de 256 Kio.',413);
  if (typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)) fail('SIGNATURE_INVALID','Signature refusée.',401);
  const expected=crypto.createHmac('sha256',secret).update(body).digest();
  if (!crypto.timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) fail('SIGNATURE_INVALID','Signature refusée.',401);
  if (typeof delivery!=='string'||!/^[a-f0-9-]{36}$/.test(delivery)||!['push','pull_request','workflow_run','ping'].includes(event)) fail('INVALID_ARGUMENT','Livraison ou événement non pris en charge.');
  let payload;try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)); } catch { fail('INVALID_ARGUMENT','JSON UTF-8 invalide.'); }
  object(payload,Object.keys(payload || {}));
  init();
  return transaction(()=>{
    const digest=hash(body),prior=db.prepare('SELECT * FROM securite_engine_deliveries WHERE delivery=?').get(delivery);
    if(prior){if(prior.body_sha256!==digest||prior.event!==event)fail('IDEMPOTENCY_CONFLICT','ID de livraison déjà lié à un autre payload.',409);return {...JSON.parse(prior.result),duplicate:true};}
    if(db.prepare('SELECT count(*) n FROM securite_engine_deliveries').get().n>=50000)fail('QUOTA_EXCEEDED','Plafond des livraisons conservées atteint.',503);
    let task=null,ignored=false;
    if(event!=='ping'){
      const repository=S.resoudreDepot(text(payload.repository?.full_name,140)),depot=repository.nom_complet;
      const head=event==='push'?payload.after:event==='pull_request'?payload.pull_request?.head?.sha:payload.workflow_run?.head_sha;
      if(event==='workflow_run'&&(!Number.isSafeInteger(payload.workflow_run?.id)||!HASH.test(head||'')))fail('INVALID_ARGUMENT','Événement workflow incomplet.');
      if(event==='pull_request'&&(!Number.isSafeInteger(payload.number)||!HASH.test(head||'')))fail('INVALID_ARGUMENT','Événement PR incomplet.');
      const relevant=event==='push'&&!payload.deleted&&typeof payload.ref==='string'&&payload.ref.startsWith('refs/heads/')||event==='pull_request'&&['opened','reopened','synchronize'].includes(payload.action);
      if(relevant&&!repository.archive&&S.importanceDe(repository).niveau!=='mort'){
        const known=db.prepare('SELECT * FROM securite_engine_tasks WHERE depot=? AND head_sha=? AND kind=?').get(depot,head,'audit');
        if(known)task=view(known);
        else task=createTask({depot,kind:'audit',head_sha:head,base_sha:event==='push'&&HASH.test(payload.before||'')&&!/^0+$/.test(payload.before)?payload.before:event==='pull_request'?payload.pull_request?.base?.sha:null,goal:'Changement GitHub signé : analyse différentielle à qualifier'},'github_webhook','github');
      }else ignored=true;
    }else if(typeof payload.zen!=='string')fail('INVALID_ARGUMENT','Événement ping incomplet.');
    const result={accepted:true,delivery,event,task_id:task?.id||null,ignored,stopped:control().stopped};
    append('github_webhook','github','delivery_received',delivery,{event,body_sha256:digest,task_id:result.task_id,ignored});
    db.prepare('INSERT INTO securite_engine_deliveries VALUES(?,?,?,?,?)').run(delivery,event,digest,JSON.stringify(result),now());
    return result;
  });
}
function assertNotStopped() { if(enabled()){init();running();} }
function admit(fn) { if(!enabled())return fn();init();return transaction(()=>{running();return fn();}); }
function legacyJournal(fn) {
  if(!enabled())return fn();init();
  db.exec('SAVEPOINT security_legacy_journal');
  try {
    const operation=fn(),who=identity.identity();
    append(who?.actor&&who?.client?who.actor+'/'+who.client:'atlas_internal','legacy_'+operation.agent,'legacy_operation',String(operation.id),operation);
    db.exec('RELEASE security_legacy_journal');return operation;
  } catch(e){db.exec('ROLLBACK TO security_legacy_journal; RELEASE security_legacy_journal');throw e;}
}
module.exports={init,enabled,KINDS,STATES,create,claim,checkpoint,transition,stop,status,journal,verifyJournal,receiveGithub,assertNotStopped,
  analysisLease,analysisReplay,saveAnalysis,readAnalysis,admit,legacyJournal,_clock:(fn)=>{clock=fn || (()=>Date.now());}};
