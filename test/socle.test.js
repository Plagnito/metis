'use strict';

// Le socle (documents, carnet, architecture) tourne SANS Atlas : base en mémoire,
// comptes factices fournis par l'hôte, adresse publique propre à l'instance,
// aucune graine. Rien de propre à plagnito.com ne doit en sortir.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const host = require('../lib/host');
const contexte = require('../lib/defaut/sqlite-context');

let n = 0;
const ok = (titre, fn) => { fn(); n++; console.log('  ✅ ' + titre); };

const db = new DatabaseSync(':memory:');
contexte.register(db);
const COMPTES = {
  1: { id: 1, pseudo: 'proprio', active: 1 },
  2: { id: 2, pseudo: 'invitee', active: 1 },
};
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
  rendu: () => ({
    rendre: t => ({ html: '<p>' + echapper(t) + '</p>', titres: [] }),
    ancre: t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    echapper,
  }),
  depotsConnus: ['mon-projet'],
  publicUrl: 'https://metis.exemple.org',
});

const M = require('../lib/modules/metisdocs');
const C = require('../lib/modules/metiscarnet');
const A = require('../lib/modules/metisarchitecture');

ok('le propriétaire est reconnu par l’hôte, pas par un pseudo câblé', () => {
  assert.equal(M.estMaster(1), true);
  assert.equal(M.estMaster(2), false);
  assert.equal(M.peutLire(2), false);
});

ok('une instance sans graines démarre vide', () => {
  M.init();
  assert.equal(db.prepare('SELECT count(*) n FROM metis_docs').get().n, 0);
});

let doc;
ok('le propriétaire publie ; l’adresse est celle de l’instance', () => {
  const r = M.publier(1, { titre: 'Premier essai', corps: '## Contexte\n\nUn texte assez long pour passer les contrôles de longueur.', categorie: 'Note' }, { auteur: 'proprio' });
  assert.equal(r.ok, true, r.error);
  doc = r.document;
  assert.match(doc.url, /^https:\/\/metis\.exemple\.org\/metis\//);
});

ok('un autre compte ne publie pas sans droit d’écriture', () => {
  const r = M.publier(2, { titre: 'Intrus', corps: 'Un texte assez long pour passer les contrôles de longueur.' });
  assert.equal(r.ok, false);
});

ok('accorder la lecture par pseudo passe par les comptes de l’hôte', () => {
  const r = M.accorder(1, 'invitee');
  assert.notEqual(r && r.ok, false, JSON.stringify(r));
  assert.equal(M.peutLire(2), true);
});

ok('le carnet propose les dépôts de l’instance et lie vers elle', () => {
  assert.deepEqual([...C.DEPOTS_CONNUS], ['mon-projet']);
  const t = C.ajouter(1, { titre: 'Relire le plan', type: 'documentation' });
  assert.match(t.lien, /^https:\/\/metis\.exemple\.org\/metis\/carnet#tache-/);
  assert.equal(t.cree_par_nom ?? t.creeParNom ?? 'proprio', 'proprio');
});

ok('le registre des experts démarre vide sans graines', () => {
  const E = require('../lib/modules/metisexperts');
  E.init();
  assert.equal(db.prepare('SELECT count(*) n FROM metis_experts').get().n, 0);
});

ok('le registre d’architecture voit le document avec l’adresse de l’instance', () => {
  A.init();
  const vue = A.snapshot(1);
  const texte = JSON.stringify(vue);
  assert.ok(texte.includes('https://metis.exemple.org/metis/' + doc.slug), 'adresse du document');
  assert.ok(!texte.includes('plagnito.com'), 'aucune adresse de plagnito.com');
});

console.log(`socle : ${n} vérifications réussies`);
