'use strict';
const P = require('../modules/metisprojects');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { idea: 'Idée', active: 'Actif', paused: 'En pause', done: 'Terminé', archived: 'Archivé', backlog: 'À préparer', ready: 'Prêt', in_progress: 'En cours', blocked: 'Bloqué', review: 'En revue', cancelled: 'Annulé', urgent: 'Urgente', high: 'Haute', normal: 'Normale', low: 'Basse', note: 'Note', decision: 'Décision', risk: 'Risque', session: 'Reprise' };
const label = s => labels[s] || s;
const noteDate = value => new Date(value).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const link = id => '/metis/projets/' + encodeURIComponent(id);
const badge = (s, cls = '') => '<span class="project-badge ' + cls + '">' + esc(label(s)) + '</span>';
const table = (heads, rows) => '<div class="project-scroll" tabindex="0"><table><thead><tr>' + heads.map(x => '<th scope="col">' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(x => '<td>' + esc(x ?? '—') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
const CSS = `<style>
.project-head{padding:20px 0 30px;border-bottom:1px solid var(--ligne);margin-bottom:28px}.project-kicker{text-transform:uppercase;letter-spacing:.15em;font-size:11px;color:var(--pale)}.project-head h1{font-family:var(--serif);font-size:clamp(36px,5vw,62px);font-weight:500;line-height:1.05;margin:12px 0}.project-head p{color:var(--texte2);max-width:740px;line-height:1.7}.project-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:18px}.project-card,.project-section,.project-empty{border:1px solid var(--ligne);border-radius:14px;padding:22px;background:var(--carte);margin:0 0 20px}.project-card h2{font-family:var(--serif);font-size:28px;font-weight:500;margin:14px 0 10px}.project-card a{color:inherit}.project-card p{line-height:1.6;overflow-wrap:anywhere;color:var(--texte2)}.project-badge{display:inline-block;border:1px solid var(--ligne);padding:4px 9px;border-radius:20px;font-size:11px;margin:3px 5px 3px 0}.project-alert{color:#d97757}.project-next{padding:14px;border-left:3px solid var(--pale);background:var(--fond);margin-top:16px;white-space:pre-wrap}.project-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--texte2);margin-top:15px}.project-metrics{display:flex;gap:14px;flex-wrap:wrap;margin:20px 0 28px}.project-metrics>div{flex:1;min-width:120px;border:1px solid var(--ligne);padding:18px;border-radius:12px}.project-metrics strong{display:block;font-size:30px;font-weight:500;margin-bottom:5px}.project-metrics span{font-size:12px;color:var(--texte2)}.project-filters{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-bottom:25px}.project-filters label{font-size:12px;display:flex;flex-direction:column;gap:7px;flex:1;min-width:150px}.project-filters input,.project-filters select,.project-filters button{font:inherit;color:inherit;background:var(--carte);border:1px solid var(--ligne);padding:11px;border-radius:8px;box-sizing:border-box;max-width:100%}.project-filters button{cursor:pointer}.project-board{display:flex;overflow-x:auto;gap:14px;padding-bottom:12px}.project-column{flex:1 0 240px;max-width:340px}.project-column h3{font-size:13px;font-weight:500;color:var(--texte2)}.project-task{border:1px solid var(--ligne);padding:16px;border-radius:10px;margin-bottom:12px;overflow-wrap:anywhere}.project-task h4{margin:8px 0 12px;font-size:15px}.project-task p{font-size:13px;line-height:1.6;white-space:pre-wrap}.project-task ul{padding-left:20px;font-size:12px}.project-scroll{overflow:auto}.project-scroll table{border-collapse:collapse;width:100%;font-size:13px}.project-scroll th,.project-scroll td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--ligne);overflow-wrap:anywhere}.project-section h2{font-family:var(--serif);font-size:28px;font-weight:500}.project-section pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.7}.project-section summary{cursor:pointer;padding:12px 0}.project-help{color:var(--texte2);font-size:13px;line-height:1.8}.project-card progress{width:100%;height:6px;accent-color:var(--pale);margin-top:14px}.project-anchors{display:flex;gap:14px;flex-wrap:wrap;margin:20px 0;font-size:13px}.project-section[id]{scroll-margin-top:22px}@media(max-width:600px){.project-section{padding:15px}.project-head{padding-top:10px}.project-filters{display:block}.project-filters label{margin-bottom:12px}.project-scroll th,.project-scroll td{padding:9px}.project-metrics>div{min-width:90px}}
.project-scroll table{min-width:520px}
.ch{--ch-explo:#87867f;--ch-revue:#b7791f;--ch-clos:var(--acc);--ch-ok:#3f8f5a;--ch-vieux:#c26a1d;--ch-ko:#b3443c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ch{--ch-explo:#b8b2a7;--ch-revue:#e0a43a;--ch-ok:#6cc08b;--ch-vieux:#e39a52;--ch-ko:#e07a72}}
:root[data-theme="dark"] .ch{--ch-explo:#b8b2a7;--ch-revue:#e0a43a;--ch-ok:#6cc08b;--ch-vieux:#e39a52;--ch-ko:#e07a72}
.ch-tete{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.ch-tete h2{margin:0}
.ch-etat{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;line-height:1.5}
.ch-e-exploration{color:var(--ch-explo)}.ch-e-revue{color:var(--ch-revue)}.ch-e-cloture{color:var(--ch-clos)}
.ch-niveau{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:18px 0 4px;font-size:15px;color:var(--texte2)}
.ch-niveau strong{font-family:var(--serif);font-size:44px;font-weight:500;color:var(--texte);line-height:1;margin-left:4px}.ch-niveau span{font-size:13px}
.ch-echelle{display:flex;align-items:flex-start;list-style:none;padding:0;margin:18px 0 8px}
.ch-cran{flex:0 0 22px;display:flex;flex-direction:column;align-items:center;gap:6px}
.ch-point{width:16px;height:16px;border-radius:50%;box-sizing:border-box;border:2px solid var(--ligne);background:var(--carte)}
.ch-num{font-size:12px;color:var(--pale);font-variant-numeric:tabular-nums}
.ch-cran.ch-clos .ch-point{background:var(--ch-clos);border-color:var(--ch-clos)}.ch-cran.ch-clos .ch-num{color:var(--texte2)}
.ch-cran.ch-courant .ch-point{width:20px;height:20px;margin-top:-2px;border-width:3px;border-color:var(--ch-etat,var(--ch-explo));box-shadow:0 0 0 4px var(--survol)}
.ch-cran.ch-courant .ch-num{color:var(--texte);font-weight:700}
.ch-c-exploration{--ch-etat:var(--ch-explo)}.ch-c-revue{--ch-etat:var(--ch-revue)}.ch-c-cloture{--ch-etat:var(--ch-clos)}
.ch-entre{flex:1 1 0;min-width:6px;height:16px;display:flex;align-items:center;justify-content:center;gap:4px;background:linear-gradient(var(--ligne),var(--ligne)) center/100% 2px no-repeat}
.ch-entre.ch-parcouru{background-image:linear-gradient(var(--ch-clos),var(--ch-clos))}
.ch-sous{width:7px;height:7px;border-radius:50%;box-sizing:border-box;border:1.5px solid var(--pale);background:var(--carte);flex:0 0 auto}
.ch-sous.ch-centieme{width:5px;height:5px;border-width:1px}.ch-sous.ch-centieme.ch-courant{width:7px;height:7px}
.ch-plus{font-size:9.5px;color:var(--pale);background:var(--carte);padding:0 2px;line-height:1}.ch-ellipse{background:none!important;color:var(--pale);font-size:13px;flex:0 0 18px}
.ch-sous.ch-clos{background:var(--ch-clos);border-color:var(--ch-clos)}.ch-sous.ch-courant{border-color:var(--ch-etat,var(--ch-explo));border-width:2px;width:9px;height:9px}
.ch-legende{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--pale);margin:0 0 18px}.ch-legende span{display:inline-flex;align-items:center;gap:6px}
.ch-l{display:inline-block;width:10px;height:10px;border-radius:50%;box-sizing:border-box;border:2px solid var(--ligne)}
.ch-l.ch-clos{background:var(--ch-clos);border-color:var(--ch-clos)}.ch-l.ch-courant{border-color:var(--ch-revue)}.ch-l.ch-l-sous{width:7px;height:7px;border:1.5px solid var(--pale)}
.ch-suite{border-left:3px solid var(--ch-clos);background:var(--fond);border-radius:0 10px 10px 0;padding:12px 16px;margin:0 0 18px}
.ch-suite small{text-transform:uppercase;letter-spacing:.12em;font-size:10.5px;color:var(--pale)}.ch-suite p{margin:4px 0 0;font-size:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.ch-alerte{border:1px solid var(--ch-vieux);border-left-width:4px;border-radius:10px;padding:12px 16px;margin:0 0 18px;font-size:14px}
.ch-alerte strong{color:var(--ch-vieux)}.ch-alerte p{margin:4px 0 8px;color:var(--texte2)}.ch-alerte ul{margin:0;padding-left:18px}.ch-alerte li{margin:4px 0;overflow-wrap:anywhere}
.ch code{font-size:11.5px;background:var(--survol);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.ch-discret{color:var(--pale);font-size:12.5px;line-height:1.7}.ch-note{margin-top:14px;border-top:1px solid var(--ligne);padding-top:12px}
.ch-groupe{border:1px solid var(--ligne);border-radius:12px;margin:10px 0;background:var(--fond)}
.ch-groupe>summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;list-style:none}.ch-groupe>summary::-webkit-details-marker{display:none}
.ch-groupe>summary::before{content:'▸';color:var(--pale);transition:transform .15s}.ch-groupe[open]>summary::before{transform:rotate(90deg)}
.ch-g-titre{font-weight:600}.ch-g-meta{margin-left:auto;font-size:12px;color:var(--pale)}
.ch-etapes{list-style:none;margin:0;padding:0 16px 12px 30px;position:relative}
.ch-etapes::before{content:'';position:absolute;left:21px;top:4px;bottom:18px;width:2px;background:var(--ligne)}
.ch-etapes>li{position:relative;padding-left:14px}
.ch-etapes>li::before{content:'';position:absolute;left:-13px;top:16px;width:10px;height:10px;border-radius:50%;background:var(--ch-etat);box-shadow:0 0 0 3px var(--fond)}
.ch-etapes summary{display:flex;align-items:center;gap:10px;padding:9px 0;list-style:none;min-width:0}.ch-etapes summary::-webkit-details-marker{display:none}
.ch-etapes time{font-size:12px;color:var(--pale);font-variant-numeric:tabular-nums;white-space:nowrap}
.ch-apercu{color:var(--texte2);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.ch-corps{padding:2px 0 10px;font-size:14px;overflow-wrap:anywhere}.ch-corps>p{margin:6px 0}.ch-corps ul{margin:2px 0 8px;padding-left:20px}
.ch-sous-titre{text-transform:uppercase;letter-spacing:.1em;font-size:10.5px;color:var(--pale);margin:12px 0 2px}
.ch-sources{list-style:none;padding-left:0!important}.ch-sources li{margin:5px 0}
.ch-source{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor;color:var(--pale)}
.ch-f-a_jour{color:var(--ch-ok)}.ch-f-perimee{color:var(--ch-vieux)}.ch-f-absente,.ch-f-inaccessible{color:var(--ch-ko)}
@media(max-width:600px){.ch-cran{flex-basis:18px}.ch-point{width:13px;height:13px}.ch-cran.ch-courant .ch-point{width:17px;height:17px}.ch-niveau strong{font-size:36px}.ch-g-meta{margin-left:0;width:100%}.ch-etapes{padding-left:24px}.ch-etapes::before{left:15px}.ch-apercu{display:none}}
</style>`;
function header(title, intro) { return CSS + '<header class="project-head"><div class="project-kicker">Métis · Autres projets</div><h1>' + esc(title) + '</h1><p>' + esc(intro) + '</p></header>'; }
const metrics = values => '<div class="project-metrics">' + values.map(([n, name]) => '<div><strong>' + esc(n ?? '—') + '</strong><span>' + esc(name) + '</span></div>').join('') + '</div>';
function portfolio(rows, query = {}) {
  const all = rows.map(r => P.summary(r));
  const q = String(query.q || '').toLocaleLowerCase('fr').slice(0, 160), state = String(query.state || '');
  const selected = all.filter(p => (!state || p.state === state) && (!q || (p.title + ' ' + p.goal + ' ' + p.tags.join(' ')).toLocaleLowerCase('fr').includes(q)));
  return header('Chaque projet, sa trajectoire.', 'Un même endroit pour préparer les idées, organiser le travail et retrouver la prochaine action. Vos agents peuvent lire et mettre à jour ce portefeuille par le serveur MCP de Métis.')
    + metrics([[all.length, 'projets'], [all.filter(p => p.state === 'active').length, 'actifs'], [all.reduce((n, p) => n + p.actionable, 0), 'tâches prêtes'], [all.reduce((n, p) => n + p.overdue, 0), 'tâches en retard']])
    + '<form class="project-filters" method="get"><label>Rechercher<input name="q" value="' + esc(q) + '" placeholder="Projet, objectif, étiquette…" maxlength="160"></label><label>État<select name="state"><option value="">Tous les projets</option>' + P.PROJECT_STATES.map(s => '<option value="' + s + '"' + (state === s ? ' selected' : '') + '>' + label(s) + '</option>').join('') + '</select></label><button>Filtrer</button></form>'
    + (selected.length ? '<div class="project-grid">' + selected.map(p => '<article class="project-card">' + badge(p.state) + badge(p.priority) + '<h2><a href="' + link(p.id) + '">' + esc(p.title) + '</a></h2><p>' + esc(p.goal) + '</p>' + (p.progress_percent === null ? '<p>Aucune tâche comptabilisée.</p>' : '<progress max="100" value="' + p.progress_percent + '" aria-label="Progression du projet ' + esc(p.title) + '"></progress><div class="project-meta"><span>' + p.progress_percent + ' % terminés</span><span>' + p.task_counts.done + ' / ' + (p.task_total - p.task_counts.cancelled) + ' tâches</span></div>') + '<div class="project-meta"><span>Échéance : ' + esc(p.due_on || 'À définir') + '</span>' + (p.overdue ? '<span class="project-alert">' + p.overdue + ' en retard</span>' : '') + '</div>' + (p.next_action ? '<div class="project-next"><small>Prochaine action</small><p>' + esc(p.next_action) + '</p></div>' : '') + '<p>' + p.tags.map(t => badge(t)).join('') + '</p></article>').join('') + '</div>' : '<div class="project-empty"><h2>' + (all.length ? 'Aucun projet pour ces filtres.' : 'Le prochain projet commence ici.') + '</h2><p>' + (all.length ? 'Élargissez la recherche ou changez l’état.' : 'Demandez à un agent de créer un projet dans Métis, avec son objectif et ses premières tâches.') + '</p></div>')
    + '<section class="project-section"><h2>Un espace de travail pour vos agents</h2><p class="project-help">Objectifs et priorités · tableau de tâches · checklists · dépendances · estimations et temps passé · jalons · agenda et rappels · décisions et risques · notes de reprise · historique · exports JSON, Markdown et calendrier.</p><details><summary>Parcours du connecteur</summary><ol class="project-help"><li>Ouvrir <code>projets_tableau</code>, puis <code>projets_lister</code> ou <code>projets_creer</code>.</li><li>Lire le projet, ses tâches et ses notes ; choisir avec <code>projets_prochaines_actions</code>.</li><li>Prévisualiser avec <code>projets_planifier</code>, puis enregistrer avec <code>projets_appliquer_plan</code>.</li><li>Avant de partir, ajouter une note de session et sa prochaine action.</li></ol><p class="project-help">Les rappels et l’agenda sont consultés à la demande. Les projets du portefeuille ne donnent aucun droit d’exécution sur les machines.</p></details></section>';
}

// ── Système du chiffre ─────────────────────────────────────────────────────
// Échelle 0 → 10, prochaine étape, alerte de contradictions, historique regroupé par niveau.
// La fraîcheur et les contradictions sont calculées pour le LECTEUR de la page (ses droits).
const CH_ETATS = { exploration: ['○', 'Exploration'], revue: ['◐', 'En revue'], cloture: ['●', 'Clôture'] };
const CH_FRAICHEUR = { a_jour: 'à jour', perimee: 'périmée', absente: 'absente', inaccessible: 'inaccessible', non_versionnee: 'non versionnée' };
const pluriel = (n, mot, s = 's') => n + ' ' + mot + (n > 1 ? s : '');
const chEtat = e => '<span class="ch-etat ch-e-' + esc(e) + '">' + (CH_ETATS[e] ? CH_ETATS[e][0] + ' ' + CH_ETATS[e][1] : esc(e)) + '</span>';
function chEchelle(etapes) {
  const dernier = etapes.at(-1), courant = dernier?.niveau ?? null;
  const clos = new Set(etapes.filter(e => e.etat === 'cloture').map(e => e.niveau));
  const vus = [...new Set(etapes.map(e => e.niveau))].map(v => P.niveauChiffre(v));
  const etatDe = n => clos.has(n) ? 'ch-clos' : n === courant ? 'ch-courant ch-c-' + dernier.etat : 'ch-avenir';
  const nomDe = n => 'Niveau ' + n + ' : ' + (clos.has(n) ? 'clos' : n === courant ? (CH_ETATS[dernier.etat]?.[1] || dernier.etat).toLowerCase() : 'à venir');
  // On vise 10 ; au-delà, l'échelle s'allonge jusqu'au niveau suivant le plus haut atteint.
  const haut = Math.max(10, ...vus.map(v => v.major + 1));
  // Trop de crans pour un écran de téléphone : 0, une ellipse, puis les 11 derniers.
  const crans = haut > 12 ? [0, null, ...Array.from({ length: 11 }, (_, i) => haut - 10 + i)] : Array.from({ length: haut + 1 }, (_, i) => i);
  let html = '<ol class="ch-echelle" aria-label="Progression du chiffre, de 0 à ' + haut + '">';
  crans.forEach((n, i) => {
    if (n === null) { html += '<li class="ch-entre ch-ellipse" aria-hidden="true"><span>…</span></li>'; return; }
    const v = String(n);
    html += '<li class="ch-cran ' + etatDe(v) + '" aria-label="' + esc(nomDe(v)) + '"' + (v === courant ? ' aria-current="step"' : '') + '><span class="ch-point"></span><span class="ch-num">' + n + '</span></li>';
    if (i === crans.length - 1 || crans[i + 1] === null) return;
    // Sous-niveaux entre n et n + 1 : dixièmes en points, centièmes en points plus petits.
    const sous = vus.filter(x => x.major === n && x.index % 100 !== 0).sort((x, y) => x.index - y.index);
    const parcouru = clos.has(v) && (vus.some(x => x.major === n + 1) || sous.length > 0);
    const montre = sous.length > 6 ? sous.slice(-5) : sous;
    html += '<li class="ch-entre' + (parcouru ? ' ch-parcouru' : '') + '">'
      + (sous.length > montre.length ? '<span class="ch-plus" title="' + esc((sous.length - montre.length) + ' sous-niveaux plus anciens') + '">+' + (sous.length - montre.length) + '</span>' : '')
      + montre.map(x => '<span class="ch-sous ' + etatDe(x.value) + (x.index % 10 !== 0 ? ' ch-centieme' : '') + '" role="img" aria-label="' + esc(nomDe(x.value)) + '" title="' + esc(nomDe(x.value)) + '"></span>').join('') + '</li>';
  });
  return html + '</ol><p class="ch-legende" aria-hidden="true"><span><i class="ch-l ch-clos"></i>clos</span><span><i class="ch-l ch-courant"></i>en cours</span><span><i class="ch-l ch-avenir"></i>à venir</span><span><i class="ch-l ch-l-sous"></i>sous-niveau (0.1, 0.01)</span></p>';
}
function chSource(ref) {
  const f = ref.fraicheur;
  return '<li><span class="ch-source ch-f-' + esc(f || 'inconnue') + '">' + esc(f ? CH_FRAICHEUR[f] || f : 'non calculée') + '</span> <code>' + esc(ref.id) + '</code>'
    + (f === 'perimee' && ref.revision_actuelle != null ? ' <span class="ch-discret">révision ' + esc(ref.revision_observee ?? '?') + ' citée, ' + esc(ref.revision_actuelle) + ' aujourd’hui</span>' : '')
    + (ref.statut_affirmation ? ' <span class="ch-discret">· affirmation : ' + esc(ref.statut_affirmation) + '</span>' : '') + '</li>';
}
function chiffreSection(p, etapes, viewer) {
  const historiques = p.notes.filter(n => P.NOTE_HISTORIQUE.test(n.title));
  if (!etapes.length && !historiques.length) return '';
  const dernier = etapes.at(-1);
  const list = (title, values) => values?.length
    ? '<p class="ch-sous-titre">' + esc(title) + '</p><ul>' + values.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' : '';
  // Niveaux du plus récent au plus ancien ; seuls les 12 derniers sont affichés (et annotés).
  const ordre = [...new Set(etapes.map(e => e.niveau))].reverse();
  const montres = ordre.slice(0, 12);
  const annote = e => viewer === undefined ? e : { ...e, resource_refs: (e.resource_refs || []).map(ref => P.annoterRef(viewer, ref)) };
  const parNiveau = new Map(montres.map(n => [n, etapes.filter(e => e.niveau === n).map(annote)]));
  const contradictions = new Map();
  for (const groupe of parNiveau.values()) for (const e of groupe) for (const ref of e.resource_refs || [])
    if (ref.contradictions?.length) contradictions.set(ref.id, ref.contradictions);
  const closCount = new Set(etapes.filter(e => e.etat === 'cloture').map(e => e.niveau)).size;
  const titre = id => (viewer === undefined ? null : P.titreLisible(viewer, id));
  const objet = id => (titre(id) ? esc(titre(id)) + ' ' : '') + '<code>' + esc(id) + '</code>';
  return '<section class="project-section ch" id="chiffre">'
    + '<div class="ch-tete"><h2>Système du chiffre</h2>' + (dernier ? chEtat(dernier.etat) : '') + '</div>'
    + (dernier
      ? '<p class="ch-niveau">Niveau <strong>' + esc(dernier.niveau) + '</strong><span>' + pluriel(closCount, 'niveau', 'x') + ' clos · ' + pluriel(etapes.length, 'état') + ' enregistré' + (etapes.length > 1 ? 's' : '') + '</span></p>' + chEchelle(etapes)
      : '<p class="ch-niveau">Aucun état enregistré pour le moment.</p>')
    + (dernier?.suite ? '<div class="ch-suite"><small>Prochaine étape</small><p>' + esc(dernier.suite) + '</p></div>' : '')
    + (contradictions.size ? '<div class="ch-alerte" role="note"><strong>Contradiction à examiner</strong><p>Une affirmation citée a une affirmation opposée dans Métis Science, sur le même sujet et la même portée. C’est un signal, pas un verdict.</p><ul>'
      + [...contradictions].map(([id, opp]) => '<li>' + objet(id) + '<br>contredite par : ' + opp.map(objet).join(', ') + '</li>').join('') + '</ul></div>' : '')
    + (historiques.length ? '<p class="ch-discret">' + pluriel(historiques.length, 'note') + ' plus ancienne' + (historiques.length > 1 ? 's' : '') + ' (titres en « N0 », « N1/2 »…) repérée' + (historiques.length > 1 ? 's' : '') + ', non comptée' + (historiques.length > 1 ? 's' : '') + ' comme preuve' + (historiques.length > 1 ? 's' : '') + '.</p>' : '')
    + montres.map((n, i) => {
      const groupe = parNiveau.get(n), fin = groupe.at(-1);
      const nbSources = new Set(groupe.flatMap(e => (e.resource_refs || []).map(r => r.id))).size;
      const nbDec = groupe.reduce((t, e) => t + (e.nouveautes?.length || 0), 0);
      return '<details class="ch-groupe"' + (i === 0 ? ' open' : '') + '><summary><span class="ch-g-titre">Niveau ' + esc(n) + '</span>' + chEtat(fin.etat)
        + '<span class="ch-g-meta">' + pluriel(groupe.length, 'état') + ' · ' + pluriel(nbDec, 'découverte') + ' · ' + pluriel(nbSources, 'source') + '</span></summary><ol class="ch-etapes">'
        + groupe.map(e => '<li class="ch-c-' + esc(e.etat) + '"><details><summary>' + chEtat(e.etat) + '<time datetime="' + esc(e.created_at) + '">' + esc(noteDate(e.created_at)) + '</time><span class="ch-apercu">' + esc(e.nouveautes?.[0] || e.resume) + '</span></summary><div class="ch-corps">'
          + '<p>' + esc(e.resume) + '</p>'
          + list('Découvertes', e.nouveautes) + list('Incertitudes', e.incertitudes) + list('Objections et contre-exemples', e.objections)
          + (e.resource_refs?.length ? '<p class="ch-sous-titre">Sources citées</p><ul class="ch-sources">' + e.resource_refs.map(chSource).join('') + '</ul>' : '')
          + (e.suite ? '<p><strong>Suite :</strong> ' + esc(e.suite) + '</p>' : '')
          + (e.code_commit ? '<p class="ch-discret">Commit <code>' + esc(e.code_commit.slice(0, 12)) + '</code></p>' : '')
          + '</div></details></li>').join('') + '</ol></details>';
    }).join('')
    + (ordre.length > 12 ? '<p class="ch-discret">Les 12 niveaux les plus récents sont affichés ; le reste se lit avec projets_chiffre.</p>' : '')
    + '<p class="ch-discret ch-note">Une clôture est documentaire : elle ne valide pas une hypothèse. Les preuves se qualifient dans Métis Science.</p>'
    + '</section>';
}

function detail(r, viewer) {
  const p = JSON.parse(r.data), s = P.summary(r), day = P.today();
  return header(p.title, p.goal) + '<p><a href="/metis/projets">← Tous les projets</a> · ' + badge(p.state) + badge(p.priority) + badge(r.visibility === 'private' ? 'Privé' : 'Lecteurs Métis') + '</p>'
    + metrics([[s.progress_percent === null ? '—' : s.progress_percent + ' %', 'progression'], [s.task_total, 'tâches'], [s.actionable, 'prêtes à avancer'], [s.overdue, 'en retard']])
    + (p.next_action ? '<section class="project-section"><h2>À la reprise</h2><pre>' + esc(p.next_action) + '</pre></section>' : '')
    + '<nav class="project-anchors" aria-label="Sections du projet"><a href="/metis/projets/' + encodeURIComponent(r.id) + '/reprise">Reprendre le développement</a><a href="#chiffre">Système du chiffre</a><a href="#taches">Tâches</a><a href="#jalons">Jalons</a><a href="#planning">Planning</a><a href="#notes">Notes et décisions</a></nav>'
    + chiffreSection(p, P.etapesChiffre(r.id), viewer)
    + '<section class="project-section" id="taches"><h2>Le travail, étape par étape</h2>' + (p.tasks.length ? '<div class="project-board" tabindex="0" aria-label="Tableau des tâches">' + P.TASK_STATES.filter(state => p.tasks.some(t => t.state === state)).map(state => '<div class="project-column"><h3>' + esc(label(state)) + ' · ' + p.tasks.filter(t => t.state === state).length + '</h3>' + p.tasks.filter(t => t.state === state).map(t => '<article class="project-task">' + badge(t.priority) + (t.due_on && t.due_on < day && !['done', 'cancelled'].includes(t.state) ? badge('En retard', 'project-alert') : '') + '<h4>' + esc(t.title) + '</h4><p>' + esc(t.description) + '</p><div class="project-meta"><span>' + esc(t.assignee || 'Non attribuée') + '</span><span>' + (t.estimate_minutes === null ? 'À estimer' : t.estimate_minutes + ' min estimées') + '</span><span>' + t.spent_minutes + ' min passées</span><span>Échéance : ' + esc(t.due_on || 'À définir') + '</span></div>' + (t.blocked_reason ? '<p class="project-alert">' + esc(t.blocked_reason) + '</p>' : '') + (t.outcome ? '<p>Résultat : ' + esc(t.outcome) + '</p>' : '') + (t.depends_on.length ? '<p>Dépend de : ' + t.depends_on.map(id => esc(p.tasks.find(x => x.id === id)?.title || id)).join(', ') + '</p>' : '') + (t.checklist.length ? '<ul>' + t.checklist.map(c => '<li>' + (c.done ? '✓ ' : '○ ') + esc(c.title) + '</li>').join('') + '</ul>' : '') + '</article>').join('') + '</div>').join('') + '</div>' : '<p>Aucune tâche pour le moment.</p>') + '</section>'
    + '<section class="project-section" id="jalons"><h2>Les rendez-vous du projet</h2>' + (p.milestones.length ? table(['Jalon', 'Échéance', 'Critères de réussite', 'État'], p.milestones.map(m => [m.title, m.due_on, m.criteria, label(m.state)])) : '<p>Aucun jalon défini.</p>') + '</section>'
    + '<section class="project-section" id="planning"><h2>Un planning à taille humaine</h2>' + (p.plan ? '<p>Capacité : ' + p.plan.daily_minutes + ' min / jour · ' + p.plan.horizon_days + ' jours · départ le ' + esc(p.plan.start_on) + '.</p>' + table(['Tâche', 'Début', 'Fin', 'Échéance dépassée'], p.plan.schedule.map(t => [t.title, t.starts_on, t.ends_on, t.late ? 'Oui' : 'Non'])) + (p.plan.excluded.length ? '<details><summary>' + p.plan.excluded.length + ' tâches à débloquer ou à replanifier</summary>' + table(['Tâche', 'Motif'], p.plan.excluded.map(t => [t.title, t.reason])) + '</details>' : '') : '<p>Demandez à un agent de prévisualiser un planning adapté à votre capacité quotidienne, puis de l’enregistrer.</p>') + '<p class="project-help">La planification tient compte des dépendances et du temps restant pour un seul exécutant. Les tâches modifiées demandent un nouveau planning.</p></section>'
    + '<section class="project-section" id="notes"><h2>Ce qu’on garde pour la suite</h2>' + (p.notes.length ? [...p.notes].reverse().map(n => '<details><summary>' + badge(n.kind) + esc(n.title) + ' · ' + esc(noteDate(n.created_at)) + '</summary><pre>' + esc(n.body) + '</pre></details>').join('') : '<p>Notes, décisions, risques et comptes rendus de session apparaîtront ici.</p>') + '</section>'
    + '<section class="project-section"><h2>Repères</h2><p>Échéance : ' + esc(p.due_on || 'À définir') + ' · Révision ' + r.revision + '</p><p>' + p.tags.map(t => badge(t)).join('') + '</p>' + p.links.map(url => '<p><a rel="noreferrer" href="' + esc(url) + '">' + esc(url) + '</a></p>').join('') + '<details><summary>Identifiant pour le connecteur</summary><pre>' + esc(r.id) + '</pre><p class="project-help">Historique : projets_journal · exports : projets_exporter. Toute modification attend la révision courante du projet.</p></details></section>';
}
function mount(router, { garde, envoyer, pasTrouve }) {
  router.get('/projets', (req, res, next) => {
    const account = garde(req, res); if (!account) return;
    if (!P.enabled()) return pasTrouve(res, account);
    try { envoyer(res, account, 'Autres projets — Métis', portfolio(P.visible(account.id), req.query), { actif: 'projets', fil: [['Métis', '/metis'], ['Autres projets', null]] }); } catch (e) { next(e); }
  });
  router.get('/projets/:id', (req, res, next) => {
    const account = garde(req, res); if (!account) return;
    if (!P.enabled()) return pasTrouve(res, account);
    try {
      const r = P.get(account.id, req.params.id);
      envoyer(res, account, P.summary(r).title + ' — Métis', detail(r, account.id), { actif: 'projets', fil: [['Métis', '/metis'], ['Autres projets', '/metis/projets'], [P.summary(r).title, null]] });
    } catch (e) { if (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT') return pasTrouve(res, account); next(e); }
  });
}
module.exports = { mount, portfolio, detail };
