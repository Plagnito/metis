'use strict';

// A portfolio is separate from Lab roots: a project never grants filesystem or execution access.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const U = () => require('../url'); // adresses publiques de l'instance (hôte)
const R = require('./metisresearch'), C = require('./metiscollaboration');
const J = require('./metis-research-journal'), F = require('./metis-access-fence');
const M = () => require('./metisdocs');
const PROJECT_STATES = ['idea', 'active', 'paused', 'done', 'archived'];
const TASK_STATES = ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const NOTE_KINDS = ['note', 'decision', 'risk', 'session'];
const CHIFFRE_ETATS = ['exploration', 'revue', 'cloture'];
const READS = ['projets_tableau', 'projets_lister', 'projets_lire', 'projets_taches', 'projets_jalons', 'projets_notes', 'projets_agenda', 'projets_prochaines_actions', 'projets_planifier', 'projets_journal', 'projets_exporter', 'projets_chiffre'];
const WRITES = new Set(['projets_creer', 'projets_modifier', 'projets_tache_creer', 'projets_tache_modifier', 'projets_jalon_enregistrer', 'projets_note_ajouter', 'projets_appliquer_plan', 'projets_chiffre_enregistrer']);
const NAMES = new Set([...READS, ...WRITES]);
const enabled = () => process.env.METIS_RESEARCH_ENABLED === '1' && process.env.METIS_COLLAB_ENABLED === '1';
const fail = (code, message) => { throw new R.ContractError(code, message, false); };
const now = () => new Date().toISOString();
const uid = prefix => prefix + ':' + crypto.randomUUID();
const text = (v, k, max = 2000) => C.text(v, k, max);
let ready = false;

function init() {
  if (ready) return;
  C.init();
  db.exec('SAVEPOINT metis_projects_migration');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS metis_projects (
      id TEXT PRIMARY KEY, owner_account INTEGER NOT NULL, owner_agent TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('private','metis_readers')),
      data TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_metis_projects_owner ON metis_projects(owner_account,id);
      CREATE TABLE IF NOT EXISTS metis_project_history(project_id TEXT NOT NULL REFERENCES metis_projects(id),revision INTEGER NOT NULL,
        operation TEXT NOT NULL,detail TEXT NOT NULL,actor_id TEXT NOT NULL,client_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,revision));
      CREATE TRIGGER IF NOT EXISTS metis_project_history_immutable_update BEFORE UPDATE ON metis_project_history BEGIN SELECT RAISE(ABORT,'Immutable project history'); END;
      CREATE TRIGGER IF NOT EXISTS metis_project_history_immutable_delete BEFORE DELETE ON metis_project_history BEGIN SELECT RAISE(ABORT,'Immutable project history'); END;
      CREATE TABLE IF NOT EXISTS metis_project_chiffre(project_id TEXT NOT NULL REFERENCES metis_projects(id),sequence INTEGER NOT NULL,
        data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,sequence));
      CREATE TRIGGER IF NOT EXISTS metis_project_chiffre_immutable_update BEFORE UPDATE ON metis_project_chiffre BEGIN SELECT RAISE(ABORT,'Immutable chiffre'); END;
      CREATE TRIGGER IF NOT EXISTS metis_project_chiffre_immutable_delete BEFORE DELETE ON metis_project_chiffre BEGIN SELECT RAISE(ABORT,'Immutable chiffre'); END;`);
    J.install(db);
    db.exec('RELEASE metis_projects_migration');
    ready = true;
  } catch (e) {
    db.exec('ROLLBACK TO metis_projects_migration; RELEASE metis_projects_migration');
    J.invalidate(db); throw e;
  }
}
function rawReadable(user, id) {
  if (!enabled() || !M().peutLire(user)) return false;
  init();
  const r = db.prepare('SELECT owner_account,visibility FROM metis_projects WHERE id=?').get(id);
  return !!r && (r.owner_account === Number(user) || r.visibility === 'metis_readers');
}
function get(user, id) {
  text(id, 'project_id', 100);
  if (!rawReadable(user, id) || !F.canRead(user, id)) fail('NOT_FOUND', 'Projet absent ou inaccessible.');
  return db.prepare('SELECT * FROM metis_projects WHERE id=?').get(id);
}
function visible(user) {
  if (!enabled() || !M().peutLire(user)) fail('PERMISSION_DENIED', 'Accès Métis requis.');
  init();
  return db.prepare("SELECT * FROM metis_projects WHERE (owner_account=? OR visibility='metis_readers') AND atlas_readable_ref(id,?)=1 ORDER BY id").all(Number(user),Number(user));
}
const choice = (v, values, key) => { if (!values.includes(v)) fail('INVALID_ARGUMENT', key + ': valeur inconnue.'); return v; };
function strings(v, key, max = 12, length = 160) {
  if (!Array.isArray(v) || v.length > max) fail('INVALID_ARGUMENT', key + ': liste trop longue ou invalide.');
  const out = v.map(x => text(x, key, length));
  if (new Set(out).size !== out.length) fail('INVALID_ARGUMENT', key + ': doublons interdits.');
  return out;
}
function date(v, key) {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
    fail('INVALID_ARGUMENT', key + ': date réelle YYYY-MM-DD ou null requise.');
  return v;
}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
const plus = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const closed = t => ['done', 'cancelled'].includes(t.state);
function blockers(p, t) { return t.depends_on.filter(id => p.tasks.find(x => x.id === id)?.state !== 'done'); }
function actionable(p, t, day) {
  return p.state === 'active' && ['ready', 'in_progress'].includes(t.state) && !blockers(p, t).length && (!t.start_on || t.start_on <= day);
}
function summary(r, day = today()) {
  const p = JSON.parse(r.data), counts = Object.fromEntries(TASK_STATES.map(s => [s, 0]));
  for (const t of p.tasks) counts[t.state]++;
  return { id: r.id, revision: r.revision, title: p.title, goal: p.goal, state: p.state, priority: p.priority,
    tags: p.tags, due_on: p.due_on, next_action: p.next_action, visibility: r.visibility,
    task_counts: counts, task_total: p.tasks.length,
    progress_percent: p.tasks.some(t => t.state !== 'cancelled') ? Math.round(100 * counts.done / p.tasks.filter(t => t.state !== 'cancelled').length) : null,
    overdue: p.tasks.filter(t => !closed(t) && t.due_on && t.due_on < day).length,
    actionable: p.tasks.filter(t => actionable(p, t, day)).length,
    milestones: p.milestones.length, notes: p.notes.length, niveau_chiffre: p.chiffre_etat?.niveau ?? null, updated_at: r.updated_at, content_trust: 'untrusted_data' };
}
function graph(p) {
  const visited = new Set(), visiting = new Set();
  function visit(t) {
    if (visiting.has(t.id)) fail('INVALID_ARGUMENT', 'Cycle de dépendances entre tâches.');
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const id of t.depends_on) {
      const target = p.tasks.find(x => x.id === id);
      if (!target) fail('INVALID_ARGUMENT', 'Dépendance absente de ce projet.');
      visit(target);
    }
    visiting.delete(t.id); visited.add(t.id);
  }
  p.tasks.forEach(visit);
  for (const t of p.tasks) {
    if (t.state === 'done' && blockers(p, t).length) fail('FAILED_PRECONDITION', 'Une tâche terminée exige des dépendances terminées.');
    if (t.state === 'done' && !t.outcome) fail('FAILED_PRECONDITION', 'Décrire le résultat avant de terminer une tâche.');
    if (t.state === 'blocked' && !t.blocked_reason) fail('INVALID_ARGUMENT', 'Une tâche bloquée exige un motif.');
    if (t.start_on && t.due_on && t.start_on > t.due_on) fail('INVALID_ARGUMENT', 'Début postérieur à l’échéance.');
    if (t.milestone_id && !p.milestones.some(m => m.id === t.milestone_id)) fail('INVALID_ARGUMENT', 'Jalon absent du projet.');
  }
  for (const m of p.milestones) if (m.state === 'done' && p.tasks.some(t => t.milestone_id === m.id && !closed(t))) fail('FAILED_PRECONDITION', 'Un jalon terminé ne peut pas contenir de tâche ouverte.');
}
// « Système du chiffre » : une couche de suivi, pas un moteur de preuves parallèle.
// Niveau = entier sans plafond (0, 1, … 10, 11…) avec au plus deux décimales, en écriture canonique
// (« 1.1 » et non « 1.10 », « 1.05 » et non « 1.050 »). index = valeur en centièmes, exacte.
function niveauChiffre(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,3})(?:\.(?:[1-9]|\d[1-9]))?$/.test(value))
    fail('INVALID_ARGUMENT', 'niveau : entier (0, 1, … 10, 11…) avec au plus deux décimales, écrit sans zéro final (1.1, 1.05, 12).');
  const [ent, dec = ''] = value.split('.');
  return { value, major: Number(ent), index: Number(ent) * 100 + Number((dec + '00').slice(0, 2)) };
}
const ecrireNiveau = index => { const ent = Math.floor(index / 100), c = index % 100;
  return c === 0 ? String(ent) : ent + '.' + (c % 10 === 0 ? String(c / 10) : String(c).padStart(2, '0')); };
// Pas suivants admis depuis un niveau : le centième suivant, le dixième suivant ou l'entier suivant.
// Depuis 1.1 : 1.11, 1.2 ou 2 ; depuis 1.15 : 1.16, 1.2 ou 2. Aucun saut (1.1 → 1.3 refusé).
function pasSuivants(index) {
  return [...new Set([index + 1, Math.floor(index / 10) * 10 + 10, Math.floor(index / 100) * 100 + 100])];
}
// État courant d'une ressource native, ou null si elle n'a pas de forme versionnée (ex. contract:).
function etatReference(user, id) {
  try { return C.reference(user, id); } catch (e) { if (e.code === 'NOT_FOUND') return null; throw e; }
}
// La révision déclarée est CONTRÔLÉE contre la ressource : une révision inexistante ou périmée
// fabriquerait une provenance. Le serveur épingle ce qu'il observe (revision_observee + empreinte)
// pour juger plus tard de la fraîcheur, sans réécrire la révision déclarée (null = « inconnue »).
function refsChiffre(value, user, projectId) {
  if (!Array.isArray(value) || value.length > 12)
    fail('INVALID_ARGUMENT', 'resource_refs : au plus 12 références versionnées.');
  const ids = new Set();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).some(k => !['id', 'revision', 'content_sha256'].includes(k)))
      fail('INVALID_ARGUMENT', 'Référence : id, revision (null si inconnue), empreinte SHA-256 facultative.');
    const id = text(ref.id, 'resource_refs.id', 240);
    if (ids.has(id)) fail('INVALID_ARGUMENT', 'Référence répétée.'); ids.add(id);
    if (id === projectId) fail('INVALID_ARGUMENT', 'Un projet ne peut pas se citer lui-même : citer la note, la tâche ou la preuve.');
    if (!Object.hasOwn(ref, 'revision')) fail('INVALID_ARGUMENT', 'revision explicite requise (null si inconnue).');
    if (ref.revision !== null && (!Number.isSafeInteger(ref.revision) || ref.revision < 1))
      fail('INVALID_ARGUMENT', 'revision doit être un entier positif ou null, jamais devinée.');
    if (ref.content_sha256 !== undefined && (typeof ref.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.content_sha256)))
      fail('INVALID_ARGUMENT', 'content_sha256 invalide.');
    F.assertReadable(user, id);
    const current = etatReference(user, id);
    if (!current) {
      if (ref.revision !== null || ref.content_sha256 !== undefined)
        fail('INVALID_ARGUMENT', 'Référence ' + id + ' sans révision native : revision null et aucune empreinte.');
      return { id, revision: null };
    }
    if (ref.revision !== null && ref.revision !== current.revision)
      fail('REVISION_CONFLICT', 'Référence ' + id + ' : révision ' + ref.revision + ' déclarée, ' + (current.revision ?? 'aucune') + ' actuelle ; relire avant de citer.');
    if (ref.content_sha256 !== undefined && ref.content_sha256 !== current.content_sha256)
      fail('REVISION_CONFLICT', 'Référence ' + id + ' : empreinte différente du contenu actuel ; relire avant de citer.');
    return { id, revision: ref.revision, revision_observee: current.revision, content_sha256: current.content_sha256 };
  });
}
// Fraîcheur calculée à la lecture : jamais stockée, jamais déduite d'une clôture.
function fraicheurChiffre(user, ref) {
  if (!ref.content_sha256) return { ...ref, fraicheur: 'non_versionnee' };
  if (!F.canRead(user, ref.id)) return { id: ref.id, fraicheur: 'inaccessible' };
  const current = etatReference(user, ref.id);
  if (!current) return { ...ref, fraicheur: 'absente' };
  if (current.content_sha256 === ref.content_sha256) return { ...ref, fraicheur: 'a_jour' };
  return { ...ref, fraicheur: 'perimee', revision_actuelle: current.revision };
}
const normaliserNouveaute = s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function progressionChiffre(etapes, niveau) {
  if (!etapes.length && niveau.index !== 0) fail('FAILED_PRECONDITION', 'La campagne commence au niveau 0.');
  const last = etapes.at(-1);
  if (!last) return;
  const avant = niveauChiffre(last.niveau);
  if (niveau.index < avant.index) fail('FAILED_PRECONDITION', 'Progression rétrograde : écrire un nouvel état du niveau courant.');
  // Un niveau clos devient documentaire : on n'y écrit plus, une objection tardive va au niveau suivant.
  if (niveau.index === avant.index) {
    if (last.etat === 'cloture') fail('FAILED_PRECONDITION', 'Niveau ' + avant.value + ' clos : documentaire seulement ; ouvrir le niveau suivant.');
    return;
  }
  if (last.etat !== 'cloture') fail('FAILED_PRECONDITION', 'Clore le niveau courant avant de progresser.');
  const admis = pasSuivants(avant.index);
  if (!admis.includes(niveau.index))
    fail('FAILED_PRECONDITION', 'Après ' + avant.value + ', le pas suivant est ' + admis.map(ecrireNiveau).join(', ').replace(/, ([^,]*)$/, ' ou $1') + ' (aucun saut).');
}
// Affirmation citée : son statut déclaré et les affirmations lisibles de polarité opposée
// (même sujet, portée et prédicat, la règle de find_contradictions). Indicatif, aucun verdict.
function contradictionsClaim(user, id) {
  if (!id.startsWith('claim:') || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='metis_science_objects'").get()) return {};
  const row = db.prepare("SELECT data FROM metis_science_objects WHERE id=? AND kind='claim'").get(id);
  if (!row) return {};
  const d = JSON.parse(row.data);
  const opposees = d.polarity && d.polarity !== 'unspecified'
    ? db.prepare(`SELECT id FROM metis_science_objects WHERE kind='claim' AND id<>? AND json_extract(data,'$.subject')=? AND json_extract(data,'$.scope')=?
        AND json_extract(data,'$.predicate') IS ? AND json_extract(data,'$.polarity') NOT IN (?,'unspecified') AND atlas_readable_ref(id,?)=1 ORDER BY id LIMIT 11`)
      .all(id, d.subject, d.scope, d.predicate ?? null, d.polarity, Number(user)).map(x => x.id)
    : [];
  return { statut_affirmation: d.status ?? null, contradictions: opposees.slice(0, 10), contradictions_tronquees: opposees.length > 10 };
}
// Vue d'une référence pour un lecteur donné : fraîcheur, puis statut et contradictions d'un claim:.
function annoterRef(user, ref) {
  const f = fraicheurChiffre(user, ref);
  return f.fraicheur === 'inaccessible' ? f : { ...f, ...contradictionsClaim(user, ref.id) };
}
// Titre d'un objet lisible par ce lecteur (affichage seulement), null sinon.
function titreLisible(user, id) {
  if (!F.canRead(user, id)) return null;
  try { return R.resource(user, id)?.title ?? null; } catch { return null; }
}
const NOTE_HISTORIQUE = /\bN\d{1,2}(?:\.\d{1,2})?(?:\/\d+)?\b/i;
// Le chiffre vit dans sa propre table append-only : une longue campagne ne remplit pas le projet
// (512 Ko partagés avec tâches et notes) et l'historique ne peut être ni modifié ni effacé.
function etapesChiffre(projectId) {
  init();
  return db.prepare('SELECT data FROM metis_project_chiffre WHERE project_id=? ORDER BY sequence').all(projectId).map(x => JSON.parse(x.data));
}
// Références d'un niveau, prêtes pour context_pack (must_include_ids) puis validate_context_pack.
function referencesNiveau(etapes, niveau) {
  return [...new Set(etapes.filter(e => e.niveau === niveau).flatMap(e => (e.resource_refs || []).map(r => r.id)))];
}
function bilanChiffre(p, etapes) {
  const last = etapes.at(-1) || null;
  const legacy = p.notes.filter(n => NOTE_HISTORIQUE.test(n.title))
    .map(n => ({ id: n.id, title: n.title, etat: 'non_qualifie', nature: 'note_historique' }));
  return { etapes, niveau_actuel: last?.niveau ?? null, etat_actuel: last?.etat ?? null,
    prochaine_action: last?.suite ?? null, notes_historiques_non_migrees: legacy,
    assurance: 'États déclaratifs ; seule une preuve et sa vérification indépendante peuvent valider une affirmation scientifique.',
    progression: 'Commence à 0, sans plafond (10, 11…). Pas suivant : centième, dixième ou entier suivant (depuis 1.1 : 1.11, 1.2 ou 2), après clôture documentaire du niveau courant.' };
}
function taskFields(a, existing = {}, user) {
  const t = { title: '', description: '', state: 'backlog', priority: 'normal', assignee: '', depends_on: [], checklist: [],
    start_on: null, due_on: null, remind_on: null, estimate_minutes: null, spent_minutes: 0, blocked_reason: '', outcome: '', milestone_id: null, ...existing };
  for (const k of ['title', 'description', 'assignee', 'blocked_reason', 'outcome']) if (a[k] !== undefined) t[k] = C.text(a[k], k, k === 'title' ? 160 : k === 'assignee' ? 80 : 2000, k === 'title');
  for (const k of ['state', 'priority']) if (a[k] !== undefined) t[k] = choice(a[k], k === 'state' ? TASK_STATES : PRIORITIES, k);
  for (const k of ['start_on', 'due_on', 'remind_on']) if (a[k] !== undefined) t[k] = date(a[k], k);
  if (a.depends_on !== undefined) t.depends_on = strings(a.depends_on, 'depends_on', 30, 100);
  if (a.milestone_id !== undefined) t.milestone_id = a.milestone_id === null ? null : text(a.milestone_id, 'milestone_id', 100);
  for (const k of ['estimate_minutes', 'spent_minutes']) if (a[k] !== undefined) t[k] = a[k] === null && k === 'estimate_minutes' ? null : R.integer(a[k], undefined, k === 'estimate_minutes' ? 1 : 0, 100000, k);
  if (a.checklist !== undefined) {
    if (!Array.isArray(a.checklist) || a.checklist.length > 30) fail('INVALID_ARGUMENT', 'checklist: au plus 30 étapes.');
    t.checklist = a.checklist.map(x => {
      if (!x || Object.keys(x).some(k => !['title', 'done'].includes(k)) || typeof x.done !== 'boolean') fail('INVALID_ARGUMENT', 'Étape: title et done requis.');
      return { title: text(x.title, 'checklist.title', 160), done: x.done };
    });
  }
  if (t.state === 'done' && t.checklist.some(x => !x.done)) fail('FAILED_PRECONDITION', 'Terminer les étapes de la checklist.');
  return require('./metisdevelopment').normalizeTask(a, t, user);
}
function projectFields(a, existing = {}) {
  const p = { title: '', goal: '', state: 'active', priority: 'normal', tags: [], due_on: null, next_action: '', links: [], tasks: [], milestones: [], notes: [], ...existing };
  for (const k of ['title', 'goal', 'next_action']) if (a[k] !== undefined) p[k] = C.text(a[k], k, k === 'title' ? 160 : 2000, k !== 'next_action');
  if (a.state !== undefined) p.state = choice(a.state, PROJECT_STATES, 'state');
  if (a.priority !== undefined) p.priority = choice(a.priority, PRIORITIES, 'priority');
  if (a.tags !== undefined) p.tags = strings(a.tags, 'tags');
  if (a.due_on !== undefined) p.due_on = date(a.due_on, 'due_on');
  if (a.links !== undefined) p.links = strings(a.links, 'links', 12, 500).map(link => {
    let u; try { u = new URL(link); } catch { fail('INVALID_ARGUMENT', 'Lien HTTP(S) absolu requis.'); }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) fail('INVALID_ARGUMENT', 'Lien HTTP(S) sans identifiants requis.');
    return u.href;
  });
  return p;
}
function save(r, p, self, args, operation, detail, extraDependencies = []) {
  // Les références du chiffre rejoignent summary_dependencies (conservées d'une révision à l'autre) :
  // l'ACL du projet reste transitive même si les étapes vivent dans leur propre table.
  p.summary_dependencies = [...new Set([...(r ? F.dependencies(JSON.parse(r.data)) : []),
    ...p.tasks.flatMap(t => [...(t.work_ref ? [t.work_ref.id] : []), ...(t.validation_refs || [])]),
    ...extraDependencies])];
  p.summary_dependencies.forEach(id => F.assertReadable(self.account,id));
  if (r) for (const t of p.tasks.filter(t => t.state==='done')) {const old=JSON.parse(r.data).tasks.find(x=>x.id===t.id),D=require('./metisdevelopment');if(!old||old.state!=='done'||D.contractHash(old)!==D.contractHash(t)||JSON.stringify(old.validation_refs)!==JSON.stringify(t.validation_refs)||JSON.stringify(old.validation_source)!==JSON.stringify(t.validation_source))D.validateCompletion(self.account,r.id,t);}
  if (Buffer.byteLength(JSON.stringify(p)) > 512000) fail('INVALID_ARGUMENT', 'Projet limité à 512 Ko ; répartir les travaux.');
  graph(p);
  const stamp = now();
  if (r) {
    if (r.owner_account !== self.account) fail('PERMISSION_DENIED', 'Modification réservée au compte propriétaire.');
    C.cas(r, args);
    // Sharing the whole project is explicit. All child records inherit this ACL.
    const visibility = args.visibility === undefined ? r.visibility : choice(args.visibility, ['private', 'metis_readers'], 'visibility');
    db.prepare('UPDATE metis_projects SET data=?,visibility=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(p), visibility, stamp, r.id, r.revision);
    r = get(self.account, r.id);
  } else {
    if (args.expected_revision !== 0) fail('REVISION_CONFLICT', 'Création: expected_revision=0 requis.');
    C.quota('SELECT count(*) n FROM metis_projects WHERE owner_account=?', [self.account], 100);
    C.quota('SELECT count(*) n FROM metis_projects', [], 1000);
    const visibility = choice(args.visibility ?? 'private', ['private', 'metis_readers'], 'visibility');
    const id = uid('project');
    db.prepare('INSERT INTO metis_projects VALUES(?,?,?,?,?,1,?,?)').run(id, self.account, self.id, visibility, JSON.stringify(p), stamp, stamp);
    r = get(self.account, id);
  }
  db.prepare('INSERT INTO metis_project_history(project_id,revision,operation,detail,actor_id,client_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(r.id, r.revision, operation, JSON.stringify(detail || {}), self.id, self.client, stamp);
  return { project: summary(r), ...(detail || {}) };
}
function page(items, args, user, signature, version, request, map = x => x, extra = {}) {
  const state = args.cursor ? R.decode(args.cursor, 'projects', user) : null;
  const policy = F.generation();
  if (state && (state.signature !== signature || state.version !== version || state.policy !== policy)) fail('STALE_CURSOR', 'Projet, filtres ou droits modifiés ; recommencer sans curseur.');
  const offset = state?.offset ?? 0, limit = R.integer(args.limit, 20, 1, 100, 'limit'), selected = [];
  let pos = offset;
  const make = () => R.envelope(request, { ...extra, items: selected, has_more: pos < items.length }, R.high(), {
    next_cursor: pos < items.length ? R.cursor({ type: 'projects', signature, version, policy, offset: pos }, user) : null, truncated: pos < items.length });
  while (pos < items.length && selected.length < limit) {
    selected.push(map(items[pos])); pos++;
    if (Buffer.byteLength(JSON.stringify(make())) > R.budget(args)) {
      if (selected.length === 1) R.assertBudget(make(), args);
      selected.pop(); pos--; break;
    }
  }
  return make();
}
function plan(r, a) {
  const p = JSON.parse(r.data), start = date(a.start_on === undefined ? today() : a.start_on, 'start_on');
  if (!start) fail('INVALID_ARGUMENT', 'start_on ne peut pas être null.');
  const capacity = R.integer(a.daily_minutes, 240, 15, 1440, 'daily_minutes');
  const horizon = R.integer(a.horizon_days, 30, 1, 180, 'horizon_days');
  if (a.weekends !== undefined && typeof a.weekends !== 'boolean') fail('INVALID_ARGUMENT', 'weekends: booléen requis.');
  const weekends = a.weekends ?? false, schedule = [], excluded = [], finishes = new Map();
  const days = Array.from({ length: horizon }, (_, i) => plus(start, i)).filter(d => weekends || ![0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay()));
  const used = new Map(days.map(d => [d, 0]));
  const rank = t => PRIORITIES.indexOf(t.priority);
  const ordered = [], seen = new Set();
  function visit(t) { if (seen.has(t.id)) return; seen.add(t.id); t.depends_on.forEach(id => visit(p.tasks.find(x => x.id === id))); ordered.push(t); }
  [...p.tasks].sort((a, b) => rank(a) - rank(b) || (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.id.localeCompare(b.id)).forEach(visit);
  for (const t of ordered) {
    if (t.state === 'done') { finishes.set(t.id, { day: start, minute: 0 }); continue; }
    let reason = p.state !== 'active' ? 'project_inactive' : ['blocked', 'review', 'cancelled'].includes(t.state) ? t.state : t.estimate_minutes === null ? 'estimate_missing' : null;
    if (!reason && t.depends_on.some(id => !finishes.has(id))) reason = 'dependency_unscheduled';
    if (reason) { excluded.push({ task_id: t.id, title: t.title, reason }); continue; }
    const dependencies = t.depends_on.map(id => finishes.get(id));
    const slots = [], provisional = new Map(used);
    let remaining = Math.max(0, t.estimate_minutes - t.spent_minutes);
    if (!remaining) { excluded.push({ task_id: t.id, title: t.title, reason: 'estimate_exhausted' }); continue; }
    for (const day of days) {
      if (t.start_on && day < t.start_on || dependencies.some(f => f.day > day)) continue;
      const floor = Math.max(provisional.get(day), ...dependencies.filter(f => f.day === day).map(f => f.minute));
      const minutes = Math.min(remaining, capacity - floor);
      if (minutes <= 0) continue;
      slots.push({ date: day, start_minute: floor, minutes }); provisional.set(day, floor + minutes); remaining -= minutes;
      if (!remaining) break;
    }
    if (remaining) { excluded.push({ task_id: t.id, title: t.title, reason: 'horizon_capacity' }); continue; }
    for (const [day, minutes] of provisional) used.set(day, minutes);
    const end = slots.at(-1); finishes.set(t.id, { day: end.date, minute: end.start_minute + end.minutes });
    schedule.push({ task_id: t.id, title: t.title, slots, starts_on: slots[0].date, ends_on: end.date, late: !!t.due_on && end.date > t.due_on });
  }
  const data = { project_id: r.id, project_revision: r.revision, start_on: start, daily_minutes: capacity, horizon_days: horizon, weekends,
    schedule, excluded, planning_model: 'sequential capacity for one worker; dates in Europe/Paris; no automatic execution' };
  return { ...data, plan_hash: R.hash(data), dry_run: true };
}
function actions(rows, day) {
  return rows.flatMap(r => { const p = JSON.parse(r.data); return p.tasks.filter(t => actionable(p, t, day)).map(t => ({ project_id: r.id, project_title: p.title, project_revision: r.revision, ...t })); })
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.id.localeCompare(b.id));
}
function execute(name, a, user, self) {
  const r = Object.hasOwn(a, 'project_id') ? get(user, a.project_id) : null;
  if (name === 'projets_creer') {
    text(a.title, 'title', 160); text(a.goal, 'goal');
    return save(null, projectFields(a), self, a, name);
  }
  if (!r) fail('INVALID_ARGUMENT', 'project_id requis.');
  if (r.owner_account !== self.account) fail('PERMISSION_DENIED', 'Modification réservée au compte propriétaire.');
  C.cas(r, a);
  const p = JSON.parse(r.data);
  if (name === 'projets_modifier') { const updated = projectFields(a, p); if (a.state !== undefined) delete updated.plan; return save(r, updated, self, a, name); }
  if (name === 'projets_tache_creer' || name === 'projets_tache_modifier') {
    const old = name === 'projets_tache_modifier' ? p.tasks.find(t => t.id === a.task_id) : null;
    if (name === 'projets_tache_modifier' && !old) fail('NOT_FOUND', 'Tâche absente de ce projet.');
    if (!old && p.tasks.length >= 200) fail('INVALID_ARGUMENT', 'Au plus 200 tâches par projet.');
    if (!old) text(a.title, 'title', 160);
    const t = { ...taskFields(a, old || {}, user), id: old?.id || uid('task'), revision: old ? (old.revision || 1)+1 : 1, updated_at: now() };
    if (old) p.tasks[p.tasks.indexOf(old)] = t; else p.tasks.push(t);
    // Changing scope invalidates the saved planning snapshot rather than presenting stale dates as current.
    delete p.plan;
    return save(r, p, self, a, name, { task: t });
  }
  if (name === 'projets_jalon_enregistrer') {
    const old = a.milestone_id ? p.milestones.find(m => m.id === a.milestone_id) : null;
    if (a.milestone_id && !old) fail('NOT_FOUND', 'Jalon absent du projet.');
    if (!old && p.milestones.length >= 50) fail('INVALID_ARGUMENT', 'Au plus 50 jalons.');
    const milestone = { id: old?.id || uid('milestone'), revision: old ? (old.revision || 1)+1 : 1, title: text(a.title, 'title', 160), due_on: date(a.due_on, 'due_on'), criteria: text(a.criteria, 'criteria'), state: choice(a.state ?? 'open', ['open', 'done', 'cancelled'], 'state') };
    if (milestone.state === 'done' && p.tasks.some(t => t.milestone_id === milestone.id && !closed(t))) fail('FAILED_PRECONDITION', 'Des tâches du jalon sont encore ouvertes.');
    if (old) p.milestones[p.milestones.indexOf(old)] = milestone; else p.milestones.push(milestone);
    return save(r, p, self, a, name, { milestone });
  }
  if (name === 'projets_note_ajouter') {
    if (p.notes.length >= 200) fail('INVALID_ARGUMENT', 'Au plus 200 notes par projet.');
    const note = { id: uid('project_note'), kind: choice(a.kind ?? 'note', NOTE_KINDS, 'kind'), title: text(a.title, 'title', 160), body: text(a.body, 'body'), created_at: now(), author: self.id };
    if (a.task_id && !p.tasks.some(t => t.id === a.task_id)) fail('NOT_FOUND', 'Tâche absente de ce projet.');
    if (a.task_id) note.task_id = a.task_id;
    if (a.next_action !== undefined) p.next_action = C.text(a.next_action, 'next_action', 2000, false);
    p.notes.push(note);
    return save(r, p, self, a, name, { note });
  }
  if (name === 'projets_chiffre_enregistrer') {
    const etapes = etapesChiffre(r.id);
    // Pas de plafond de profondeur ; seulement une borne de stockage par projet, très au-delà d'une campagne réelle.
    if (etapes.length >= 5000) fail('INVALID_ARGUMENT', 'Chiffre limité à 5 000 états par projet ; poursuivre dans un projet dédié.');
    const niveau = niveauChiffre(a.niveau);
    progressionChiffre(etapes, niveau);
    const etat = choice(a.etat, CHIFFRE_ETATS, 'etat');
    const nouveautes = strings(a.nouveautes, 'nouveautes', 12, 500);
    const incertitudes = strings(a.incertitudes, 'incertitudes', 12, 500);
    const objections = strings(a.objections || [], 'objections', 12, 500);
    // Traçabilité des nouveautés : une découverte d'un niveau antérieur ne compte pas une seconde fois.
    // Au sein d'un même niveau, la clôture peut reprendre ce que l'exploration a trouvé (pas de remplissage forcé).
    const memeNiveau = etapes.filter(e => e.niveau === niveau.value);
    const dejaVues = new Set(etapes.filter(e => e.niveau !== niveau.value).flatMap(e => e.nouveautes || []).map(normaliserNouveaute));
    const repetee = nouveautes.find(n => dejaVues.has(normaliserNouveaute(n)));
    if (repetee) fail('FAILED_PRECONDITION', 'Nouveauté déjà consignée à un niveau précédent : « ' + repetee.slice(0, 80) + ' ».');
    const resource_refs = refsChiffre(a.resource_refs || [], user, r.id);
    if (etat === 'cloture' && (![...memeNiveau.flatMap(e => e.nouveautes || []), ...nouveautes].length || !resource_refs.length))
      fail('FAILED_PRECONDITION', 'Clôture documentaire : au moins une découverte dans ce niveau et une référence accessible.');
    const entry = { sequence: etapes.length + 1, niveau: niveau.value, etat,
      resume: text(a.resume, 'resume', 2000), nouveautes, incertitudes, objections, resource_refs,
      suite: text(a.suite, 'suite', 2000), code_commit: a.code_commit === undefined ? null : text(a.code_commit, 'code_commit', 80),
      author: self.id, created_at: now() };
    if (entry.code_commit && !/^[a-f0-9]{40}$/.test(entry.code_commit))
      fail('INVALID_ARGUMENT', 'code_commit : SHA Git complet (40 caractères) requis.');
    // Le projet ne garde que l'état courant ; sa révision porte toujours le CAS et l'idempotence.
    p.chiffre_etat = { sequence: entry.sequence, niveau: entry.niveau, etat: entry.etat, suite: entry.suite };
    const out = save(r, p, self, a, name, { checkpoint: entry }, resource_refs.map(ref => ref.id));
    db.prepare('INSERT INTO metis_project_chiffre(project_id,sequence,data,created_at) VALUES(?,?,?,?)')
      .run(r.id, entry.sequence, JSON.stringify(entry), entry.created_at);
    return out;
  }
  if (name === 'projets_appliquer_plan') {
    const proposal = plan(r, a);
    if (a.plan_hash !== proposal.plan_hash) fail('REVISION_CONFLICT', 'Prévisualiser ce planning exact avant de l’enregistrer.');
    p.plan = { ...proposal, dry_run: false, saved_at: now(), source_revision: r.revision };
    return save(r, p, self, a, name, { plan_hash: proposal.plan_hash, scheduled: proposal.schedule.length, excluded: proposal.excluded.length });
  }
  fail('INVALID_ARGUMENT', 'Opération inconnue.');
}
function read(name, a, user, request) {
  const day = a.on === undefined ? today() : date(a.on, 'on');
  if (!day) fail('INVALID_ARGUMENT', 'on ne peut pas être null.');
  const r = Object.hasOwn(a, 'project_id') ? get(user, a.project_id) : null;
  const p = r ? JSON.parse(r.data) : null;
  const signature = R.hash({ name, ...Object.fromEntries(Object.entries(a).filter(([k]) => !['cursor', 'limit', 'max_tokens', 'max_bytes'].includes(k))), day });
  const result = data => R.envelope(request, data, R.high());
  if (name === 'projets_lire') return result({ ...summary(r, day), links: p.links, plan: p.plan ? { plan_hash: p.plan.plan_hash, saved_at: p.plan.saved_at, scheduled: p.plan.schedule.length, excluded: p.plan.excluded.length } : null, category: 'Autres projets', detail_tools: ['projets_taches', 'projets_jalons', 'projets_notes', 'projets_journal'] });
  if (name === 'projets_chiffre') {
    const { etapes, notes_historiques_non_migrees, ...meta } = bilanChiffre(p, etapesChiffre(r.id));
    const historiques = notes_historiques_non_migrees.slice(0, 10);
    const avecFraicheur = e => ({ ...e, resource_refs: (e.resource_refs || []).map(ref => annoterRef(user, ref)) });
    const niveaux = [...new Set(etapes.map(e => e.niveau))];
    const clos = niveaux.filter(n => etapes.some(e => e.niveau === n && e.etat === 'cloture'));
    return page(etapes, a, user, signature, r.revision, request, avecFraicheur, {
      project_id: r.id, project_revision: r.revision, ...meta,
      // Un niveau clos se reprend par un context pack épinglé sur ses références, puis validate_context_pack.
      niveaux_clos: clos.slice(-12).map(n => { const ids = referencesNiveau(etapes, n);
        return { niveau: n, context_pack: { must_include_ids: ids.slice(0, 12), references_tronquees: ids.length > 12 } }; }),
      contradictions_methode: 'Pour chaque claim: cité, affirmations lisibles de polarité opposée (même sujet, portée, prédicat), comme find_contradictions ; indicatif, aucun verdict.',
      notes_historiques_total: notes_historiques_non_migrees.length,
      notes_historiques_non_migrees: historiques,
      notes_historiques_tronquees: notes_historiques_non_migrees.length > historiques.length,
      fraicheur_references: 'Par référence, calculée à cette lecture contre l’empreinte observée à l’écriture : a_jour, perimee, absente, inaccessible ou non_versionnee. Les dépôts GitHub externes ne sont pas revérifiés.',
      validation_niveau: 'declarative ; aucune preuve indépendante inférée de la clôture',
    });
  }
  if (name === 'projets_jalons') return page(p.milestones, a, user, signature, r.revision, request);
  if (name === 'projets_taches' || name === 'projets_notes') {
    let items = name === 'projets_taches' ? p.tasks : p.notes;
    if (a.state !== undefined) { choice(a.state, TASK_STATES, 'state'); items = items.filter(t => t.state === a.state); }
    if (a.kind !== undefined) { choice(a.kind, NOTE_KINDS, 'kind'); items = items.filter(t => t.kind === a.kind); }
    return page(items, a, user, signature, r.revision, request, t => ({ ...t, project_id: r.id, project_revision: r.revision, ...(name === 'projets_taches' ? { blocking_ids: blockers(p, t), actionable: actionable(p, t, day) } : {}) }));
  }
  if (name === 'projets_planifier') {
    const proposal = plan(r, a), { schedule, excluded, ...meta } = proposal;
    return page([...schedule.map(x => ({ kind: 'scheduled', ...x })), ...excluded.map(x => ({ kind: 'excluded', ...x }))], a, user, signature, r.revision, request, x => x, { ...meta, scheduled: schedule.length, excluded: excluded.length });
  }
  if (name === 'projets_journal') return page(db.prepare('SELECT revision,operation,detail,actor_id,client_id,created_at FROM metis_project_history WHERE project_id=? ORDER BY revision DESC').all(r.id), a, user, signature, r.revision, request, h => ({ ...h, detail: JSON.parse(h.detail) }));
  const rows = r ? [r] : visible(user);
  const version = R.hash(rows.map(x => [x.id, x.revision]));
  if (name === 'projets_lister') {
    if (a.state !== undefined) choice(a.state, PROJECT_STATES, 'state');
    if (a.query !== undefined) text(a.query, 'query', 160);
    if (a.tag !== undefined) text(a.tag, 'tag', 160);
    const list = rows.map(x => summary(x, day)).filter(x => (!a.state || x.state === a.state) && (!a.tag || x.tags.includes(a.tag)) && (!a.query || (x.title + ' ' + x.goal + ' ' + x.tags.join(' ')).toLocaleLowerCase('fr').includes(a.query.toLocaleLowerCase('fr'))));
    return page(list, a, user, signature, version, request);
  }
  if (name === 'projets_tableau') {
    const summaries = rows.map(x => summary(x, day));
    return result({ category: 'Autres projets', on: day, projects: summaries.length, by_state: Object.fromEntries(PROJECT_STATES.map(s => [s, summaries.filter(p => p.state === s).length])), tasks: summaries.reduce((n, p) => n + p.task_total, 0), overdue: summaries.reduce((n, p) => n + p.overdue, 0), actionable: summaries.reduce((n, p) => n + p.actionable, 0), tools: [...NAMES], workflow: 'lister → lire/taches/notes → prochaines_actions → planifier → appliquer_plan ; conserver project_id et revision' });
  }
  if (name === 'projets_prochaines_actions') return page(actions(rows, day), a, user, signature, version, request);
  if (name === 'projets_agenda') {
    const horizon = R.integer(a.horizon_days, 14, 1, 180, 'horizon_days'), end = plus(day, horizon - 1), items = [];
    for (const row of rows) {
      const project = JSON.parse(row.data);
      if (['done', 'archived'].includes(project.state)) continue;
      const add = (kind, id, title, due) => { if (due && due <= end) items.push({ kind, id, title, project_id: row.id, project_title: project.title, date: due, overdue: due < day }); };
      add('project_deadline', row.id, project.title, project.due_on);
      for (const t of project.tasks.filter(t => !closed(t))) { add('task_deadline', t.id, t.title, t.due_on); add('reminder', t.id, t.title, t.remind_on); }
      for (const m of project.milestones.filter(m => m.state === 'open')) add('milestone', m.id, m.title, m.due_on);
      for (const t of project.plan?.schedule || []) if (!closed(project.tasks.find(x => x.id === t.task_id))) for (const slot of t.slots) if (slot.date >= day && slot.date <= end) items.push({ kind: 'planned_work', id: t.task_id, title: t.title, project_id: row.id, date: slot.date, minutes: slot.minutes });
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return page(items, a, user, signature, version, request);
  }
  if (name === 'projets_exporter') {
    const format = choice(a.format ?? 'json', ['json', 'markdown', 'ical'], 'format');
    const records = [{ kind: 'project', ...summary(r, day), links: p.links }, ...p.milestones.map(x => ({ kind: 'milestone', ...x })), ...p.tasks.map(x => ({ kind: 'task', ...x })), ...p.notes.map(x => ({ record_kind: 'note', ...x })),
      ...etapesChiffre(r.id).map(e => ({ kind: 'chiffre', id: r.id + ':chiffre:' + e.sequence, title: 'Chiffre · niveau ' + e.niveau + ' · ' + e.etat, description: e.resume, ...e }))];
    if (p.plan) {
      const { schedule, excluded, ...metadata } = p.plan;
      records.push({ kind: 'planning', id: r.id + ':plan', title: 'Planning enregistré', ...metadata }, ...schedule.map(x => ({ kind: 'planned_task', id: x.task_id, ...x })), ...excluded.map(x => ({ kind: 'excluded_task', id: x.task_id, ...x })));
    }
    const escape = s => String(s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const fold = line => { let out = '', part = ''; for (const char of line) { if (Buffer.byteLength(part + char) > 73) { out += part + '\r\n '; part = ''; } part += char; } return out + part; };
    return page(records, a, user, signature, r.revision, request, item => {
      if (format === 'json') return item;
      if (format === 'markdown') return { id: item.id, text: `## ${item.title}\n\n${item.goal || item.description || item.body || item.criteria || ''}\n\nÉtat : ${item.state || item.kind}\nÉchéance : ${item.due_on || 'Non renseignée'}\n` };
      return { id: item.id, text: item.due_on ? ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Atlas//Metis Projects//FR', 'BEGIN:VEVENT', 'UID:' + escape(item.id) + '@metis', 'DTSTAMP:' + r.updated_at.replace(/[-:]/g, '').replace(/\.\d{3}/, ''), 'DTSTART;VALUE=DATE:' + item.due_on.replaceAll('-', ''), 'DTEND;VALUE=DATE:' + plus(item.due_on, 1).replaceAll('-', ''), 'SUMMARY:' + escape(item.title), 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') : '' };
    });
  }
  fail('INVALID_ARGUMENT', 'Opération inconnue.');
}
function call(name, a, user) {
  const request = crypto.randomUUID();
  try {
    if (!enabled()) fail('DEPENDENCY_UNAVAILABLE', 'Recherche et collaboration Métis requises.');
    if (!M().peutLire(user)) fail('PERMISSION_DENIED', 'Accès Métis requis.');
    const schema = require('../web/metis-project-tools').definition(name)?.inputSchema;
    if (!schema || !a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !Object.hasOwn(a, k))) fail('INVALID_ARGUMENT', 'Arguments absents ou inconnus ; consulter le schéma.');
    if (Buffer.byteLength(JSON.stringify(a)) > 24000) fail('INVALID_ARGUMENT', 'Arguments limités à 24 Ko.');
    try { require('../web/metis-architecture-tools').validateSchema(a, schema, 'arguments'); }
    catch { fail('INVALID_ARGUMENT', 'Arguments hors contrat ; consulter le schéma courant.'); }
    R.budget(a); R.rate(user, name); init();
    let out;
    db.exec('SAVEPOINT metis_projects_call');
    try {
      if (WRITES.has(name)) {
        C.writer(user); const self = C.identity(user), key = text(a.idempotency_key, 'idempotency_key', 160);
        const fingerprint = R.hash(Object.fromEntries(Object.entries(a).filter(([k]) => !['idempotency_key', 'max_tokens', 'max_bytes'].includes(k))));
        const previous = db.prepare('SELECT * FROM metis_research_requests WHERE actor=? AND operation=? AND request_key=?').get(self.id, name, key);
        let data;
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Clé déjà utilisée pour une autre requête.');
          data = JSON.parse(previous.response);
          const current = get(user, data.project.id);
          // A later revocation of sharing must also hide the cached response.
          if (current.owner_account !== Number(user)) fail('PERMISSION_DENIED', 'Résultat devenu inaccessible.');
        } else {
          if (a.project_id) require('./metisdevelopment').assertWriter(user,self,a.project_id);
          data = execute(name, a, user, self);
          db.prepare('INSERT INTO metis_research_requests VALUES(?,?,?,?,?)').run(self.id, name, key, fingerprint, JSON.stringify(data));
        }
        out = R.envelope(request, data, R.high());
      } else out = read(name, a, user, request);
      R.assertBudget(out, a);
      db.exec('RELEASE metis_projects_call');
    } catch (e) { db.exec('ROLLBACK TO metis_projects_call; RELEASE metis_projects_call'); throw e; }
    return out;
  } catch (e) {
    const known = e instanceof R.ContractError;
    return require('./metis-recovery').normalize({ ok: false, request_id: request, schema_version: '1', error: { code: known ? e.code : 'DEPENDENCY_UNAVAILABLE', message: known ? e.message : 'Dépendance Projets indisponible.', retryable: known ? e.retryable : true, ...(e.details ? { details: e.details } : {}) } });
  }
}
function childContainer(id) {
  init(); const field=id.startsWith('task:')?'tasks':id.startsWith('project_note:')?'notes':id.startsWith('milestone:')?'milestones':null;
  return field?db.prepare("SELECT p.id project_id,j.value data FROM metis_projects p,json_each(p.data,'$."+field+"') j WHERE json_extract(j.value,'$.id')=? LIMIT 1").get(id):null;
}
function corpusSql(user) {
  init(); const account=Number(user), acl='atlas_readable_ref(p.id,'+account+')=1';
  let sql=` UNION ALL SELECT p.id,'project',json_extract(p.data,'$.title'),json_extract(p.data,'$.goal'),json_extract(p.data,'$.next_action'),p.revision,'project',json_extract(p.data,'$.state'),CAST(p.owner_account AS TEXT),p.updated_at,'${U().sql('/metis/projets/')}'||p.id,p.visibility FROM metis_projects p WHERE ${acl}`;
  for(const [field,kind] of [['tasks','task'],['notes','project_note'],['milestones','milestone']]) sql+=` UNION ALL SELECT json_extract(j.value,'$.id'),'${kind}',json_extract(j.value,'$.title'),coalesce(json_extract(j.value,'$.description'),json_extract(j.value,'$.body'),json_extract(j.value,'$.criteria'),''),j.value,coalesce(json_extract(j.value,'$.revision'),1),'${kind}',coalesce(json_extract(j.value,'$.state'),json_extract(j.value,'$.kind'),''),CAST(p.owner_account AS TEXT),coalesce(json_extract(j.value,'$.updated_at'),json_extract(j.value,'$.created_at'),p.updated_at),'${U().sql('/metis/projets/')}'||p.id,p.visibility FROM metis_projects p,json_each(p.data,'$.${field}') j WHERE ${acl}`;
  return sql;
}
module.exports = { enabled, init, rawReadable, summary, visible, get, today, plan, childContainer, corpusSql, PROJECT_STATES, TASK_STATES, PRIORITIES, NOTE_KINDS, NAMES, WRITES,
  CHIFFRE_ETATS, niveauChiffre, bilanChiffre, etapesChiffre, annoterRef, titreLisible, NOTE_HISTORIQUE,
  call: (name, args, user) => require('./metis-observability').observe(user, name, () => F.withScope(user, () => call(name, args, user))) };
