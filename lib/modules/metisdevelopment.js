'use strict';
const crypto = require('node:crypto');
const { db } = require('../core/db');
const U = () => require('../url'); // adresses publiques de l'instance (hôte)
const R = require('./metisresearch'), C = require('./metiscollaboration'), F = require('./metis-access-fence'), J = require('./metis-research-journal');
const S = require('./metis-development-schema');
const P = () => require('./metisprojects');
const M = () => require('./metisdocs');
const WRITES = new Set(['projets_configurer_contexte', 'projets_session', 'projets_checkpoint', 'projets_indexer_contexte', 'projets_preuve_ajouter']);
const NAMES = new Set([...WRITES, 'projets_ouvrir', 'projets_contexte', 'projets_checkpoints', 'projets_preuves', 'projets_verifier', 'projets_adaptateur', 'projets_exporter_contexte']);
const KINDS = { context: 'project_context', checkpoint: 'project_checkpoint', evidence: 'project_evidence', index: 'project_document', session: 'project_session' };
const enabled = () => P().enabled();
const fail = (code, message, details) => { throw new R.ContractError(code, message, false, details); };
const now = () => new Date().toISOString();
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function stable(value) {
  const order = v => Array.isArray(v) ? v.map(x => x === undefined ? null : order(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, order(v[k])])) : v;
  return JSON.stringify(order(value));
}
const text = (v, key, max = 2000) => C.text(v, key, max);
let ready = false;
function init() {
  if (ready && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metis_development_objects'").get()) return;
  if (ready) { ready = false; J.invalidate(db); }
  P().init(); db.exec('SAVEPOINT metis_development_migration');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS metis_development_objects(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES metis_projects(id),kind TEXT NOT NULL CHECK(kind IN ('context','checkpoint','evidence','index','session')),
      owner_account INTEGER NOT NULL,owner_agent TEXT NOT NULL,visibility TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_development_project ON metis_development_objects(project_id,kind,created_at,id);
      CREATE INDEX IF NOT EXISTS idx_development_account ON metis_development_objects(owner_account,kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_development_context ON metis_development_objects(project_id) WHERE kind='context';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_development_active_session ON metis_development_objects(owner_account) WHERE kind='session' AND json_extract(data,'$.state')='active';
      CREATE TRIGGER IF NOT EXISTS metis_development_immutable_update BEFORE UPDATE ON metis_development_objects WHEN OLD.kind NOT IN ('context','session') BEGIN SELECT RAISE(ABORT,'Immutable development record'); END;
      CREATE TRIGGER IF NOT EXISTS metis_development_immutable_delete BEFORE DELETE ON metis_development_objects BEGIN SELECT RAISE(ABORT,'Immutable development record'); END;`);
    J.install(db); db.exec('RELEASE metis_development_migration'); ready = true;
  } catch (e) { db.exec('ROLLBACK TO metis_development_migration; RELEASE metis_development_migration'); J.invalidate(db); throw e; }
}
function path(value, key = 'path') {
  const p = text(value, key, 500).replaceAll('\\', '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(x => x === '..' || x === '') || /[\0\r\n]/.test(p)) fail('INVALID_ARGUMENT', key + ': chemin relatif sans traversée requis.');
  return p;
}
function safeDocumentPath(value) {
  const p = path(value);
  if (/(^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|credentials?|secrets?|node_modules)(\/|$)|\.(?:pem|key|p12|pfx|db|sqlite(?:3)?|exe|dll)$/i.test(p)) fail('INVALID_ARGUMENT', 'Source sensible ou binaire interdite dans le contexte.');
  return p;
}
function canonicalUrl(value) {
  const v = text(value, 'repository.url', 500);
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(v)) return v;
  let u; try { u = new URL(v); } catch { fail('INVALID_ARGUMENT', 'URL de dépôt HTTPS ou SSH requise.'); }
  if (!['https:', 'ssh:'].includes(u.protocol) || u.password || u.protocol === 'https:' && u.username || u.search || u.hash) fail('INVALID_ARGUMENT', 'URL de dépôt sans secret requise.');
  return u.href;
}
const data = r => JSON.parse(r.data);
function configRow(projectId) { init(); return db.prepare("SELECT * FROM metis_development_objects WHERE project_id=? AND kind='context'").get(projectId); }
function row(id) { return db.prepare('SELECT rowid AS ordinal,* FROM metis_development_objects WHERE id=?').get(id); }
function rawReadable(user, id) {
  if (!enabled() || !M().peutLire(user)) return false;
  init(); const r = row(id); return !!r && P().rawReadable(user, r.project_id);
}
function get(user, id, projectId, kind) {
  text(id, 'record_id', 100); init(); const r = row(id);
  if (!r || projectId && r.project_id !== projectId || kind && r.kind !== kind || !F.canRead(user, id)) fail('NOT_FOUND', 'Record absent ou inaccessible.');
  return r;
}
function publicRow(r) {
  const p = P().get(r.owner_account, r.project_id);
  const { ordinal, ...rest } = r;
  return { ...C.publicRow(rest), visibility: p.visibility, content_trust: 'untrusted_data' };
}
function receipt(record){const keys=['id','project_id','kind','revision','created_at','updated_at','title','task_id','next_action','source','summary_dependencies','independently_verified','provenance'];return {...Object.fromEntries(keys.filter(k=>record[k]!==undefined).map(k=>[k,record[k]])),record_sha256:digest(record)};}
function records(user, projectId, kind, taskId) {
  return db.prepare('SELECT rowid AS ordinal,* FROM metis_development_objects WHERE project_id=? AND kind=? ORDER BY created_at DESC,rowid DESC').all(projectId, kind)
    .filter(r => (!taskId || data(r).task_id === taskId || kind === 'checkpoint' && data(r).task_id === null) && F.canRead(user, r.id));
}
function task(project, id) {
  const t = data(project).tasks.find(t => t.id === id);
  if (!t) fail('NOT_FOUND', 'Tâche absente de ce projet.'); return t;
}
function configuration(user, project) {
  const r = configRow(project.id);
  if (!r) return { overview: '', repositories: [], modules: [], commands: [], invariants: [], resource_refs: [], require_session: false };
  get(user, r.id, project.id, 'context'); return data(r);
}
function source(v, config) {
  require('../web/metis-architecture-tools').validateSchema(v, S.checkout, 'checkout');
  const repository=config.repositories.find(r => r.id === v.repository_id);
  if (!repository) fail('INVALID_ARGUMENT', 'Dépôt non enregistré pour ce projet.');
  if(v.repository_sha256&&v.repository_sha256!==digest(repository))fail('REVISION_CONFLICT','La définition du dépôt a changé ; relire le contexte.');
  if (v.dirty && !v.dirty_hash || !v.dirty && v.dirty_hash !== null) fail('INVALID_ARGUMENT', 'dirty_hash doit décrire l’arbre modifié, ou être null si propre.');
  return { ...v,repository_sha256:digest(repository) };
}
function sourceHash(v) { return v ? digest({ repository_id: v.repository_id, repository_sha256:v.repository_sha256||null, commit: v.commit, branch: v.branch, dirty: v.dirty, dirty_hash: v.dirty_hash }) : null; }
function contractHash(t) { return digest({ title: t.title, description: t.description, expected_result: t.expected_result || '', acceptance_criteria: t.acceptance_criteria || [], module_ids: t.module_ids || [], paths: t.paths || [] }); }
function pinned(user, refs) { return C.pinned(user, refs || []); }
function save(kind, project, payload, self, existing, args) {
  const previous = existing ? data(existing) : {};
  payload.summary_dependencies = [...new Set([project.id, ...F.dependencies(previous), ...F.dependencies(payload)])];
  if (Buffer.byteLength(JSON.stringify(payload)) > 24000) fail('INVALID_ARGUMENT', 'Record de développement limité à 24 Ko.');
  const t = now(), id = existing?.id || KINDS[kind] + ':' + crypto.randomUUID();
  if (existing) {
    C.cas(existing, args);
    db.prepare('UPDATE metis_development_objects SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(payload), t, id, existing.revision);
  } else {
    if (args.expected_revision !== 0) fail('REVISION_CONFLICT', 'Création : expected_revision=0 requis.');
    C.quota('SELECT count(*) n FROM metis_development_objects WHERE project_id=? AND kind=?', [project.id, kind], kind === 'index' ? 2000 : 5000);
    db.prepare('INSERT INTO metis_development_objects VALUES(?,?,?,?,?,?,?,1,?,?)').run(id, project.id, kind, self.account, self.id, project.visibility, JSON.stringify(payload), t, t);
  }
  const result = row(id); C.writeRevision(result, self); return publicRow(result);
}
function currentLease(account) { init(); return db.prepare("SELECT * FROM metis_development_objects WHERE owner_account=? AND kind='session' AND json_extract(data,'$.state')='active'").get(Number(account)); }
function leaseStatus(user, projectId) {
  const r = currentLease(user); if (!r) return { state: 'available', session: null };
  const d = data(r), expired = Date.parse(d.expires_at) <= Date.now();
  if (r.project_id !== projectId) return { state: expired ? 'expired_other_project' : 'busy_other_project', session: require('./metis-app-permissions').canRead(user,r.id) ? { id: r.id, revision: r.revision, expires_at: d.expires_at } : null, recovery_required: expired };
  return { state: expired ? 'expired' : 'active', session: publicRow(r), recovery_required: expired };
}
function assertWriter(user, self, projectId, sessionId) {
  const project = P().get(user, projectId), config = configuration(user, project);
  const active=currentLease(user);
  if(active&&Date.parse(data(active).expires_at)>Date.now()&&(active.owner_agent!==self.id||active.project_id!==projectId))fail('CONFLICT','Une autre session de modification est active pour ce compte.');
  if (!config.require_session) return null;
  const r = currentLease(user), d = r ? data(r) : null;
  if (!r || r.project_id !== projectId || r.owner_agent !== self.id || Date.parse(d.expires_at) <= Date.now() || sessionId && r.id !== sessionId) fail('FAILED_PRECONDITION', 'Acquérir ou reprendre le bail d’écriture du projet avec ce client avant de modifier.');
  return r;
}
function commands(config) { return [...config.commands, ...config.modules.flatMap(m => m.commands || [])]; }
function normalConfig(a, user) {
  const repos = a.repositories.map(r => ({ ...r, id: text(r.id, 'repository.id', 80), url: canonicalUrl(r.url), subdir: r.subdir === '.' ? '.' : path(r.subdir, 'repository.subdir') }));
  if (!repos.length || new Set(repos.map(r => r.id)).size !== repos.length) fail('INVALID_ARGUMENT', 'Dépôts non vides avec IDs uniques requis.');
  const modules = a.modules.map(m => ({ ...m, id: text(m.id, 'module.id', 80), paths: m.paths.map(p => path(p)), documents: (m.documents || []).map(safeDocumentPath), commands: m.commands || [], resource_refs: pinned(user, m.resource_refs) }));
  if (new Set(modules.map(m => m.id)).size !== modules.length) fail('INVALID_ARGUMENT', 'IDs de modules uniques requis.');
  const out = { overview: a.overview || '', repositories: repos, modules, commands: a.commands || [], invariants: a.invariants || [], root_resource_refs:pinned(user,a.resource_refs),resource_refs: pinned(user, [...(a.resource_refs || []), ...modules.flatMap(m => m.resource_refs)]), require_session: a.require_session !== false };
  const cmds = commands(out);
  if (new Set(cmds.map(c => c.id)).size !== cmds.length || cmds.some(c => !c.argv.length || c.argv.some(s => !s.trim()))) fail('INVALID_ARGUMENT', 'Commandes non vides avec IDs uniques requis.');
  return out;
}
function normalizeTask(a, t, user) {
  for (const k of ['module_ids', 'paths', 'acceptance_criteria', 'validation_refs', 'validation_source', 'expected_result']) if (a[k] !== undefined) t[k] = a[k];
  if (t.paths) t.paths = t.paths.map(p => path(p));
  if (t.acceptance_criteria && new Set(t.acceptance_criteria.map(c => c.id)).size !== t.acceptance_criteria.length) fail('INVALID_ARGUMENT', 'Critères avec IDs uniques requis.');
  if (a.work_item_id !== undefined) {
    if (a.work_item_id === null) t.work_ref = null;
    else { if (!a.work_item_id.startsWith('work:')) fail('INVALID_ARGUMENT', 'work_item_id doit référencer une mission existante.'); t.work_ref = C.reference(user, a.work_item_id); }
  }
  return t;
}
function verify(user, project, t, checkout, evidenceIds) {
  const config = configuration(user, project), current = source(checkout, config);
  const evidence = [...new Set(evidenceIds)].map(id => get(user, id, project.id, 'evidence'));
  if (evidence.some(r => data(r).task_id !== t.id)) fail('INVALID_ARGUMENT', 'Preuve liée à une autre tâche.');
  const results = (t.acceptance_criteria || []).map(criterion => {
    const matching = evidence.filter(r => data(r).report.criterion_ids.includes(criterion.id)).sort((a, b) => b.ordinal - a.ordinal);
    const r = matching[0], d = r ? data(r) : null;
    let state = 'missing';
    if (d) state = d.task_contract_hash !== contractHash(t) ? 'changed_contract' : sourceHash(d.report.source) !== sourceHash(current) ? 'stale_source' : criterion.kind==='test'&&(!d.report.source_after||sourceHash(d.report.source_after)!==sourceHash(d.report.source))?'validation_window_changed_or_unknown': criterion.kind==='test'&&d.command_hash!==digest(commands(config).find(c=>c.id===criterion.command_id)||null)?'changed_command':(criterion.kind === 'test' ? d.report.exit_code === 0 : d.report.decision === 'approve') ? 'passed_reported' : 'failed_reported';
    return { criterion_id: criterion.id, title: criterion.title, state, evidence_id: r?.id || null,environment:d?.report.environment||null,executed_at:d?.report.executed_at||null };
  });
  return { project_id: project.id, task_id: t.id, source: current, task_contract_hash: contractHash(t), criteria: results, satisfied: results.length > 0 && results.every(r => r.state === 'passed_reported'), assurance: 'authenticated client reports; execution not independently verified by Atlas', evidence_ids: evidence.map(r => r.id) };
}
function validateCompletion(user, projectId, t) {
  if (!(t.acceptance_criteria || []).length) return;
  if (!t.validation_source || !(t.validation_refs || []).length) fail('FAILED_PRECONDITION', 'Critères de validation : fournir validation_source et validation_refs.');
  const result = verify(user, P().get(user, projectId), t, t.validation_source, t.validation_refs);
  if (!result.satisfied) fail('FAILED_PRECONDITION', 'Les preuves ne satisfont pas les critères sur cette version du code.');
}
function mutate(name, a, user, self, project) {
  const config = configuration(user, project);
  if (name === 'projets_configurer_contexte') {
    const old = configRow(project.id); if (old||currentLease(user)) assertWriter(user, self, project.id);
    return { context: receipt(save('context', project, normalConfig(a, user), self, old, a)), project_revision: project.revision };
  }
  if (name === 'projets_session') {
    const r = currentLease(user);
    if (a.action === 'acquire') {
      if (!a.checkout || !a.harness) fail('INVALID_ARGUMENT', 'checkout et harness requis pour acquérir un bail.');
      if(!a.checkout.workspace_key)fail('INVALID_ARGUMENT','workspace_key requis pour identifier ce checkout local.');
      if (a.task_id) task(project, a.task_id);
      if (r) {
        if (Date.parse(data(r).expires_at) > Date.now()) fail('CONFLICT', 'Une session d’écriture est déjà active pour ce compte.');
        if (!a.recover || a.session_id !== r.id || a.expected_revision !== r.revision || !a.recovery_reason?.trim()) fail('FAILED_PRECONDITION', 'Bail expiré : reprise explicite, ID, révision et motif requis ; inspecter les fichiers locaux.');
        const oldProject = P().get(user, r.project_id);
        save('session', oldProject, { ...data(r), state: 'recovered', recovery_reason: text(a.recovery_reason, 'recovery_reason', 1000) }, self, r, a);
      } else if (a.expected_revision !== 0) fail('REVISION_CONFLICT', 'Premier bail : expected_revision=0 requis.');
      const minutes = a.ttl_minutes || 30;
      return { session: save('session', project, { state: 'active', harness: text(a.harness, 'harness', 80), task_id: a.task_id || null, checkout: source(a.checkout, config), expires_at: new Date(Date.now() + minutes * 60000).toISOString(), local_files_inspected_by_client: !!a.recover, recovery_reason: a.recovery_reason || null }, self, null, { ...a, expected_revision: 0 }), project_revision: project.revision };
    }
    if (!r || a.session_id !== r.id || r.project_id !== project.id || r.owner_agent !== self.id) fail('PERMISSION_DENIED', 'Seul le client titulaire peut renouveler ou libérer ce bail.');
    if (!['renew', 'release'].includes(a.action)) fail('INVALID_ARGUMENT', 'Action de bail inconnue.');
    if (a.action === 'renew' && Date.parse(data(r).expires_at) <= Date.now()) fail('FAILED_PRECONDITION', 'Bail expiré : reprendre explicitement.');
    const next = { ...data(r), ...(a.action === 'release' ? { state: 'released' } : { expires_at: new Date(Date.now() + (a.ttl_minutes || 30) * 60000).toISOString() }) };
    return { session: save('session', project, next, self, r, a), project_revision: project.revision };
  }
  const lease = assertWriter(user, self, project.id, a.session_id);
  if (name === 'projets_checkpoint') {
    if (a.task_id) task(project, a.task_id);
    const evidence_ids = a.evidence_ids || [];
    evidence_ids.forEach(id => get(user, id, project.id, 'evidence'));
    if(lease&&a.source.workspace_key!==data(lease).checkout.workspace_key)fail('CONFLICT','Le checkpoint ne correspond pas au checkout titulaire du bail.');
    const checkpoint = save('checkpoint', project, { title: text(a.title, 'title', 160), task_id: a.task_id || null, task_contract_hash:a.task_id?contractHash(task(project,a.task_id)):null, session_id: lease?.id || a.session_id || null,
      source: source(a.source, config), changes: a.changes, blockers: a.blockers, next_action: text(a.next_action, 'next_action'), evidence_ids, attempts: a.attempts || [], resource_refs: pinned(user, a.resource_refs), summary_dependencies: evidence_ids }, self, null, a);
    return { checkpoint:receipt(checkpoint), project_revision: project.revision };
  }
  if (name === 'projets_indexer_contexte') {
    if (!a.documents.length) fail('INVALID_ARGUMENT', 'Au moins un document requis.');
    const documents = a.documents.map(doc => {
      if (doc.repository_id !== doc.source.repository_id || doc.module_id && !config.modules.some(m => m.id === doc.module_id)) fail('INVALID_ARGUMENT', 'Dépôt ou module du document incohérent.');
      const normalized = { ...doc, path: safeDocumentPath(doc.path), source: source(doc.source, config) };
      if (digest(doc.body) !== doc.sha256) fail('INVALID_ARGUMENT', 'SHA256 du document différent des octets fournis.');
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{24,})/.test(doc.body)) fail('INVALID_ARGUMENT', 'Secret détecté dans le document.');
      return save('index', project, normalized, self, null, a);
    });
    return { documents: documents.map(d => ({ id: d.id, path: d.path, sha256: d.sha256 })), project_revision: project.revision };
  }
  if (name === 'projets_preuve_ajouter') {
    const t = task(project, a.task_id), report = { ...a.report, source: source(a.report.source, config) };
    if (!report.criterion_ids.length || new Set(report.criterion_ids).size !== report.criterion_ids.length) fail('INVALID_ARGUMENT', 'Critères uniques non vides requis.');
    const criteria = report.criterion_ids.map(id => (t.acceptance_criteria || []).find(c => c.id === id));
    if (criteria.some(c => !c || c.kind !== report.kind)) fail('INVALID_ARGUMENT', 'Critères absents ou de nature incompatible.');
    if (!Number.isFinite(Date.parse(report.executed_at)) || Date.parse(report.executed_at) > Date.now() + 300000) fail('INVALID_ARGUMENT', 'Date de validation réelle et non future requise.');
    if (report.source_after) report.source_after=source(report.source_after,config);
    if (report.kind === 'test') {
      const cmd = commands(config).find(c => c.id === report.command_id);
      if (!cmd || !['test', 'check', 'lint', 'build'].includes(cmd.kind) || criteria.some(c => c.command_id !== cmd.id) || stable(cmd.argv) !== stable(report.argv) || !Number.isInteger(report.exit_code)) fail('INVALID_ARGUMENT', 'Commande, arguments, critères et code de sortie doivent correspondre au contrat.');
    } else if (!report.decision) fail('INVALID_ARGUMENT', 'Décision approve/reject requise pour cette preuve.');
    for (const artifact of report.artifacts || []) safeDocumentPath(artifact.path);
    const evidence = save('evidence', project, { task_id: t.id, task_contract_hash: contractHash(t), command_hash:report.kind==='test'?digest(commands(config).find(c=>c.id===report.command_id)):null, report, provenance: 'reported_by_observed_oauth_client', independently_verified: false }, self, null, a);
    return { evidence:{...receipt(evidence),submitted_report_sha256:digest(a.report)}, project_revision: project.revision };
  }
  fail('INVALID_ARGUMENT', 'Mutation de développement inconnue.');
}
function page(items, a, user, request, identity, extra = {}, map = x => x) {
  const signature = digest({identity,budget:R.budget(a)}), cursor = a.cursor ? R.decode(a.cursor, 'development', user) : null;
  items=items.map(map).flatMap(record=>{
    const serialized=stable(record),bytes=Buffer.from(serialized);
    if(bytes.length<=4000)return [record];
    const fragments=[];let offset=0;
    while(offset<bytes.length){let end=Math.min(bytes.length,offset+Math.min(2000,Math.max(256,Math.floor(R.budget(a)/4))));while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;const fragment=bytes.subarray(offset,end).toString('utf8');const entry={id:record.id+':fragment:'+offset,kind:'context_fragment',record_id:record.id,record_kind:record.kind||'record',offset_bytes:offset,total_bytes:bytes.length,record_sha256:digest(serialized),fragment,fragment_sha256:digest(fragment)};fragments.push({...entry,content_sha256:digest(entry)});offset=end;}
    return fragments;
  });
  if (cursor && cursor.signature !== signature) fail('STALE_CURSOR', 'La sélection ou ses sources ont changé ; recommencer.');
  let offset = cursor?.offset || 0; const start=offset, out = [], limit = R.integer(a.limit, 20, 1, 100, 'limit');
  const make = () => R.envelope(request, { ...extra, offset:start,total_items:items.length, items: out, has_more: offset < items.length }, R.high(), { next_cursor: offset < items.length ? R.cursor({ type: 'development', signature, offset }, user) : null, truncated: offset < items.length });
  while (offset < items.length && out.length < limit) {
    out.push(items[offset++]);
    if (Buffer.byteLength(JSON.stringify(make())) > R.budget(a)) { if (out.length === 1) R.assertBudget(make(), a); out.pop(); offset--; break; }
  }
  return make();
}
const glob = (pattern, value) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0001').replaceAll('*', '[^/]*').replaceAll('\u0001', '.*') + '$').test(value);
function context(user, project, a) {
  const p = data(project), config = configuration(user, project), current = a.checkout ? source(a.checkout, config) : null;
  const t = a.task_id ? task(project, a.task_id) : p.tasks.find(t => ['in_progress', 'ready'].includes(t.state) && !t.depends_on.some(id => p.tasks.find(x => x.id === id)?.state !== 'done'));
  const selectedIds = a.module_ids || t?.module_ids || [];
  if (config.repositories.length && selectedIds.some(id => !config.modules.some(m => m.id === id))) fail('INVALID_ARGUMENT', 'Module absent du projet.');
  const words = (a.goal || '').toLocaleLowerCase('fr').split(/\s+/).filter(w => w.length >= 3);
  const modules = config.modules.filter(m => selectedIds.length ? selectedIds.includes(m.id) : !t && !words.length || (t?.paths || []).some(p => m.paths.some(pattern => glob(pattern, p))) || words.some(w => (m.id + ' ' + m.title).toLocaleLowerCase('fr').includes(w)));
  const checkpoints = records(user, project.id, 'checkpoint', t?.id);
  const compatible = current ? checkpoints.find(r => sourceHash(data(r).source) === sourceHash(current)) : null;
  const last = compatible || checkpoints.find(r => !current || data(r).source.repository_id === current.repository_id) || null;
  const cp = last ? data(last) : null;
  const freshness = !current ? 'unknown_checkout' : !cp ? 'no_checkpoint' : cp.task_contract_hash&&t&&cp.task_contract_hash!==contractHash(t)?'changed_task_contract':sourceHash(cp.source) === sourceHash(current) ? 'matching_reported_checkout' : 'changed_checkout';
  const entries = [{ id: project.id, kind: 'project', title: p.title, body: p.goal, priority: p.priority, state: p.state, source_url: U().url('/metis/projets/') + encodeURIComponent(project.id) }];
  if (config.overview) entries.push({ id: 'overview', kind: 'overview', title: 'Vue du programme', body: config.overview });
  config.invariants.forEach((body, i) => entries.push({ id: 'invariant:' + i, kind: 'invariant', title: 'Contrainte du projet', body }));
  if (t) {
    entries.push({ id: t.id, kind: 'task', title: t.title, body: t.description, task_contract_hash: contractHash(t), expected_result: t.expected_result || null, acceptance_criteria: t.acceptance_criteria || [], paths: t.paths || [], state: t.state, work_ref: t.work_ref || null });
    if (t.work_ref) {
      F.assertReadable(user, t.work_ref.id); const currentWork = C.reference(user, t.work_ref.id), work = R.resource(user, t.work_ref.id);
      entries.push({ id: t.work_ref.id, kind: 'work_item', title: work.title, body: work.description, revision: currentWork.revision, reference_changed: currentWork.revision !== t.work_ref.revision });
    }
    for (const dep of t.depends_on) { const other = p.tasks.find(x => x.id === dep); entries.push({ id: dep, kind: 'dependency', title: other.title, state: other.state, outcome: other.outcome }); }
  }
  for (const module of modules) entries.push({ id: 'module:' + module.id, kind: 'module', title: module.title, paths: module.paths, documents: module.documents, commands: module.commands });
  for (const cmd of config.commands) entries.push({ ...cmd,id: 'command:' + cmd.id, kind: 'command',command_kind:cmd.kind });
  // A bounded view over immutable snapshots; prefer an exact checkout match per path.
  const indexes = records(user, project.id, 'index'), paths = [...new Set(indexes.map(r => data(r).repository_id + ':' + data(r).path))];
  for (const key of paths) {
    const candidates = indexes.filter(r => data(r).repository_id + ':' + data(r).path === key), match = current ? candidates.find(r => sourceHash(data(r).source) === sourceHash(current)) : null;
    const r = match || candidates[0], doc = data(r);
    if (current && doc.repository_id !== current.repository_id || doc.module_id && !modules.some(m => m.id === doc.module_id)) continue;
    entries.push({ id: r.id, kind: 'document', title: doc.title, body: doc.body, path: doc.path, sha256: doc.sha256, source: doc.source, freshness: !current ? 'unknown_checkout' : sourceHash(doc.source) === sourceHash(current) ? 'matching_reported_checkout' : 'changed_checkout' });
  }
  for (const note of p.notes.filter(n => ['decision', 'risk', 'session'].includes(n.kind) && (!n.task_id || n.task_id === t?.id)).slice(-12)) entries.push({ id: note.id, kind: note.kind, title: note.title, body: note.body, created_at: note.created_at });
  if (last) {
    entries.push({ id: last.id, kind: 'checkpoint', title: cp.title, source: cp.source, changes: cp.changes, blockers: cp.blockers, next_action: cp.next_action, evidence_ids: cp.evidence_ids, created_at: last.created_at });
    (cp.attempts || []).forEach((attempt, i) => entries.push({ id: last.id + ':attempt:' + i, kind: 'attempt', ...attempt }));
  }
  const selectedRefs=[...new Map([...(config.root_resource_refs||config.resource_refs),...modules.flatMap(m=>m.resource_refs||[])].map(r=>[r.id,r])).values()];
  for (const ref of selectedRefs) {
    const currentRef = C.reference(user, ref.id), native = R.resource(user, ref.id);
    if (!native) fail('NOT_FOUND', 'Source documentaire absente ou inaccessible.');
    entries.push({ id: ref.id, kind: 'reference', title: native.title, body: (native.body || native.description || '').slice(0, 2500), excerpt_truncated: (native.body || '').length > 2500, revision: currentRef.revision, expected_revision: ref.revision, reference_changed: currentRef.revision !== ref.revision });
  }
  const filtered = a.query ? entries.filter(e => ['project', 'invariant'].includes(e.kind) || stable(e).toLocaleLowerCase('fr').includes(a.query.toLocaleLowerCase('fr'))) : entries;
  const contextDigest = digest({ entries: filtered, source: current, task: t?.id || null, freshness });
  const lease=leaseStatus(user,project.id);let held=null;try{held=lease.session?.owner_agent===C.identity(user,false).id;}catch{}
  return { entries: filtered, meta: { project_id: project.id, project_revision: project.revision, context_revision: configRow(project.id)?.revision || 0, task_id: t?.id || null,
    write_session:{required:config.require_session,state:lease.state,id:lease.session?.id||null,revision:lease.session?.revision||null,expires_at:lease.session?.expires_at||null,held_by_current_client:held},
    next_action: freshness === 'changed_checkout' ? 'Inspecter les différences du checkout avant de reprendre : ' + (cp?.next_action || p.next_action) : cp?.next_action || p.next_action,
    checkpoint_id: last?.id || null, freshness, context_digest: contextDigest, setup_required: !config.repositories.length, source: current, provenance: 'versioned Atlas records and client-reported checkout; no remote code execution', content_trust: 'untrusted_data' } };
}
function adapter(project, config, harness) {
  const manifest = { schema_version: 1, project_id: project.id, repositories: config.repositories, documents: [...new Set(config.modules.flatMap(m => m.documents || []))] };
  const instructions = require('../../tools/metis-context/bridge.cjs').instructions(project.id);
  return { harness, manifest, instructions, bridge_url:U().url('/metis/projets/')+encodeURIComponent(project.id)+'/bridge.cjs',bridge_sha256:digest(require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../../tools/metis-context/bridge.cjs'),'utf8')), entry_file: 'AGENTS.md', claude_import: '@AGENTS.md',
    ...(harness === 'opencode' ? { remote_configuration: { $schema: 'https://opencode.ai/config.json', mcp: { servers: { metis: { type: 'remote', url: U().url('/mcp') } } } }, setup_commands: ['opencode mcp add metis --url ' + U().url('/mcp'), 'opencode mcp list'], command_file: '.opencode/commands/reprise-metis.md', command_prompt: 'Reprends le projet décrit dans .metis/project.json avec projets_ouvrir. Objectif : $ARGUMENTS. Respecte le bail et inspecte Git avant toute modification.', documentation: 'https://opencode.ai/docs/mcp-servers/' } : {}),
    installation_state: 'generated_only; no local client or global configuration modified', auth: 'native harness OAuth; never copy another client credential', instructions_sha256: digest(instructions) };
}
function read(name, a, user, project, request) {
  const config = configuration(user, project);
  if (name === 'projets_session') return R.envelope(request, leaseStatus(user, project.id), R.high());
  if (name === 'projets_adaptateur') return R.envelope(request, adapter(project, config, a.harness), R.high());
  if (name === 'projets_verifier') return R.envelope(request, verify(user, project, task(project, a.task_id), a.checkout, a.evidence_ids), R.high());
  if (name === 'projets_checkpoints' || name === 'projets_preuves') {
    if (a.task_id) task(project, a.task_id);
    const rows = records(user, project.id, name === 'projets_checkpoints' ? 'checkpoint' : 'evidence', a.task_id);
    return page(rows, a, user, request, { name, project_id: project.id, task_id: a.task_id || null, records: rows.map(r => [r.id, r.revision]) }, {}, publicRow);
  }
  const built = context(user, project, a);
  const unchanged = a.previous_digest === built.meta.context_digest;
  const key='devctx:'+Number(user)+':'+built.meta.context_digest,previousKey=a.previous_digest?'devctx:'+Number(user)+':'+a.previous_digest:null;
  const previous=previousKey?db.prepare('SELECT data FROM metis_context_manifests WHERE id=? AND account=? AND expires>?').get(previousKey,Number(user),Date.now()):null;
  const prior=previous?JSON.parse(previous.data):null,delta=!!prior&&prior.project_id===project.id&&!unchanged;
  const items = unchanged ? [] : built.entries.map(item=>delta&&prior.manifest[item.id]===digest(item)?{id:item.id,kind:'context_reference',record_kind:item.kind,retained_content_sha256:digest(item)}:item);
  db.prepare("DELETE FROM metis_context_manifests WHERE account=? AND id LIKE 'devctx:%' AND expires<?").run(Number(user),Date.now());
  const old=db.prepare("SELECT id FROM metis_context_manifests WHERE account=? AND id LIKE 'devctx:%' ORDER BY expires DESC").all(Number(user));
  for(const record of old.slice(30))if(![key,previousKey].includes(record.id))db.prepare('DELETE FROM metis_context_manifests WHERE id=? AND account=?').run(record.id,Number(user));
  db.prepare('INSERT INTO metis_context_manifests(id,account,expires,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data').run(key,Number(user),Date.now()+3600000,JSON.stringify({project_id:project.id,manifest:Object.fromEntries(built.entries.map(item=>[item.id,digest(item)]))}));
  const selection = Object.fromEntries(Object.entries(a).filter(([key]) => !['cursor', 'limit', 'max_tokens', 'max_bytes'].includes(key)));
  return page(items, a, user, request, { name, selection, digest: built.meta.context_digest,delivery_digest:digest(items) }, { ...built.meta, unchanged,delta,previous_digest:a.previous_digest||null,delta_status:unchanged?'unchanged':delta?'available':a.previous_digest?'base_missing_or_expired':'full' }, item => a.format === 'markdown' ? { id: item.id, kind: item.kind, sha256: digest(item), text: '## ' + (item.title || item.kind) + '\n\n' + (item.body || '```json\n' + JSON.stringify(item, null, 2) + '\n```') + '\n' } : { ...item, content_sha256: digest(item) });
}
function call(name, a, user) {
  const request = crypto.randomUUID();
  try {
    if (!enabled()) fail('DEPENDENCY_UNAVAILABLE', 'Recherche et collaboration Métis requises.');
    if (!M().peutLire(user)) fail('PERMISSION_DENIED', 'Accès Métis requis.');
    const schema = require('../web/metis-development-tools').definition(name)?.inputSchema;
    if (!schema || !a || Buffer.byteLength(JSON.stringify(a)) > 24000) fail('INVALID_ARGUMENT', 'Arguments absents ou trop volumineux.');
    try { require('../web/metis-architecture-tools').validateSchema(a, schema, 'arguments'); } catch { fail('INVALID_ARGUMENT', 'Arguments hors contrat ; consulter le schéma.'); }
    R.budget(a); R.rate(user, name); init();
    const write = WRITES.has(name) && !(name === 'projets_session' && a.action === 'status');
    db.exec('SAVEPOINT metis_development_call');
    try {
      const project=P().get(user,a.project_id);
      let out;
      if (write) {
        C.writer(user); if (project.owner_account !== Number(user)) fail('PERMISSION_DENIED', 'Écriture réservée au compte propriétaire.');
        const self = C.identity(user), key = text(a.idempotency_key, 'idempotency_key', 160), fingerprint = digest(Object.fromEntries(Object.entries(a).filter(([k]) => !['max_tokens', 'max_bytes', 'idempotency_key'].includes(k))));
        const prior = db.prepare('SELECT * FROM metis_research_requests WHERE actor=? AND operation=? AND request_key=?').get(self.id, name, key);
        let result;
        if (prior) {
          if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Clé déjà utilisée pour une autre intention.');
          result = JSON.parse(prior.response);
          if (!F.dependencies(result).every(id => F.canRead(user, id))) fail('PERMISSION_DENIED', 'Résultat idempotent devenu inaccessible.');
          for(const key of ['context','checkpoint','evidence','session'])if(result[key]?.id)get(user,result[key].id,project.id);
        } else {
          if (!Number.isSafeInteger(a.expected_revision)) fail('INVALID_ARGUMENT', 'expected_revision requis pour une mutation.');
          result = mutate(name, a, user, self, project);
          result.summary_dependencies = [...new Set([project.id, ...F.dependencies(result),...Object.values(result).flatMap(v=>v&&typeof v==='object'&&!Array.isArray(v)?F.dependencies(v):[])])];
          db.prepare('INSERT INTO metis_research_requests VALUES(?,?,?,?,?)').run(self.id, name, key, fingerprint, JSON.stringify(result));
        }
        out = R.envelope(request, result, R.high());
      } else out = read(name, a, user, project, request);
      R.assertBudget(out, a); db.exec('RELEASE metis_development_call'); return out;
    } catch (e) { db.exec('ROLLBACK TO metis_development_call; RELEASE metis_development_call'); throw e; }
  } catch (e) {
    const known = e instanceof R.ContractError;
    return require('./metis-recovery').normalize({ ok: false, request_id: request, schema_version: '1', error: { code: known ? e.code : 'DEPENDENCY_UNAVAILABLE', message: known ? e.message : 'Dépendance de continuité indisponible.', retryable: !known, ...(known && e.details ? { details: e.details } : {}) } });
  }
}
function corpusSql(user) {
  init();
  return ` UNION ALL SELECT d.id,CASE d.kind WHEN 'context' THEN 'project_context' WHEN 'checkpoint' THEN 'project_checkpoint' WHEN 'evidence' THEN 'project_evidence' WHEN 'index' THEN 'project_document' ELSE 'project_session' END,
    coalesce(json_extract(d.data,'$.title'),json_extract(d.data,'$.path'),d.kind),coalesce(json_extract(d.data,'$.overview'),json_extract(d.data,'$.next_action'),''),d.data,d.revision,d.kind,'',CAST(d.owner_account AS TEXT),d.updated_at,NULL,d.visibility FROM metis_development_objects d WHERE atlas_readable_ref(d.id,${Number(user)})=1`;
}
function overview(user, projectId) {
  const project = P().get(user, projectId), config = configuration(user, project), cps = records(user, projectId, 'checkpoint');
  return { configured: config.repositories.length > 0, context_revision: configRow(projectId)?.revision || 0, repositories: config.repositories, checkpoints: cps.length,
    latest_checkpoint: cps[0] ? { id: cps[0].id, title: data(cps[0]).title, next_action: data(cps[0]).next_action, source: data(cps[0]).source, created_at: cps[0].created_at } : null, session: leaseStatus(user, projectId) };
}
module.exports = { enabled, init, NAMES, WRITES, KINDS, rawReadable, get, publicRow, corpusSql, overview, path, safeDocumentPath, canonicalUrl, sourceHash, contractHash, normalizeTask, assertWriter, validateCompletion, context, adapter,
 call: (name, args, user) => require('./metis-observability').observe(user, name, () => F.withScope(user, () => call(name, args, user))) };
