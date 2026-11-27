'use strict';

// L'hôte par défaut (instance locale en mémoire) : comptes, jetons, rendu Markdown embarqué,
// et une publication complète qui passe par lui.
for (const f of ['RESEARCH', 'COLLAB', 'SCIENCE', 'CONTINUITY']) process.env['METIS_' + f + '_ENABLED'] = '1';
const assert = require('node:assert/strict');
const { ouvrir } = require('../lib/defaut/instance');
const md = require('../lib/defaut/markdown');

let n = 0;
const ok = (titre, fn) => { fn(); n++; console.log('  ✅ ' + titre); };

const inst = ouvrir({ memoire: true, publicUrl: 'http://127.0.0.1:4747' });
const proprio = inst.creerCompte('proprio', 'proprietaire');
const membre = inst.creerCompte('lea');

ok('comptes : un propriétaire, un membre, pseudos refusés s’ils sont invalides', () => {
  assert.equal(inst.comptes.estProprietaire(proprio), true);
  assert.equal(inst.comptes.estProprietaire(membre), false);
  assert.equal(inst.comptes.compteParPseudo('LEA').id, membre.id);
  assert.throws(() => inst.creerCompte('x'), /Pseudo/);
  assert.throws(() => inst.creerCompte('lea'), /UNIQUE/);
});

ok('jetons : seule l’empreinte est gardée ; révoquer coupe l’accès', () => {
  const j = inst.creerJeton(proprio.id, 'claude-code');
  assert.deepEqual(inst.verifierJeton(j), { compte: proprio.id, client: 'claude-code' });
  assert.equal(inst.db.prepare('SELECT count(*) n FROM metis_jetons WHERE empreinte = ?').get(j).n, 0);
  assert.equal(inst.verifierJeton(j.slice(0, -1) + (j.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(inst.revoquerJeton(inst.jetons()[0].id), true);
  assert.equal(inst.verifierJeton(j), null);
  assert.throws(() => inst.creerJeton(proprio.id, 'Avec Espace'), /Client/);
});

ok('rendu : titres ancrés, tableaux, code échappé', () => {
  const r = md.rendre('## Contexte\n\nDu `<div>` et **gras**.\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(r.html, /<h2 id="contexte">/);
  assert.match(r.html, /<code>&lt;div&gt;<\/code>/);
  assert.match(r.html, /<table>/);
  assert.deepEqual(r.sommaire.map((s) => s.ancre), ['contexte']);
});

ok('rendu : image distante refusée, image de l’instance acceptée, lien javascript neutralisé', () => {
  assert.match(md.enLigne('![espion](https://tiers.example/p.gif)'), /source distante refusée/);
  assert.match(md.enLigne('![schéma](http://127.0.0.1:4747/metis/x.svg)'), /<img src=/);
  assert.match(md.enLigne('![local](/metis/x.svg)'), /<img src=/);
  assert.match(md.enLigne('[clic](javascript:alert(1))'), /href="#"/);
  assert.match(md.enLigne('[ailleurs](https://exemple.org)'), /rel="noopener nofollow"/);
});

ok('une publication complète passe par l’hôte par défaut', () => {
  const M = require('../lib/modules/metisdocs');
  M.init();
  const r = M.publier(proprio.id, { titre: 'Carnet de bord', corps: '## Objectif\n\nUne première note assez longue pour être publiée.', categorie: 'Note' }, { auteur: 'proprio' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.document.url, /^http:\/\/127\.0\.0\.1:4747\/metis\//);
  assert.equal(M.peutLire(membre.id), false);
  assert.equal(M.accorder(proprio.id, 'lea').ok, true);
  assert.equal(M.peutLire(membre.id), true);
  assert(M.lecteurs().some((l) => l.pseudo === 'lea'));
});

inst.fermer();
console.log(`defaut : ${n} vérifications`);
