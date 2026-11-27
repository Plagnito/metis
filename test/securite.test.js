'use strict';

// Le Security Center tourne SANS Atlas et sans aucun inventaire livré : l'instance déclare
// ses comptes GitHub, ses dépôts entrent par déclaration, rien de Plagni/Plagnito n'existe.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const host = require('../lib/host');
const contexte = require('../lib/defaut/sqlite-context');

let n = 0;
const ok = async (titre, fn) => { await fn(); n++; console.log('  ✅ ' + titre); };

const db = new DatabaseSync(':memory:');
contexte.register(db);
const COMPTES = { 1: { id: 1, pseudo: 'proprio', active: 1 }, 2: { id: 2, pseudo: 'lectrice', active: 1 } };
host.configure({
  db: () => ({ db }),
  sqliteContext: () => contexte,
  logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  comptes: () => ({
    compte: id => COMPTES[id] || null,
    estProprietaire: c => c.id === 1,
    compteParPseudo: p => Object.values(COMPTES).find(c => c.pseudo === p) || null,
  }),
  rendu: () => ({ rendre: t => ({ html: '<p>' + t + '</p>', titres: [] }), ancre: t => t, echapper: t => t }),
  publicUrl: 'https://metis.exemple.org',
  securite: { proprietaires: ['mon-equipe'], jeton: () => '' },
});

const M = require('../lib/modules/metisdocs');
const S = require('../lib/modules/metis-securite');
const T = require('../lib/web/metis-securite-tools');
const R = require('../lib/modules/metis-securite-report');
M.init();
M.accorder(1, 'lectrice');
const texte = r => r.structuredContent || JSON.parse(r.content[0].text);

(async () => {
  await ok('une instance neuve démarre sans aucun dépôt', () => {
    S.init();
    assert.equal(S.etatDepots().length, 0);
  });

  await ok('les dépôts entrent par déclaration, pour les comptes de l’instance seulement', () => {
    assert.equal(S.declarerDepots(1, { depots: [{ nom_complet: 'mon-equipe/site', public: true }] }).ok, true);
    assert.throws(() => S.declarerDepots(1, { depots: [{ nom_complet: 'Plagni/atlas' }] }), /mon-equipe\/<dépôt>/);
    const d = S.etatDepots();
    assert.deepEqual(d.map(x => x.nom_complet), ['mon-equipe/site']);
    assert.equal(d[0].famille, 'apps');
    assert.equal(d[0].importance.niveau, 'actif');
  });

  await ok('les outils sont réservés au propriétaire ; les textes ne citent que les comptes de l’instance', () => {
    assert(T.tools(1).length > 10);
    assert.equal(T.tools(2).length, 0);
    const refus = texte(T.call('securite_etat', {}, 2));
    assert.equal(refus.error.code, 'PERMISSION_DENIED');
    assert.doesNotMatch(JSON.stringify(T.tools(1)), /Plagni|plagnito/);
    assert.match(JSON.stringify(T.tools(1)), /mon-equipe/);
  });

  await ok('l’état du jour se lit par l’outil MCP', () => {
    const e = texte(T.call('securite_etat', {}, 1));
    assert.equal(e.ok, true, JSON.stringify(e));
    assert.equal(e.resume.depots, 1);
  });

  await ok('sans jeton, la synchronisation dit qu’elle est partielle au lieu d’inventer', async () => {
    const appels = [];
    const r = await S.synchroniserDepots({ fetchImpl: async (url) => { appels.push(url); return { ok: true, json: async () => [] }; } });
    assert.equal(r.ok, false);
    assert.match(r.message, /aucun jeton/);
    assert(appels.every(u => u.startsWith('https://api.github.com/users/mon-equipe/repos')), appels.join(' '));
  });

  await ok('sans registre d’exécutions fourni par l’hôte, un rapport exigé est refusé', () => {
    assert.throws(() => R.assertForPlanning(1, { id: 'command:00000000-0000-0000-0000-000000000000', revision: 1 }), e => e.code === 'FAILED_PRECONDITION');
  });

  console.log(`securite : ${n} vérifications`);
})().catch(e => { console.error(e); process.exitCode = 1; });
