'use strict';

// =============================================================================
//  Graphiques des publications Métis — une spécification JSON devient un SVG
//     node test/graphiques.test.js
// -----------------------------------------------------------------------------
//  1. CHAQUE TYPE SE DESSINE (ligne, barres, barres horizontales, aire, empilé,
//     nuage, anneau) et rend un SVG accessible (role="img", titre).
//  2. UNE ERREUR DIT QUOI CORRIGER : le message nomme le champ et l'écart.
//  3. RIEN DE LA SPÉCIFICATION N'EST INJECTÉ TEL QUEL : titres, noms, étiquettes
//     sont échappés — un « <script> » dans un titre reste du texte.
//  Module PUR : pas de base, pas de réseau.
// =============================================================================

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');
const G = require('../lib/modules/graphiques');

sec('1. Chaque type se dessine');
{
  const x = ['Jan', 'Fév', 'Mar', 'Avr'];
  const deux = [{ nom: 'Métis', valeurs: [12, 18, 25, 31] }, { nom: 'Témoin', valeurs: [10, 11, 13, 12] }];
  for (const type of ['ligne', 'barres', 'barres-h', 'aire', 'empile']) {
    const r = G.graphique({ type, titre: 'Score', x, series: deux, unite: '%' });
    ok(r.ok && /^<svg class="graphique"/.test(r.svg) && /role="img"/.test(r.svg) && r.svg.includes('Score'), type + ' : SVG accessible');
  }
  const n = G.graphique({ type: 'nuage', series: [{ nom: 'Essais', points: [[1, 2], [2, 3.5], [3, 2.8]] }] });
  ok(n.ok && (n.svg.match(/<circle/g) || []).length === 3, 'nuage : un point par mesure');
  const a = G.graphique({ type: 'anneau', x: ['A', 'B', 'C'], series: [{ nom: 'Parts', valeurs: [50, 30, 20] }] });
  ok(a.ok && (a.svg.match(/<path/g) || []).length === 3 && a.svg.includes('50 %'), 'anneau : une part par valeur, pourcentages affichés');
  ok(G.graphique({ type: 'line', x, series: deux }).spec.type === 'ligne' && G.graphique({ type: 'donut', x: ['a'], series: [{ valeurs: [1] }] }).ok, 'les noms anglais courants sont compris (line, donut…)');
  const trou = G.graphique({ type: 'ligne', x, series: [{ nom: 'S', valeurs: [1, null, 3, 4] }] });
  ok(trou.ok && (trou.svg.match(/<path d="M/g) || []).length === 2, 'une valeur manquante (null) coupe la ligne au lieu d’inventer un segment');
}

sec('2. Une erreur dit quoi corriger');
{
  let r = G.valider({ type: 'camembert3d', series: [] });
  ok(!r.ok && r.erreurs.some((e) => /type doit valoir/.test(e)), 'type inconnu : la liste des types admis est donnée');
  r = G.valider({ type: 'barres', x: ['a', 'b', 'c'], series: [{ nom: 'S', valeurs: [1, 2] }] });
  ok(!r.ok && r.erreurs.some((e) => /2 nombres, x en a 3/.test(e)), 'longueurs différentes : l’écart est chiffré');
  r = G.valider({ type: 'barres', x: ['a'], series: [{ nom: 'S', valeurs: ['douze'] }] });
  ok(!r.ok && r.erreurs.some((e) => /valeurs\[0\] n’est pas un nombre/.test(e)), 'valeur non numérique : sa position est donnée');
  r = G.valider({ type: 'empile', x: ['a'], series: [{ valeurs: [-3] }] });
  ok(!r.ok, 'empilé : valeurs négatives refusées');
  r = G.valider({ type: 'barres', x: ['a'], series: Array.from({ length: 9 }, () => ({ valeurs: [1] })) });
  ok(!r.ok && r.erreurs.some((e) => /Au plus/.test(e)), 'trop de séries : refusé');
  ok(!G.valider('pas un objet').ok && !G.valider(null).ok, 'une spécification qui n’est pas un objet est refusée');
}

sec('3. Rien n’est injecté tel quel');
{
  const r = G.graphique({ type: 'barres', titre: '<script>alert(1)</script>', x: ['<img src=x onerror=alert(1)>'], series: [{ nom: '"><svg onload=alert(1)>', valeurs: [1] }], source: '</figure>' });
  ok(r.ok && !/<script|<img|onload=|onerror=alert/.test(r.svg.replace(/&lt;[^&]*&gt;/g, '')), 'titres, étiquettes et noms sont échappés');
  ok(r.svg.includes('&lt;script&gt;'), 'et restent lisibles comme du texte');
}

sec('4. Échelles lisibles');
{
  const g = G.graduations(0, 87);
  ok(g.min === 0 && g.max >= 87 && g.t.every((v) => Number.isFinite(v)) && g.t.length <= 12, 'graduations rondes (' + g.t.join(', ') + ')');
  ok(G.fmt(1500000) === '1,5 M' && G.fmt(12.5, '%') === '12,5 %', 'nombres au format français');
}

sec('5. Le catalogue : chaque type a un exemple qui se dessine');
{
  const manquants = G.TYPES.filter((t) => !G.CATALOGUE.some((c) => c.type === t));
  ok(!manquants.length, 'un exemple par type (' + G.TYPES.length + ' types)' + (manquants.length ? ' — manquent : ' + manquants.join(', ') : ''));
  for (const c of G.CATALOGUE) {
    const r = G.graphique(c.exemple, { id: 'cat-' + c.type });
    const vb = r.ok && /viewBox="0 0 (\d+) (\d+)"/.exec(r.svg);
    ok(r.ok && vb && Number(vb[2]) > 100 && !/NaN|undefined|Infinity/.test(r.svg), c.type + ' : exemple valide, dessiné, sans NaN ni undefined');
  }
  ok(G.graphique({ type: 'pie', x: ['a', 'b'], series: [{ valeurs: [1, 2] }] }).spec.type === 'secteurs' && G.valider({ type: 'Gantt', taches: [{ nom: 't', debut: 1, fin: 2 }] }).ok, 'alias et casse : pie → secteurs, Gantt → chronologie');
}

sec('6. Les nouveaux types disent quoi corriger');
{
  let r = G.valider({ type: 'flux', liens: [{ de: 'A', vers: 'B', valeur: 1 }, { de: 'B', vers: 'A', valeur: 1 }] });
  ok(!r.ok && /boucler : A → B → A|boucler : B → A → B/.test(r.erreurs[0]), 'un flux qui boucle est refusé, la boucle est nommée');
  r = G.valider({ type: 'schema', noeuds: [{ id: 'a', texte: 'A' }], liens: [{ de: 'a', vers: 'z' }] });
  ok(!r.ok && /liens\[0\]/.test(r.erreurs[0]), 'schéma : un lien vers un nœud inconnu est signalé');
  ok(G.valider({ type: 'schema', noeuds: [{ id: 'a', texte: 'A' }, { id: 'b', texte: 'B' }], liens: [{ de: 'a', vers: 'b' }, { de: 'b', vers: 'a' }] }).ok, 'schéma : un cycle est admis (lien de retour en pointillé)');
  r = G.valider({ type: 'ligne', x: ['a', 'b'], series: [{ valeurs: [1, 0] }], echelle: 'log' });
  ok(!r.ok && /strictement positives/.test(r.erreurs[0]), 'échelle log : zéro refusé');
  r = G.valider({ type: 'planche', blocs: [{ id: 'a', titre: 'A', icone: 'licorne' }] });
  ok(!r.ok && /icone « licorne » n’existe pas\. Icônes : utilisateur/.test(r.erreurs[0]), 'planche : icône inconnue → la liste des icônes');
  r = G.valider({ type: 'planche', blocs: [{ id: 'a', titre: 'A', col: 10, largeur: 4 }] });
  ok(!r.ok && /dépasse les 12 colonnes/.test(r.erreurs[0]), 'planche : un bloc qui déborde de la grille');
  const voisins = (l, g) => G.valider({ type: 'planche', ...(g ? { gouttiere: g } : {}), blocs: [{ id: 'a', titre: 'A', col: 1, largeur: 6 }, { id: 'b', titre: 'B', col: 7, largeur: 6 }], liens: [{ de: 'a', vers: 'b', texte: l }] });
  ok(voisins('encodage BPE').spec.gouttiere > 22 && voisins('').spec.gouttiere === 22 && voisins('encodage BPE', 16).spec.gouttiere === 16, 'planche : la gouttière s’élargit pour une flèche annotée entre blocs voisins (sauf réglage explicite)');
  ok(!voisins('x', 500).ok, 'planche : gouttière hors bornes refusée');
  r = G.valider({ type: 'chronologie', taches: [{ nom: 't', debut: '2026-10-02', fin: '2026-10-01' }] });
  ok(!r.ok && /finit avant de commencer/.test(r.erreurs[0]), 'chronologie : fin avant début');
  r = G.valider({ type: 'boite', series: [{ nom: 'S', resume: { min: 1, q1: 3, mediane: 2, q3: 4, max: 5 } }] });
  ok(!r.ok && /min ≤ q1 ≤ mediane/.test(r.erreurs[0]), 'boîte : un résumé incohérent');
}

sec('7. Rien n’est injecté dans les schémas et les planches');
{
  const pieges = '<script>alert(1)</script>';
  const s = G.graphique({ type: 'schema', titre: pieges, noeuds: [{ id: 'a', texte: pieges, sigle: '<b>', detail: pieges }, { id: 'b', texte: 'B' }], liens: [{ de: 'a', vers: 'b', texte: pieges }], glossaire: [{ sigle: '<i>', sens: pieges }] });
  const p = G.graphique({ type: 'planche', titre: pieges, mots: [pieges], pied: pieges, blocs: [{ id: 'a', titre: pieges, puces: [pieges], etiquettes: [pieges], cases: [pieges], pastilles: [pieges], elements: [{ titre: pieges, texte: pieges, puces: [pieges] }], badge: pieges }, { id: 'b', titre: 'B' }], liens: [{ de: 'a', vers: 'b', texte: pieges }] });
  const propre = (h) => !/<script|<b>|<i>/.test(h);
  // Le glossaire HTML porte ses propres <b> : on y cherche le sigle piégé, échappé.
  const gl = G.glossaireHtml(s.spec);
  ok(s.ok && p.ok && propre(s.svg) && propre(p.svg) && !/<script|<i>/.test(gl) && gl.includes('&lt;i&gt;'), 'schéma, planche et glossaire échappent chaque texte');
  const r = G.resumer(G.valider(G.CATALOGUE.find((c) => c.type === 'planche').exemple).spec);
  ok(r.blocs.length > 5 && r.liens.length > 5, 'resumer : ce qu’un modèle qui ne voit pas l’image doit savoir');
}

console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
