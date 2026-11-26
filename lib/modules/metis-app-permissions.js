'use strict';
// A narrowing layer over OAuth and the existing ACLs. No MCP tool can edit it.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { db } = require('../core/db');
const local = new AsyncLocalStorage();
let installed = false;
const scopedTools = new Set(['search_everything', 'context_pack', 'validate_context_pack', 'read_passage', 'read_bundle', 'projets_lire', 'projets_ouvrir', 'projets_contexte']);
const baseline = () => ({ enabled: true, tools: null, resources: null, arguments: {}, max_response_bytes: null, resources_enabled: true, prompts_enabled: true, expires_at: null, harness: null });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function assert(test, message) { if (!test) fail('INVALID_POLICY', message); }
function init() {
  if (installed) return;
  require('./metis-research-journal').install(db);
  db.exec(`CREATE TABLE IF NOT EXISTS metis_app_policies (
    account INTEGER NOT NULL, client TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(account,client));
    CREATE TABLE IF NOT EXISTS metis_app_policy_history (
    account INTEGER NOT NULL, client TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY(account,client,revision), UNIQUE(account,request_key));
    CREATE TRIGGER IF NOT EXISTS metis_app_policy_insert AFTER INSERT ON metis_app_policies BEGIN
      UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS metis_app_policy_update AFTER UPDATE ON metis_app_policies BEGIN
      UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS metis_app_history_update BEFORE UPDATE ON metis_app_policy_history BEGIN
      SELECT RAISE(ABORT,'Immutable app policy history'); END;
    CREATE TRIGGER IF NOT EXISTS metis_app_history_delete BEFORE DELETE ON metis_app_policy_history BEGIN
      SELECT RAISE(ABORT,'Immutable app policy history'); END;`);
  installed = true;
}
function validate(input, names) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Politique objet requise.');
  assert(Buffer.byteLength(JSON.stringify(input)) <= 24000, 'Politique trop volumineuse.');
  const p = { ...baseline(), ...input };
  assert(Object.keys(p).every(k => Object.hasOwn(baseline(), k)), 'Paramètre inconnu.');
  for (const k of ['enabled', 'resources_enabled', 'prompts_enabled']) assert(typeof p[k] === 'boolean', k + ' doit être booléen.');
  for (const k of ['tools', 'resources']) assert(p[k] === null || Array.isArray(p[k]) && p[k].length <= 500 && new Set(p[k]).size === p[k].length && p[k].every(x => typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[\x00-\x1f]/.test(x)), 'Liste invalide : ' + k);
  if (names && p.tools) assert(p.tools.every(x => names.has(x)), 'Outil absent du catalogue actuel.');
  if (p.resources) assert(p.resources.every(x => /^[a-z_]+:[^*?]+$/.test(x)), 'Identifiants de ressources exacts requis.');
  assert(p.max_response_bytes === null || Number.isSafeInteger(p.max_response_bytes) && p.max_response_bytes >= 512 && p.max_response_bytes <= 1000000, 'Budget entre 512 et 1 000 000 octets.');
  assert(p.expires_at === null || typeof p.expires_at === 'string' && Number.isFinite(Date.parse(p.expires_at)), 'Expiration ISO requise.');
  assert(p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) && Object.keys(p.arguments).length <= 100, 'Règles d’arguments invalides.');
  for (const [tool, fields] of Object.entries(p.arguments)) {
    assert(!names || names.has(tool), 'Outil inconnu : ' + tool);
    assert(fields && typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length <= 20, 'Champs invalides.');
    for (const [field, r] of Object.entries(fields)) {
      assert(/^[a-zA-Z][\w]{0,79}$/.test(field) && r && typeof r === 'object' && !Array.isArray(r), 'Règle de champ invalide.');
      assert(Object.keys(r).every(k => ['values', 'min', 'max', 'required'].includes(k)), 'Opérateur inconnu.');
      assert(r.required === undefined || typeof r.required === 'boolean', 'required doit être booléen.');
      assert(r.values === undefined || Array.isArray(r.values) && r.values.length <= 100 && r.values.every(v => v === null || ['string', 'boolean', 'number'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))), 'Valeurs scalaires requises.');
      for (const k of ['min', 'max']) assert(r[k] === undefined || Number.isFinite(r[k]), 'Borne numérique requise.');
      assert(r.min === undefined || r.max === undefined || r.min <= r.max, 'Bornes inversées.');
    }
  }
  if (p.harness !== null) require('../../tools/metis-harness/permissions.cjs').validate(p.harness);
  return JSON.parse(JSON.stringify(p));
}
function hasTable(name) { return !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name); }
function clients(account) {
  init(); const found = new Map();
  if (hasTable('sso_grants')) for (const r of db.prepare('SELECT DISTINCT client_id FROM sso_grants WHERE account_id=? AND exp>? AND kind IN (\'access\',\'refresh\')').all(account, Date.now())) if (r.client_id) found.set(r.client_id, { client: r.client_id, label: r.client_id });
  if (hasTable('metis_research_agents')) for (const r of db.prepare('SELECT client,label FROM metis_research_agents WHERE account=?').all(account)) found.set(r.client, { client: r.client, label: r.label });
  for (const r of db.prepare('SELECT client FROM metis_app_policies WHERE account=? AND client!=?').all(account, '*')) if (!found.has(r.client)) found.set(r.client, { client: r.client, label: r.client });
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function get(account, client) {
  init(); const row = db.prepare('SELECT * FROM metis_app_policies WHERE account=? AND client=?').get(account, client);
  return row ? { revision: row.revision, policy: JSON.parse(row.data), updated_at: row.updated_at } : { revision: 0, policy: baseline(), updated_at: null };
}
function history(account, client) { init(); return db.prepare('SELECT revision,data,updated_at FROM metis_app_policy_history WHERE account=? AND client=? ORDER BY revision DESC LIMIT 30').all(account, client).map(r => ({ revision: r.revision, policy: JSON.parse(r.data), updated_at: r.updated_at })); }
function save(account, client, input, revision, key, names) {
  init(); assert(Number.isSafeInteger(revision) && revision >= 0 && typeof key === 'string' && /^[\w-]{8,100}$/.test(key), 'Révision et clé de requête requises.');
  if (client !== '*' && !clients(account).some(c => c.client === client)) fail('NOT_FOUND', 'App inconnue pour ce compte.');
  const policy = validate(input, names), data = JSON.stringify(policy), hash = crypto.createHash('sha256').update(JSON.stringify([client, revision, policy])).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM metis_app_policy_history WHERE account=? AND request_key=?').get(account, key);
    if (previous) { if (previous.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'Clé déjà utilisée.'); db.exec('COMMIT'); return { revision: previous.revision, policy: JSON.parse(previous.data), updated_at: previous.updated_at }; }
    if (get(account, client).revision !== revision) fail('REVISION_CONFLICT', 'Configuration modifiée ailleurs ; recharger avant de sauvegarder.');
    const time = new Date().toISOString(), next = revision + 1;
    db.prepare('INSERT INTO metis_app_policies VALUES(?,?,?,?,?) ON CONFLICT(account,client) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(account, client, next, data, time);
    db.prepare('INSERT INTO metis_app_policy_history VALUES(?,?,?,?,?,?,?)').run(account, client, next, data, time, key, hash);
    db.exec('COMMIT'); return { revision: next, policy, updated_at: time };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function activePolicies() { const s = local.getStore(); return s ? ['*', ...(s.client === '*' ? [] : [s.client])].map(c => get(s.account, c).policy) : []; }
function hasResourceScope() { return activePolicies().some(p=>p.resources!==null); }
function live(p) { return p.enabled && (!p.expires_at || Date.parse(p.expires_at) > Date.now()); }
function permittedTool(p, name) { return live(p) && (p.tools === null || p.tools.includes(name)) && (p.resources === null || scopedTools.has(name)); }
function filterTools(list) { const ps = activePolicies(); return list.filter(t => ps.every(p => permittedTool(p, t.name))); }
function checkCall(name, args) {
  for (const p of activePolicies()) {
    if (!permittedTool(p, name)) fail('APP_PERMISSION_DENIED', 'Cet outil est désactivé pour cette app.');
    for (const [field, r] of Object.entries(p.arguments[name] || {})) {
      if (!Object.hasOwn(args, field)) { if (r.required || r.values || r.min !== undefined || r.max !== undefined) fail('APP_PERMISSION_DENIED', 'Argument requis par la politique : ' + field); continue; }
      const v = args[field];
      if (r.values && !r.values.includes(v) || r.min !== undefined && (typeof v !== 'number' || v < r.min) || r.max !== undefined && (typeof v !== 'number' || v > r.max)) fail('APP_PERMISSION_DENIED', 'Argument hors du périmètre autorisé : ' + field);
    }
  }
}
function canRead(account, id) {
  const s = local.getStore(); if (!s || s.account !== Number(account)) return true;
  return activePolicies().every(p => {
    if (!live(p)) return false;
    if (p.resources === null || p.resources.includes(id)) return true;
    let parent;
    if (/^(task|project_note|milestone):/.test(id)) parent = require('./metisprojects').childContainer(id)?.project_id;
    else if (/^project_(context|checkpoint|evidence|document|session):/.test(id)) parent = db.prepare('SELECT project_id FROM metis_development_objects WHERE id=?').get(id)?.project_id;
    else if (id.startsWith('architecture:document:')) parent = id.slice(13);
    else if (id.startsWith('note:')) { const r = db.prepare('SELECT d.slug FROM metis_notes n JOIN metis_docs d ON n.doc=d.id WHERE n.id=?').get(id.slice(5)); parent = r && 'document:' + r.slug; }
    return !!parent && p.resources.includes(parent);
  });
}
function checkMethod(method) {
  for (const p of activePolicies()) {
    if (!live(p)) fail('APP_PERMISSION_DENIED', 'App suspendue ou autorisation expirée.');
    // These surfaces have independent data delivery paths; source-limited clients use audited tools.
    if (method.startsWith('resources/') && (!p.resources_enabled || p.resources !== null) || method.startsWith('prompts/') && (!p.prompts_enabled || p.resources !== null)) fail('APP_PERMISSION_DENIED', 'Surface MCP désactivée pour cette app.');
  }
}
function withClient(account, client, fn) { init(); return local.run({ account: Number(account), client }, fn); }
function snapshot() { const s = local.getStore(); return s ? JSON.stringify(['*', s.client].map(c => get(s.account, c).revision)) : null; }
function delivery(result, method, stamp) {
  checkMethod(method);
  if (snapshot() !== stamp) fail('APP_PERMISSION_CHANGED', 'Permissions modifiées pendant la requête ; relire avant de réessayer.');
  const limits = activePolicies().map(p => p.max_response_bytes).filter(x => x !== null);
  if (limits.length && Buffer.byteLength(JSON.stringify(result)) > Math.min(...limits)) fail('APP_RESPONSE_LIMIT', 'Réponse au-delà du budget de cette app ; réduire la sélection.');
  return result;
}
function error(e) { const known=['APP_PERMISSION_DENIED','APP_PERMISSION_CHANGED','APP_RESPONSE_LIMIT','PERMISSION_DENIED'].includes(e.code); const out = require('./metis-recovery').normalize({ ok: false, error: { code: known ? e.code : 'APP_PERMISSION_UNAVAILABLE', message: known ? e.message : 'Contrôle des permissions indisponible.', retryable: false } }); return { isError: true, content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }; }
module.exports = { baseline, init, validate, clients, get, save, history, withClient, filterTools, checkCall, checkMethod, canRead, snapshot, delivery, error, scopedTools, hasResourceScope };
