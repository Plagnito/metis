'use strict';

// Transactional outbox in Atlas' existing database. Never stores document bodies.
const crypto = require('node:crypto');
const { register, withIdentity, bindWriters } = require('../core/sqlite-context');
const installed = new WeakMap();
const sources = [
  ['metis_projects', 'project', 'r.id', 'revision', 'visibility'],
  ['metis_development_objects', 'project', 'r.id', 'revision', 'visibility', 'r.project_id'],
  ['metis_command_records', 'command', 'r.id', 'revision'],
  ['metis_docs', 'document', "'document:' || r.slug", 'version', 'statut'],
  ['metis_glossaire', 'fiche', "'sigle:' || r.sigle", 'version'],
  ['metis_architecture', 'architecture', 'r.id', 'version'],
  ['metis_experts', 'expert', "'expert:' || r.id", 'revision'],
  ['metis_pools', 'pool', "'pool:' || r.id"],
  ['metis_competences', 'competence', "'competence:' || r.id"],
  ['metis_benchmarks', 'benchmark', "'benchmark:' || r.id"],
  ['metis_notes', 'note', "'note:' || r.id", null, null, "'document:' || (SELECT slug FROM metis_docs WHERE id=r.doc)"],
  ['metis_expert_mesures', 'metric', "'measure:' || r.id", null, null, "'expert:' || r.expert"],
  ['metis_expert_competences', 'competence', "'expert:' || r.expert", null, null, "'expert:' || r.expert"],
  ['metis_expert_relations', 'architecture', "'relation:' || r.de || ':' || r.type || ':' || r.vers", null, null, "'expert:' || r.de"],
  ['metis_research_agents', 'agent', 'r.id', 'revision'],
  ['metis_work_items', 'work', 'r.id', 'revision'],
  ['metis_handoffs', 'handoff', 'r.id', 'revision'],
  ['metis_reviews', 'review', 'r.id', 'revision'],
  ['metis_science_objects', 'science', 'r.id', 'revision'],
  ['metis_continuity_objects', 'continuity', 'r.id', 'revision'],
  ['metis_nexus_channels', 'nexus', 'r.id', 'revision', 'visibility'],
  ['metis_nexus_threads', 'nexus', 'r.id', 'revision'],
  ['metis_nexus_messages', 'nexus', 'r.id', 'revision'],
  ['metis_nexus_receipts', 'nexus', 'r.id', 'revision', null, 'r.message_id'],
  ['metis_nexus_connections', 'nexus', 'r.id', 'revision'],
  ['metis_nexus_deliveries', 'nexus', 'r.id', 'revision'],
  ['metis_nexus_usage', 'nexus', 'r.id', 'revision'],
  ['metis_nexus_usage_notes', 'nexus', 'r.id', null, null, 'r.usage_id'],
];
function install(db) {
  register(db);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const pending = sources.filter(([table]) => tables.has(table) && !installed.get(db)?.has(table));
  if (installed.has(db) && !pending.length) return;
  db.exec('SAVEPOINT metis_journal_migration');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS metis_research_contract (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, epoch TEXT NOT NULL, secret TEXT NOT NULL, installed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metis_research_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL,
      resource_id TEXT NOT NULL, revision_before INTEGER, revision_after INTEGER, visibility TEXT,
      actor_id TEXT, client_id TEXT, occurred_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_metis_research_events_domain ON metis_research_events(domain,seq);
      CREATE INDEX IF NOT EXISTS idx_metis_research_events_resource ON metis_research_events(resource_id,seq);
      CREATE TRIGGER IF NOT EXISTS metis_events_immutable_update BEFORE UPDATE ON metis_research_events
      BEGIN SELECT RAISE(ABORT,'Immutable research event'); END;
      CREATE TRIGGER IF NOT EXISTS metis_events_immutable_delete BEFORE DELETE ON metis_research_events
      BEGIN SELECT RAISE(ABORT,'Immutable research event'); END;
      CREATE TABLE IF NOT EXISTS metis_research_policy(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO metis_research_policy VALUES(1,0);
      CREATE TABLE IF NOT EXISTS metis_context_manifests(id TEXT PRIMARY KEY,account INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_context_expiry ON metis_context_manifests(account,expires);`);
    const created = db.prepare('INSERT OR IGNORE INTO metis_research_contract VALUES(1,1,?,?,?)')
      .run(crypto.randomUUID(), crypto.randomBytes(32).toString('hex'), new Date().toISOString()).changes;
    for (const [table, domain, id, revision, visibility, resource] of pending) {
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = op === 'DELETE' ? 'OLD' : 'NEW', value = expr => expr.replaceAll('r.', row + '.');
        const before = revision && op !== 'INSERT' ? 'OLD.' + revision : 'NULL';
        const after = revision && op !== 'DELETE' ? 'NEW.' + revision : 'NULL';
        // Repeated no-op SQL updates do not create fake changes.
        const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
        const when = op === 'UPDATE' ? 'WHEN ' + cols.map(c => 'OLD.' + c + ' IS NOT NEW.' + c).join(' OR ') : '';
        const eventDomain=['metis_science_objects','metis_continuity_objects'].includes(table)?row+'.kind':"'"+domain+"'";
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_research_${op.toLowerCase()} AFTER ${op} ON ${table} ${when}
          BEGIN INSERT INTO metis_research_events(domain,kind,object_id,resource_id,revision_before,revision_after,visibility,actor_id,client_id,occurred_at)
          VALUES(${eventDomain},${eventDomain}||'.${op.toLowerCase()}',${value(id)},${value(resource || id)},${before},${after},${visibility ? row + '.' + visibility : 'NULL'},atlas_actor_id(),atlas_client_id(),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_policy_${op.toLowerCase()} AFTER ${op} ON ${table} ${when} BEGIN UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;`);
      }
    }
    if(tables.has('metis_acces'))for(const op of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS metis_acces_policy_${op.toLowerCase()} AFTER ${op} ON metis_acces BEGIN UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;`);
    if(tables.has('player_accounts'))for(const op of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS player_accounts_metis_policy_${op.toLowerCase()} AFTER ${op} ON player_accounts ${op==='UPDATE'?'WHEN OLD.active IS NOT NEW.active OR OLD.pseudo IS NOT NEW.pseudo':''} BEGIN UPDATE metis_research_policy SET generation=generation+1 WHERE id=1; END;`);
    if (created) db.prepare(`INSERT INTO metis_research_events(domain,kind,object_id,resource_id,occurred_at)
      VALUES('contract','contract.installed','contract:research-v1','contract:research-v1',?)`).run(new Date().toISOString());
    db.exec('RELEASE metis_journal_migration');
    const known = installed.get(db) || new Set();
    for (const [table] of pending) known.add(table);
    installed.set(db, known);
  } catch (e) { db.exec('ROLLBACK TO metis_journal_migration; RELEASE metis_journal_migration'); throw e; }
}
module.exports = { register, install, withIdentity, bindWriters, invalidate: db => installed.delete(db) };
