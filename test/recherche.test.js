'use strict';

// Le nœud recherche / collaboration / projets / développement / continuité tourne SANS
// Atlas : base en mémoire, comptes factices, adresse publique propre à l'instance, et un
// hôte qui ne fournit NI catalogue MCP NI rapport de qualification. Les adresses rendues
// doivent être celles de l'instance, jamais plagnito.com.
for (const f of ['RESEARCH', 'COLLAB', 'CONTEXT', 'AUDIT', 'SCIENCE', 'CONTINUITY']) process.env['METIS_' + f + '_ENABLED'] = '1';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const host = require('../lib/host');
const contexte = require('../lib/defaut/sqlite-context');

let n = 0, cle = 0;
const ok = (titre, fn) => { fn(); n++; console.log('  ✅ ' + titre); };

const db = new DatabaseSync(':memory:');
contexte.register(db);
const COMPTES = { 1: { id: 1, pseudo: 'proprio', active: 1 }, 2: { id: 2, pseudo: 'lectrice', active: 1 } };
const echapper = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
host.configure({
  db: () => ({ db }),
  sqliteContext: () => contexte,
  logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  comptes: () => ({
    compte: id => COMPTES[id] || null,
    estProprietaire: c => c.id === 1,
    compteParPseudo: p => Object.values(COMPTES).find(c => c.pseudo === p) || null,
  }),
  rendu: () => ({ rendre: t => ({ html: '<p>' + echapper(t) + '</p>', titres: [] }), ancre: t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-'), echapper }),
  publicUrl: 'https://metis.exemple.org',
});

const M = require('../lib/modules/metisdocs');
const J = require('../lib/modules/metis-research-journal');
const R = require('../lib/modules/metisresearch');
const C = require('../lib/modules/metiscollaboration');
const P = require('../lib/modules/metisprojects');
const D = require('../lib/modules/metisdevelopment');
const K = require('../lib/modules/metiscontinuity');
const PROPRIO = 1;

const donnees = r => { assert(r && r.ok, JSON.stringify(r && r.error)); return r.data; };
const appeler = (module, nom, args = {}, user = PROPRIO) => J.withIdentity(user, 'essai', () => module.call(nom, { max_tokens: 15000, ...args }, user));
const ecrire = (module, nom, args) => donnees(appeler(module, nom, { expected_revision: 0, idempotency_key: 'essai-' + (++cle), ...args }));

M.init();
M.accorder(PROPRIO, 'lectrice');

ok('un agent s’enregistre (collaboration)', () => {
  donnees(appeler(C, 'register_agent', { label: 'Agent d’essai', idempotency_key: 'agent-1' }));
});

let projet;
ok('le propriétaire crée un projet', () => {
  projet = ecrire(P, 'projets_creer', { title: 'Programme portable', goal: 'Reprendre le travail sans l’ancienne conversation' }).project;
  assert.match(projet.id, /^project:/);
});

ok('la recherche transversale retrouve le projet avec une adresse de l’instance', () => {
  const r = donnees(appeler(R, 'search_everything', { query: 'portable', kinds: ['project'] }));
  assert(r.results.length >= 1, JSON.stringify(r));
  const url = JSON.stringify(r.results);
  assert.match(url, /https:\/\/metis\.exemple\.org\/metis\/projets\//);
  assert.doesNotMatch(url, /plagnito\.com/);
});

ok('un document publié est retrouvé, son lien pointe vers l’instance', () => {
  const pub = M.publier(PROPRIO, { titre: 'Journal de bord', corps: '## Contexte\n\nUne note de recherche assez longue pour passer les contrôles.', categorie: 'Note' }, { auteur: 'proprio' });
  assert.equal(pub.ok, true, pub.error);
  const r = donnees(appeler(R, 'search_everything', { query: 'bord', kinds: ['document'] }));
  assert(r.results.length >= 1, JSON.stringify(r));
  assert.doesNotMatch(JSON.stringify(r), /plagnito\.com/);
});

ok('l’adaptateur OpenCode vise le MCP de l’instance', () => {
  const a = donnees(appeler(D, 'projets_adaptateur', { project_id: projet.id, harness: 'opencode' }));
  assert.equal(a.remote_configuration.mcp.servers.metis.url, 'https://metis.exemple.org/mcp');
  assert.match(a.bridge_url, /^https:\/\/metis\.exemple\.org\/metis\/projets\//);
  assert.match(a.bridge_sha256, /^[a-f0-9]{64}$/);
  assert(a.setup_commands.every(c => !c.includes('plagnito')));
});

ok('sans catalogue MCP ni rapport de l’hôte, les diagnostics répondent quand même', () => {
  const d = donnees(appeler(K, 'mcp_diagnostics', { limit: 50 }));
  assert.deepEqual(d.items, []);
  assert.equal(d.selftest.status, 'unavailable');
});

ok('une lectrice ne voit pas le projet privé du propriétaire', () => {
  const r = donnees(appeler(R, 'search_everything', { query: 'portable', kinds: ['project'] }, 2));
  assert.equal(r.results.length, 0);
});

console.log(`recherche : ${n} vérifications`);
