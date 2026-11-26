'use strict';

// L'hôte : configuration unique, résolution paresseuse, erreurs qui disent quoi faire,
// et un module qui touche la base fonctionne sur une base SQLite en mémoire.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const host = require('../lib/host');

let n = 0;
const ok = (titre, fn) => { fn(); n++; console.log('  ✅ ' + titre); };

ok('une façade lue avant configure() échoue en le disant', () => {
  assert.throws(() => require('../lib/core/db').db, /non configuré/);
});

ok('un hôte incomplet est refusé et nomme l’entrée manquante', () => {
  assert.throws(() => host.configure({ db: () => ({}), logger: () => ({}) }), /sqliteContext/);
  assert.equal(host.configured(), false);
});

ok('une adresse publique avec paramètres est refusée', () => {
  const ctx = require('../lib/defaut/sqlite-context');
  assert.throws(() => host.configure({ db: () => ({}), sqliteContext: () => ctx, logger: () => console, publicUrl: 'https://exemple.org/?x=1' }), /publicUrl/);
});

ok('une liste de dépôts invalide est refusée', () => {
  const ctx = require('../lib/defaut/sqlite-context');
  assert.throws(() => host.configure({ db: () => ({}), sqliteContext: () => ctx, logger: () => console, depotsConnus: 'atlas' }), /depotsConnus/);
  assert.equal(host.configured(), false);
});

let ouvertures = 0;
const memoire = new DatabaseSync(':memory:');
const contexte = require('../lib/defaut/sqlite-context');
contexte.register(memoire);
host.configure({
  db: () => { ouvertures++; return { db: memoire }; },
  sqliteContext: () => contexte,
  logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  publicUrl: 'https://metis.exemple.org/',
});

ok('charger un module pur n’ouvre pas la base', () => {
  require('../lib/modules/graphiques');
  require('../lib/modules/metis-observability');
  assert.equal(ouvertures, 0);
});

ok('la base n’est résolue qu’une fois, au premier usage', () => {
  const { db } = require('../lib/core/db');
  assert.equal(db, memoire);
  assert.equal(require('../lib/core/db').db, memoire);
  assert.equal(ouvertures, 1);
});

ok('une seconde configuration est refusée', () => {
  assert.throws(() => host.configure({ db: () => ({}), sqliteContext: () => contexte, logger: () => console }), /déjà configuré/);
});

ok('une entrée facultative absente échoue en le disant', () => {
  assert.throws(() => require('../lib/core/comptes').compte(1), /ne fournit pas « comptes »/);
  assert.equal(host.graines(), null);
  assert.deepEqual([...host.depotsConnus()], []);
});

ok('publicUrl est rendue sans « / » final', () => {
  assert.equal(host.publicUrl(), 'https://metis.exemple.org');
});

ok('le journal de recherche s’installe et trace l’acteur via le contexte de l’hôte', () => {
  const J = require('../lib/modules/metis-research-journal');
  memoire.exec('CREATE TABLE metis_projects (id TEXT PRIMARY KEY, revision INTEGER, visibility TEXT, titre TEXT)');
  J.install(memoire);
  contexte.withIdentity(7, 'essai', () => memoire.prepare("INSERT INTO metis_projects VALUES('p1',1,'private','x')").run());
  const ev = memoire.prepare("SELECT kind, actor_id, client_id FROM metis_research_events WHERE domain='project'").get();
  assert.deepEqual({ ...ev }, { kind: 'project.insert', actor_id: 'atlas:7', client_id: 'essai' });
});

ok('les modules du premier lot se chargent et exposent leur API', () => {
  const attendu = {
    'metis-recovery': ['decorate', 'normalize', 'toolResult', 'outputSchema'],
    'metis-idempotency': ['fingerprint', 'matches', 'upgrade'],
    'metis-outcome-code': ['normalize', 'fromResponse', 'category', 'categorySql', 'known'],
    'metis-doctor': ['observation', 'quantiles', 'report'],
    'metis-observability': ['observe', 'metrics', 'recentErrors', 'slowTools', 'started'],
  };
  for (const [nom, cles] of Object.entries(attendu)) {
    const m = require('../lib/modules/' + nom);
    for (const c of cles) assert.ok(c in m, `${nom}.${c}`);
  }
});

ok('fournit() dit si une entrée facultative est là, sans la résoudre', () => {
  assert.equal(host.fournit('mcp'), false);
  assert.equal(host.fournit('selftest'), false);
  assert.equal(host.fournit('db'), true);
  assert.throws(() => host.fournit('inventee'), /inconnue/);
});

console.log(`host : ${n} vérifications réussies`);
