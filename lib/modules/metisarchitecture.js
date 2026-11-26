'use strict';

// Métadonnées explicites, versionnées indépendamment des publications. Une absence
// reste null : le registre n'invente ni implémentation ni résultat de benchmark.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const M = () => require('./metisdocs');
const X = () => require('./metisexperts');
const TYPES = ['runtime_component', 'capability', 'controller', 'policy', 'record', 'schema', 'view', 'protocol', 'metric', 'benchmark', 'research_harness', 'expert_profile', 'historical_alias', 'external_reference'];
const LIFECYCLES = ['proposed', 'designed', 'implemented', 'measured', 'promoted', 'deprecated', 'tombstoned'];
const AUTHORITIES = ['source_of_truth', 'derived', 'advisory', 'historical'];
const SCOPES = ['runtime', 'training', 'offline', 'documentation'];
const RELATIONS = ['depends_on', 'implements', 'writes_state', 'reads_state', 'derives_from', 'governed_by', 'measured_by', 'documents', 'supersedes', 'replaced_by'];
const ENUMS = { architectural_type: TYPES, lifecycle: LIFECYCLES, authority: AUTHORITIES, execution_scope: SCOPES };
const LISTS = ['supersedes', 'replaced_by', 'benchmark_ids', 'evidence_refs', 'implementation_refs', 'authority_refs', 'aliases'];
const STRINGS = ['canonical_owner', 'canonical_subject'];
const FIELDS = [...Object.keys(ENUMS), ...LISTS, ...STRINGS, 'writes_persistent_state', 'relations'];
const ACTIVE = n => !['deprecated', 'tombstoned'].includes(n.lifecycle);
const normal = s => String(s).normalize('NFKC').toLocaleLowerCase('fr').trim();
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
let ready = false;
function init() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS metis_architecture (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, metadata TEXT NOT NULL, auteur TEXT NOT NULL, le TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metis_architecture_versions (
    id TEXT NOT NULL, version INTEGER NOT NULL, metadata TEXT NOT NULL, auteur TEXT NOT NULL, le TEXT NOT NULL, PRIMARY KEY(id, version));`);
  require('./metis-research-journal').install(db);
  ready = true;
}
function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('metadata doit être un objet.');
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.includes(k)) throw new Error('Champ architectural inconnu : ' + k);
    if (v === null) continue; // effacer une déclaration, sans lui donner un défaut
    if (ENUMS[k] && !ENUMS[k].includes(v)) throw new Error(k + ' : ' + ENUMS[k].join(', '));
    if (STRINGS.includes(k) && (typeof v !== 'string' || !v.trim() || v.length > 240)) throw new Error(k + ' : texte non vide, 240 caractères maximum.');
    if (LISTS.includes(k) && (!Array.isArray(v) || v.length > 100 || v.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))) throw new Error(k + ' : au plus 100 références textuelles non vides.');
    if (k === 'writes_persistent_state' && typeof v !== 'boolean') throw new Error(k + ' : booléen ou null.');
    if (k === 'relations') {
      if (!Array.isArray(v) || v.length > 100) throw new Error('relations : au plus 100 liens.');
      for (const r of v) if (!r || Object.keys(r).some(k => !['type', 'target'].includes(k)) || !RELATIONS.includes(r.type) || typeof r.target !== 'string' || !r.target || r.target.length > 240) throw new Error('relation : {type, target}, type parmi ' + RELATIONS.join(', '));
    }
  }
}
function snapshot(user) {
  if (!M().peutLire(user)) throw new Error('Accès refusé.');
  init();
  const raw = [];
  const add = (id, label, kind, version, extra = {}) => raw.push({ id, label, kind, version, ...extra });
  for (const g of M().glossaire(user) || []) add('sigle:' + g.sigle, g.sens, 'sigle', g.version, { sigle: g.sigle, nature: g.nature, url: require('../host').publicUrl() + '/metis/glossaire/' + encodeURIComponent(g.sigle) });
  // Une requête architecturale ne charge pas les corps de toutes les publications.
  const docs = db.prepare('SELECT slug,titre,categorie,version,statut FROM metis_docs' + (M().peutEcrire(user) ? '' : " WHERE statut='publie'")).all();
  for (const d of docs) add('document:' + d.slug, d.titre, d.categorie === 'Architecture' ? 'plan' : 'document', d.version, { url: require('../host').publicUrl() + '/metis/' + d.slug, statut: d.statut });
  X().init();
  const measures = db.prepare('SELECT expert, COUNT(*) n FROM metis_expert_mesures WHERE benchmark IS NOT NULL GROUP BY expert').all();
  const measured = new Map(measures.map(r => [r.expert, r.n]));
  for (const e of X().lister(user) || []) add('expert:' + e.id, e.nom, 'expert', e.revision, { architectural_type: 'expert_profile', native_deprecated: e.statut === 'deprecie', measurement_count: measured.get(e.id) || 0, url: e.url });
  for (const b of X().benchmarks(user) || []) add('benchmark:' + b.id, b.nom, 'benchmark', null, { architectural_type: 'benchmark', metric: b.metrique });
  for (const c of X().competences(user) || []) add('competence:' + c.id, c.nom, 'competence', null, { architectural_type: 'capability', url: c.url });
  for (const p of X().pools(user) || []) add('pool:' + p.id, p.nom, 'pool', null);
  for (const r of db.prepare("SELECT metrique FROM metis_benchmarks WHERE metrique != '' UNION SELECT metrique FROM metis_expert_mesures WHERE metrique != ''").all()) add('metric:' + r.metrique, r.metrique, 'metric', null, { architectural_type: 'metric' });
  const overlays = new Map(db.prepare('SELECT * FROM metis_architecture').all().map(r => [r.id, r]));
  return raw.map(n => {
    const r = overlays.get(n.id), metadata = r ? JSON.parse(r.metadata) : {};
    const fields = Object.fromEntries(FIELDS.map(k => [k, LISTS.includes(k) || k === 'relations' ? [] : null]));
    return { ...fields, ...n, ...metadata, architecture_version: r ? r.version : 0, metadata, metadata_author: r ? r.auteur : null, metadata_updated_at: r ? r.le : null };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function edgesFor(nodes) {
  const edges = [], seen = new Set();
  const add = (from, to, type, origin = 'metadata') => { const key = JSON.stringify([from, to, type]); if (!seen.has(key)) { seen.add(key); edges.push({ from, to, type, origin }); } };
  for (const n of nodes) {
    for (const [field, type] of [['canonical_owner', 'governed_by']]) if (n[field]) add(n.id, n[field], type);
    for (const field of ['supersedes', 'replaced_by', 'authority_refs', 'benchmark_ids']) for (const target of n[field]) add(n.id, field === 'benchmark_ids' && !target.startsWith('benchmark:') ? 'benchmark:' + target : target, field === 'benchmark_ids' ? 'measured_by' : field === 'authority_refs' ? 'governed_by' : field);
    for (const r of n.relations) add(n.id, r.target, r.type);
  }
  for (const r of db.prepare('SELECT de, vers, type FROM metis_expert_relations').all()) add('expert:' + r.de, 'expert:' + r.vers, r.type === 'depend_de' ? 'depends_on' : r.type, 'expert_registry');
  for (const r of db.prepare('SELECT expert, competence, benchmark FROM metis_expert_competences').all()) {
    add('expert:' + r.expert, 'competence:' + r.competence, 'has_capability', 'expert_registry');
    if (r.benchmark) add('expert:' + r.expert, 'benchmark:' + r.benchmark, 'measured_by', 'expert_registry');
  }
  for (const r of db.prepare('SELECT DISTINCT expert, benchmark FROM metis_expert_mesures WHERE benchmark IS NOT NULL').all()) add('expert:' + r.expert, 'benchmark:' + r.benchmark, 'measured_by', 'expert_registry');
  for (const r of db.prepare('SELECT id, competence FROM metis_benchmarks WHERE competence IS NOT NULL').all()) add('benchmark:' + r.id, 'competence:' + r.competence, 'measures', 'expert_registry');
  for (const r of db.prepare("SELECT id, metrique FROM metis_benchmarks WHERE metrique != ''").all()) add('benchmark:' + r.id, 'metric:' + r.metrique, 'uses_metric', 'expert_registry');
  return edges.filter(e => nodes.some(n => n.id === e.from));
}
// Tarjan : composantes fortement connexes, linéaire, sans énumérer tous les cycles.
function components(nodes, edges) {
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) if (e.type === 'depends_on' && adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
  let index = 0; const idx = new Map(), low = new Map(), stack = [], on = new Set(), cycles = [];
  function visit(v) {
    idx.set(v, index); low.set(v, index++); stack.push(v); on.add(v);
    for (const w of adj.get(v)) { if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
    if (low.get(v) === idx.get(v)) { const group = []; let w; do { w = stack.pop(); on.delete(w); group.push(w); } while (w !== v); if (group.length > 1 || adj.get(v).includes(v)) cycles.push(group.sort()); }
  }
  for (const v of adj.keys()) if (!idx.has(v)) visit(v);
  return cycles;
}
function authorityGroups(nodes) {
  const groups = new Map();
  for (const n of nodes) if (ACTIVE(n) && !n.native_deprecated && n.authority === 'source_of_truth' && n.canonical_subject) { const key = normal(n.canonical_subject); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(n.id); }
  return groups;
}
function enrich(nodes, edges) {
  const authorities = authorityGroups(nodes);
  return nodes.map(n => ({ ...n, authority_count: new Set([...(authorities.get(normal(n.canonical_subject || n.id)) || []), ...n.authority_refs]).size,
    measured: n.kind === 'expert' ? n.measurement_count > 0 : ['measured', 'promoted'].includes(n.lifecycle) && n.evidence_refs.length > 0 ? true : null,
    has_benchmark: edges.some(e => e.from === n.id && e.type === 'measured_by'),
    in_degree: edges.filter(e => e.to === n.id).length, out_degree: edges.filter(e => e.from === n.id).length,
    dependency_degree: edges.filter(e => e.type === 'depends_on' && (e.from === n.id || e.to === n.id)).length }));
}
function page(items, args = {}) {
  const offset = args.offset ?? 0, limit = args.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('offset >= 0 ; limit entre 1 et 500 (entiers).');
  return { total: items.length, offset, limit, next_offset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) };
}
function query(user, args = {}) {
  const nodes = snapshot(user), all = enrich(nodes, edgesFor(nodes));
  const filters = args.filters || {};
  const allowed = [...FIELDS.filter(k => !['relations'].includes(k)), 'id', 'kind', 'nature', 'measured', 'has_benchmark', 'authority_count', 'dependency_degree', 'architecture_version'];
  const ops = ['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'is_null'];
  for (const [key, condition] of Object.entries(filters)) {
    if (!allowed.includes(key)) throw new Error('Filtre inconnu : ' + key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if (!ops.includes(condition.op) || Object.keys(condition).some(k => !['op', 'value'].includes(k))) throw new Error('Filtre : {op, value}, op parmi ' + ops.join(', '));
      if (condition.op === 'in' && !Array.isArray(condition.value)) throw new Error('in attend une liste.');
      if (['gt', 'gte', 'lt', 'lte'].includes(condition.op) && (typeof condition.value !== 'number' || !Number.isFinite(condition.value))) throw new Error('Comparaison numérique : value doit être un nombre fini.');
    }
  }
  const matches = (v, c) => {
    const { op, value } = c && typeof c === 'object' && !Array.isArray(c) ? c : { op: 'eq', value: c };
    switch (op) {
      case 'eq': return v === value; case 'ne': return v !== value; case 'in': return value.includes(v);
      case 'contains': return Array.isArray(v) ? v.includes(value) : typeof v === 'string' && typeof value === 'string' && normal(v).includes(normal(value));
      case 'is_null': return (v == null) === (value !== false);
      case 'gt': return typeof v === 'number' && v > value; case 'gte': return typeof v === 'number' && v >= value;
      case 'lt': return typeof v === 'number' && v < value; case 'lte': return typeof v === 'number' && v <= value;
      default: return false;
    }
  };
  return { ok: true, ...page(all.filter(n => Object.entries(filters).every(([k, c]) => matches(n[k], c))), args) };
}
function auditData(nodes, edges) {
  const findings = [], byId = new Map(nodes.map(n => [n.id, n]));
  const add = (code, ids, detail) => findings.push({ code, ids, detail });
  for (const n of nodes) {
    if (!n.architectural_type) add('untyped', [n.id], 'Type architectural non déclaré.');
    if (n.authority === 'source_of_truth' && !n.canonical_subject) add('missing_canonical_subject', [n.id], 'Source de vérité sans sujet canonique : concurrence non vérifiable.');
    if (ACTIVE(n) && ['runtime_component', 'controller', 'research_harness'].includes(n.architectural_type) && !edges.some(e => e.from === n.id && e.type === 'measured_by')) add('missing_benchmark', [n.id], 'Aucun benchmark relié.');
    if (n.kind === 'expert' && n.measurement_count === 0) add('unmeasured_expert', [n.id], 'Aucune mesure liée à un benchmark.');
    if (ACTIVE(n) && !n.canonical_owner) add('missing_owner', [n.id], 'Owner canonique non déclaré.');
    if (ACTIVE(n) && n.execution_scope === 'runtime' && !['implemented', 'measured', 'promoted'].includes(n.lifecycle)) add('runtime_not_implemented', [n.id], 'Portée runtime sans lifecycle implémenté.');
    if (n.execution_scope === 'runtime' && ['implemented', 'measured', 'promoted'].includes(n.lifecycle) && !n.implementation_refs.length) add('implementation_without_evidence', [n.id], 'Implémentation déclarée sans référence de preuve.');
    if (['measured', 'promoted'].includes(n.lifecycle) && !n.evidence_refs.length && !n.measurement_count) add('measurement_without_evidence', [n.id], 'Maturité déclarée sans mesure ni référence de preuve.');
  }
  for (const ids of authorityGroups(nodes).values()) if (ids.length > 1) add('competing_authorities', ids, 'Plusieurs sources de vérité actives sur le même canonical_subject.');
  const names = new Map();
  for (const n of nodes) for (const alias of [n.sigle, ...n.aliases].filter(Boolean)) { const key = normal(alias); if (!names.has(key)) names.set(key, new Set()); names.get(key).add(n.id); }
  for (const [term, ids] of names) if (ids.size > 1) add('alias_collision', [...ids], 'Sigle ou alias en collision : ' + term);
  for (const e of edges) {
    const target = byId.get(e.to);
    if (!target) add('dangling_reference', [e.from], 'Cible absente ou inaccessible : ' + e.to);
    else if (ACTIVE(byId.get(e.from)) && (!ACTIVE(target) || target.native_deprecated) && !['supersedes', 'replaced_by'].includes(e.type)) add('deprecated_reference', [e.from, e.to], 'Référence active vers un élément déprécié : ' + e.type);
  }
  for (const group of components(nodes, edges)) add('dependency_cycle', group, 'Cycle de dépendance.');
  for (const n of nodes) if (!edges.some(e => e.from === n.id || e.to === n.id)) add('orphan', [n.id], 'Aucun lien transversal.');
  return findings;
}
function audit(user, args = {}) {
  const nodes = snapshot(user), edges = edgesFor(nodes), findings = auditData(nodes, edges), counts = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
  return { ok: true, entries: nodes.length, counts, ...page(args.codes ? findings.filter(f => args.codes.includes(f.code)) : findings, args) };
}
function graph(user, args = {}) {
  const nodes = snapshot(user), edges = edgesFor(nodes), byId = new Set(nodes.map(n => n.id));
  // Paginer les nœuds et liens séparément permet de reconstruire tout le graphe.
  return { ok: true, nodes: page(enrich(nodes, edges), args), edges: page(edges, { offset: args.edge_offset ?? 0, limit: args.edge_limit ?? 500 }),
    dependency_cycles: components(nodes, edges), orphan_ids: nodes.filter(n => !edges.some(e => e.from === n.id || e.to === n.id)).map(n => n.id), dangling_edges: edges.filter(e => !byId.has(e.to)) };
}
function canonical(user, args = {}) {
  if (typeof args.subject !== 'string' || !args.subject.trim() || args.subject.length > 240) throw new Error('subject : texte non vide, au plus 240 caractères.');
  const nodes = snapshot(user), term = normal(args.subject), edges = edgesFor(nodes);
  const targets = nodes.filter(n => [n.id, n.sigle, n.canonical_subject, ...n.aliases].filter(Boolean).some(x => normal(x) === term));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const reachable = new Set(targets.map(n => n.id)), queue = [...reachable], migrations = [];
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges) {
      const next = e.from === id && e.type === 'replaced_by' ? e.to : e.to === id && e.type === 'supersedes' ? e.from : null;
      if (next && byId.has(next) && !reachable.has(next)) { reachable.add(next); queue.push(next); migrations.push(e); }
    }
  }
  for (const id of reachable) if (!targets.some(n => n.id === id)) targets.push(byId.get(id));
  const subjects = new Set([term, ...targets.map(n => normal(n.canonical_subject || n.id))]);
  const authorities = nodes.filter(n => ACTIVE(n) && !n.native_deprecated && n.authority === 'source_of_truth' && subjects.has(normal(n.canonical_subject || n.id)));
  const targetIds = new Set([...targets, ...authorities].map(n => n.id));
  const dependentIds = new Set(), derivedQueue = [...targetIds];
  while (derivedQueue.length) {
    const id = derivedQueue.shift();
    for (const e of edges) if (e.to === id && ['derives_from', 'governed_by', 'documents'].includes(e.type) && !targetIds.has(e.from) && !dependentIds.has(e.from)) { dependentIds.add(e.from); derivedQueue.push(e.from); }
  }
  const references = [];
  const words = [...new Set([args.subject, ...targets.flatMap(n => [n.sigle, ...n.aliases]).filter(Boolean)])];
  const re = new RegExp('(?<![\\p{L}\\p{N}_])(?:' + words.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\p{L}\\p{N}_])', 'iu');
  for (const n of nodes) {
    let text = '';
    if (n.kind === 'document' || n.kind === 'plan') { const d = M().lire(user, n.id.slice(9)); text = [d.titre, d.chapo, d.corps].join('\n'); }
    if (n.kind === 'sigle') { const f = M().lireFiche(user, n.sigle); text = [f.sens, f.detail, f.corps].join('\n'); }
    if (text && re.test(text)) references.push({ id: n.id, label: n.label, url: n.url, version: n.version });
  }
  return { ok: true, subject: args.subject, status: authorities.length > 1 ? 'conflict' : authorities.length === 1 ? 'resolved' : 'unknown', authorities,
    matches: targets, migrations, derived_views: nodes.filter(n => dependentIds.has(n.id)), mentions: page(references, args), basis: 'Métadonnées déclarées ; les occurrences textuelles ne sont pas des autorités.' };
}
function gc(user, args = {}) {
  const nodes = snapshot(user), edges = edgesFor(nodes), findings = auditData(nodes, edges);
  const candidates = nodes.map(n => {
    const codes = findings.filter(f => f.ids.includes(n.id)).map(f => f.code);
    let action = 'CONDITIONAL';
    if (n.lifecycle === 'tombstoned') action = 'TOMBSTONE';
    else if ((!ACTIVE(n) || n.native_deprecated) && n.evidence_refs.length && n.replaced_by.some(id => nodes.some(target => target.id === id && ACTIVE(target) && !target.native_deprecated))
      && !edges.some(e => e.to === n.id && ACTIVE(nodes.find(source => source.id === e.from)) && !['supersedes', 'replaced_by'].includes(e.type))) action = 'TOMBSTONE';
    else if (n.replaced_by.length && codes.includes('alias_collision')) action = 'MERGE';
    else if (!ACTIVE(n) || n.native_deprecated || n.authority === 'historical' || n.architectural_type === 'historical_alias') action = 'DEMOTE';
    else if (['measured', 'promoted'].includes(n.lifecycle) && (n.measurement_count > 0 || n.evidence_refs.length) && !codes.some(c => ['competing_authorities', 'dependency_cycle', 'deprecated_reference', 'dangling_reference'].includes(c))) action = 'KEEP';
    return { id: n.id, action, reasons: codes, benchmark_ids: n.benchmark_ids, evidence_refs: n.evidence_refs, decision: 'advisory_only' };
  });
  return { ok: true, writes: false, policy: 'Aucune suppression ni promotion automatique ; décision humaine et benchmarks nécessaires.', ...page(candidates, args) };
}
function mutate(user, args = {}, { auteur = 'ChatGPT' } = {}) {
  if (!M().peutEcrire(user)) return { ok: false, error: 'Réservé à Master ou aux éditeurs.' };
  if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 100) return { ok: false, error: 'changes : entre 1 et 100 modifications.' };
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return { ok: false, error: 'dry_run : booléen.' };
  init();
  snapshot(user); // initialiser les registres et leurs graines hors de la transaction
  db.exec('BEGIN IMMEDIATE');
  try {
    const nodes = new Map(snapshot(user).map(n => [n.id, n])), seen = new Set(), diff = [];
    for (const c of args.changes) {
      if (!c || Object.keys(c).some(k => !['id', 'version_attendue', 'metadata'].includes(k))) throw new Error('Modification : {id, version_attendue, metadata}.');
      const n = nodes.get(c.id);
      if (!n) throw new Error('Objet absent ou inaccessible : ' + c.id);
      if (seen.has(c.id)) throw new Error('Objet répété dans le lot : ' + c.id); seen.add(c.id);
      if (!Number.isInteger(c.version_attendue) || c.version_attendue !== n.architecture_version) throw new Error('Conflit de version architecturale : ' + c.id + ', version ' + n.architecture_version + ' en ligne.');
      validate(c.metadata);
      const after = { ...n.metadata, ...c.metadata };
      for (const k of Object.keys(after)) if (after[k] === null) delete after[k];
      for (const k of Object.keys(after).sort()) { const v = after[k]; delete after[k]; after[k] = v; }
      diff.push({ id: c.id, source_version: n.version, version_before: n.architecture_version, version_after: n.architecture_version + 1, before: n.metadata, after });
    }
    const fingerprint = hash(diff);
    if (args.dry_run !== false) { db.exec('ROLLBACK'); return { ok: true, dry_run: true, empreinte: fingerprint, diff }; }
    if (args.empreinte_attendue !== fingerprint) throw new Error('empreinte_attendue doit correspondre au dry-run courant. Relance la prévisualisation.');
    const t = new Date().toISOString();
    for (const d of diff) {
      const data = JSON.stringify(d.after);
      db.prepare('INSERT INTO metis_architecture(id,version,metadata,auteur,le) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,metadata=excluded.metadata,auteur=excluded.auteur,le=excluded.le').run(d.id, d.version_after, data, auteur, t);
      db.prepare('INSERT INTO metis_architecture_versions VALUES(?,?,?,?,?)').run(d.id, d.version_after, data, auteur, t);
    }
    db.exec('COMMIT'); return { ok: true, dry_run: false, empreinte: fingerprint, diff };
  } catch (e) { db.exec('ROLLBACK'); return { ok: false, error: e.message }; }
}
function history(user, args = {}) {
  const n = snapshot(user).find(n => n.id === args.id);
  if (!n) throw new Error('Objet absent ou inaccessible.');
  return { ok: true, id: n.id, architecture_version: n.architecture_version, ...page(db.prepare('SELECT version,metadata,auteur,le FROM metis_architecture_versions WHERE id=? ORDER BY version DESC').all(n.id).map(r => ({ ...r, metadata: JSON.parse(r.metadata) })), args) };
}
module.exports = { id: 'metisarchitecture', init, TYPES, LIFECYCLES, AUTHORITIES, SCOPES, RELATIONS, FIELDS, ENUMS, LISTS, STRINGS, snapshot, query, audit, graph, canonical, gc, mutate, history, hash };
// Pure helpers reused by the facade to derive a single coherent view.
Object.assign(module.exports, { edgesFor, auditData });
require('./metis-research-journal').bindWriters(module.exports, ['mutate']);
