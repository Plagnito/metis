'use strict';

// Le NOYAU MCP tourne sans Atlas : catalogue selon le rôle, aiguillage d'un appel,
// consignes à l'initialisation, et une extension d'hôte branchée comme le sont, dans
// Atlas, le Security Center et les pages web. Aucune adresse de plagnito.com ne sort.
for (const f of ['RESEARCH', 'COLLAB', 'CONTEXT', 'AUDIT', 'SCIENCE', 'CONTINUITY']) process.env['METIS_' + f + '_ENABLED'] = '1';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const host = require('../lib/host');
const contexte = require('../lib/defaut/sqlite-context');

let n = 0;
const ok = (titre, fn) => { fn(); n++; console.log('  ✅ ' + titre); };

const db = new DatabaseSync(':memory:');
contexte.register(db);
const COMPTES = { 1: { id: 1, pseudo: 'proprio', active: 1 }, 2: { id: 2, pseudo: 'lectrice', active: 1 } };
const echapper = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const appelsExtension = [];
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
  // Une extension réservée au propriétaire, hors du catalogue commun (comme le Security Center).
  extensions: () => [{
    catalogue: false,
    noms: new Set(['meteo_locale']),
    outils: (ecrivain, moi) => (Number(moi) === 1 ? [{ name: 'meteo_locale', title: 'Météo', description: 'Essai.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] : []),
    appeler: (nom, a, moi) => (nom === 'meteo_locale' ? (appelsExtension.push(moi), { content: [{ type: 'text', text: 'beau' }] }) : null),
    consignes: moi => (Number(moi) === 1 ? ' Météo locale : meteo_locale.' : ''),
  }],
});

const M = require('../lib/modules/metisdocs');
const J = require('../lib/modules/metis-research-journal');
const MCP = require('../lib/web/metis-mcp');
M.init();
M.accorder(1, 'lectrice');
const appeler = (nom, a, moi) => J.withIdentity(moi, 'essai', () => MCP.appeler(nom, a, moi, { auteur: MCP.auteurDe(moi) }));

ok('le propriétaire voit les outils d’écriture, la lectrice seulement la lecture', () => {
  const p = MCP.catalogueDe(1).map(t => t.name), l = MCP.catalogueDe(2).map(t => t.name);
  for (const nom of ['publier_document', 'carnet_ajouter', 'projets_creer']) { assert(p.includes(nom), nom); assert(!l.includes(nom), nom); }
  for (const nom of ['search', 'fetch', 'carnet_lister', 'search_everything']) assert(l.includes(nom), nom);
});

ok('une extension réservée apparaît pour le propriétaire seulement, et reste connue', () => {
  assert(MCP.catalogueDe(1).some(t => t.name === 'meteo_locale'));
  assert(!MCP.catalogueDe(2).some(t => t.name === 'meteo_locale'));
  assert(!MCP.outils(true).some(t => t.name === 'meteo_locale'));
  assert(MCP.nomsConnus().has('meteo_locale'));
  assert.equal(appeler('meteo_locale', {}, 1).content[0].text, 'beau');
  assert.deepEqual(appelsExtension, [1]);
});

ok('les consignes viennent de l’instance et intègrent celles de l’extension', () => {
  const p = MCP.instructions(1), l = MCP.instructions(2);
  assert(p.startsWith('Sans consigne de travail : carnet_lister'));
  assert(p.includes('https://metis.exemple.org/metis/glossaire/<sigle>'));
  assert(p.includes('Météo locale'));
  assert(!l.includes('Météo locale'));
  assert.doesNotMatch(p + l, /plagnito/);
});

ok('un appel est aiguillé vers son module ; les liens pointent vers l’instance', () => {
  const r = appeler('carnet_ajouter', { titre: 'Arroser les plantes', type: 'maintenance' }, 1);
  assert.notEqual(r.isError, true, JSON.stringify(r));
  const l = appeler('carnet_lister', {}, 1).structuredContent;
  assert.equal(l.lien, 'https://metis.exemple.org/metis/carnet');
  assert(l.taches.some(t => t.titre === 'Arroser les plantes'));
});

ok('une écriture de la lectrice est refusée, signée de son pseudo sinon', () => {
  const r = appeler('carnet_ajouter', { titre: 'Intrusion', type: 'maintenance' }, 2);
  assert.equal(r.isError, true);
  assert.equal(MCP.auteurDe(2), 'lectrice (connecteur)');
  assert.equal(MCP.auteurDe(1), 'ChatGPT');
});

ok('un outil inconnu est refusé proprement', () => {
  const r = appeler('outil_imaginaire', {}, 1);
  assert.equal(r.isError, true);
});

console.log(`mcp : ${n} vérifications`);
