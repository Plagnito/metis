'use strict';
// Pages du carnet des petites choses à faire : /metis/carnet et /metis/carnet/archives.
// Formulaires HTML sans JavaScript ; chaque envoi exige la même origine (voir origineSure).
const K = require('../modules/metiscarnet');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lib = (s) => K.LIBELLES[s] || s;
const jour = (v) => (v ? new Date(v).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long' }) : '');
const TEINTES = { bug: '#d4553b', amelioration: '#4f8fd6', nouveaute: '#7a68c9', maintenance: '#8a8a7c', documentation: '#3f9a7c', securite: '#c9902c', idee: '#c56a9f' };

const CSS = `<style>
.carnet-tete{padding:18px 0 26px;border-bottom:1px solid var(--ligne);margin-bottom:26px}
.carnet-tete .sur{text-transform:uppercase;letter-spacing:.15em;font-size:11px;color:var(--pale);margin:0}
.carnet-tete h1{font-family:var(--serif);font-weight:500;font-size:clamp(34px,5vw,56px);line-height:1.05;margin:12px 0}
.carnet-tete p{color:var(--texte2);max-width:720px;line-height:1.7;margin:0}
.carnet-chiffres{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 26px}
.carnet-chiffres a{flex:1;min-width:120px;border:1px solid var(--ligne);border-radius:12px;padding:16px;color:inherit;text-decoration:none;background:var(--carte)}
.carnet-chiffres a:hover{background:var(--survol)}
.carnet-chiffres b{display:block;font-size:28px;font-weight:500}.carnet-chiffres span{font-size:12px;color:var(--texte2)}
.carnet-avis{border:1px solid var(--ligne);border-left:3px solid #3f9a7c;border-radius:10px;padding:12px 16px;margin:0 0 22px;background:var(--carte)}
.carnet-avis.erreur{border-left-color:var(--acc)}
.carnet-boite{border:1px solid var(--ligne);border-radius:14px;background:var(--carte);margin:0 0 26px}
.carnet-boite>summary{cursor:pointer;padding:16px 20px;font-weight:500;list-style:none}
.carnet-boite>summary::-webkit-details-marker{display:none}
.carnet-boite>summary::before{content:'+';display:inline-block;width:20px;color:var(--acc);font-weight:600}
.carnet-boite[open]>summary::before{content:'−'}
.carnet-form{display:grid;gap:16px;padding:4px 20px 20px}
.carnet-form label,.carnet-form fieldset{display:flex;flex-direction:column;gap:7px;font-size:13px;color:var(--texte2);border:0;padding:0;margin:0;min-width:0}
.carnet-form legend{padding:0;margin-bottom:7px}
.carnet-form input[type=text],.carnet-form textarea,.carnet-form select,.carnet-filtres select,.carnet-filtres input{font:inherit;font-size:15px;color:var(--texte);background:var(--fond);border:1px solid var(--ligne);border-radius:8px;padding:10px 12px;box-sizing:border-box;width:100%}
.carnet-form textarea{min-height:90px;resize:vertical}
.carnet-ligne{display:grid;grid-template-columns:1fr 200px;gap:16px}
.carnet-puces{display:flex;flex-wrap:wrap;gap:7px}
.carnet-puces label{flex-direction:row;align-items:center;gap:0;font-size:13px;color:var(--texte)}
.carnet-puces input{position:absolute;opacity:0;width:1px;height:1px}
.carnet-puces span{border:1px solid var(--ligne);border-radius:20px;padding:5px 12px;cursor:pointer;background:var(--fond);user-select:none}
.carnet-puces input:checked+span{border-color:var(--c,var(--acc));background:color-mix(in srgb,var(--c,var(--acc)) 16%,transparent);color:var(--texte)}
.carnet-puces input:focus-visible+span{outline:2px solid var(--acc);outline-offset:2px}
.carnet-bouton,.carnet-actions button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--ligne);background:var(--fond);color:var(--texte);padding:8px 14px}
.carnet-bouton.plein{background:var(--acc);border-color:var(--acc);color:#fff;justify-self:start;padding:10px 20px}
.carnet-bouton.plein:hover{background:var(--acc2)}
.carnet-filtres{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:0 0 22px}
.carnet-filtres label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--texte2);min-width:160px;flex:1;max-width:260px}
.carnet-tableau{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
.carnet-col h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--texte2);margin:0 0 12px;display:flex;justify-content:space-between}
.carnet-tache{border:1px solid var(--ligne);border-radius:12px;padding:15px 16px;margin:0 0 12px;background:var(--carte);overflow-wrap:anywhere;scroll-margin-top:20px}
.carnet-tache:target{outline:2px solid var(--acc);outline-offset:2px}
.carnet-tache h3{font-size:16px;font-weight:600;margin:8px 0 6px;line-height:1.35}
.carnet-tache p{font-size:14px;line-height:1.55;color:var(--texte2);margin:6px 0;white-space:pre-wrap}
.carnet-badge{display:inline-block;font-size:11px;border-radius:20px;padding:2px 9px;margin:0 4px 4px 0;border:1px solid var(--ligne);color:var(--texte2)}
.carnet-badge.type{border-color:var(--c);color:var(--c);font-weight:600}
.carnet-badge.haute{border-color:var(--acc);color:var(--acc)}
.carnet-depot{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--fond);border:1px solid var(--ligne);border-radius:6px;padding:1px 7px;margin:0 4px 4px 0;display:inline-block;color:var(--texte)}
.carnet-meta{font-size:12px;color:var(--pale);margin-top:8px;line-height:1.6}
.carnet-resultat{border-left:3px solid #3f9a7c;padding:6px 10px;margin:8px 0;font-size:13px;white-space:pre-wrap;color:var(--texte)}
.carnet-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.carnet-actions form{margin:0}
.carnet-actions button{font-size:12px;padding:5px 10px}
.carnet-actions details{width:100%}
.carnet-actions summary{cursor:pointer;font-size:12px;color:var(--texte2);padding:4px 0}
.carnet-actions textarea{font:inherit;font-size:13px;width:100%;box-sizing:border-box;min-height:60px;margin:6px 0;background:var(--fond);color:var(--texte);border:1px solid var(--ligne);border-radius:8px;padding:8px}
.carnet-modif{display:grid;gap:10px;margin:6px 0 4px}
.carnet-modif label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--texte2)}
.carnet-modif input[type=text],.carnet-modif select{font:inherit;font-size:13px;color:var(--texte);background:var(--fond);border:1px solid var(--ligne);border-radius:8px;padding:7px 9px;width:100%;box-sizing:border-box}
.carnet-modif textarea{margin:0}
.carnet-modif-ligne{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.carnet-modif button{justify-self:start}
.carnet-vide{color:var(--pale);font-size:14px;border:1px dashed var(--ligne);border-radius:12px;padding:18px;text-align:center}
.carnet-aide{color:var(--texte2);font-size:13px;line-height:1.8}
@media(max-width:900px){.carnet-tableau{grid-template-columns:1fr}.carnet-ligne{grid-template-columns:1fr}.carnet-filtres label{max-width:none}}
</style>`;

function carte(t, peutEcrire, estMaster) {
  let h = '<article class="carnet-tache" id="tache-' + t.id + '">'
    + '<span class="carnet-badge type" style="--c:' + (TEINTES[t.type] || 'var(--pale)') + '">' + esc(lib(t.type)) + '</span>'
    + (t.priorite !== 'normale' ? '<span class="carnet-badge ' + t.priorite + '">Priorité ' + esc(lib(t.priorite).toLowerCase()) + '</span>' : '')
    + '<span class="carnet-badge">n° ' + t.id + '</span>'
    + '<h3>' + esc(t.titre) + '</h3>'
    + (t.detail ? '<p>' + esc(t.detail) + '</p>' : '')
    + (t.depots.length ? '<div>' + t.depots.map((d) => '<a class="carnet-depot" href="/metis/carnet?depot=' + encodeURIComponent(d) + '">' + esc(d) + '</a>').join('') + '</div>' : '')
    + (t.resultat ? '<div class="carnet-resultat">' + esc(t.resultat) + '</div>' : '');
  const meta = ['Noté par ' + esc(t.cree_par) + ' le ' + esc(jour(t.cree_le))];
  if (t.etat === 'en_cours') meta.push('En cours : <b>' + esc(t.agent) + '</b> depuis le ' + esc(jour(t.pris_le)));
  if (t.etat === 'terminee') meta.push('Terminée le ' + esc(jour(t.termine_le)) + (t.agent ? ' par ' + esc(t.agent) : '') + ' · archivée ' + (t.archive_dans_jours ? 'dans ' + t.archive_dans_jours + ' jour' + (t.archive_dans_jours > 1 ? 's' : '') : 'au prochain passage'));
  if (t.etat === 'archivee') meta.push('Terminée le ' + esc(jour(t.termine_le)) + (t.agent ? ' par ' + esc(t.agent) : '') + ' · archivée le ' + esc(jour(t.archive_le)));
  h += '<div class="carnet-meta">' + meta.join('<br>') + '</div>';
  if (peutEcrire) {
    const bouton = (etat, texte) => '<form method="post" action="/metis/carnet/' + t.id + '/etat"><input type="hidden" name="etat" value="' + etat + '"><input type="hidden" name="revision" value="' + t.revision + '"><button type="submit">' + texte + '</button></form>';
    h += '<div class="carnet-actions">';
    if (t.etat === 'a_faire') h += bouton('en_cours', 'Je m’en occupe');
    // Modifiable tant que personne ne l'a commencée (le module refuse au-delà).
    if (t.etat === 'a_faire') {
      const opt = (liste, choisi) => liste.map((v) => '<option value="' + v + '"' + (v === choisi ? ' selected' : '') + '>' + esc(lib(v)) + '</option>').join('');
      h += '<details><summary>Modifier…</summary><form class="carnet-modif" method="post" action="/metis/carnet/' + t.id + '/modifier">'
        + '<input type="hidden" name="revision" value="' + t.revision + '">'
        + '<label>Ce qu’il faut faire<input type="text" name="titre" maxlength="200" required value="' + esc(t.titre) + '"></label>'
        + '<div class="carnet-modif-ligne"><label>Type<select name="type">' + opt(K.TYPES, t.type) + '</select></label>'
        + '<label>Priorité<select name="priorite">' + opt(K.PRIORITES, t.priorite) + '</select></label></div>'
        + '<label>Dépôts (séparés par des virgules)<input type="text" name="depots" maxlength="400" value="' + esc(t.depots.join(', ')) + '"></label>'
        + '<label>Détails<textarea name="detail" maxlength="4000">' + esc(t.detail) + '</textarea></label>'
        + '<button type="submit">Enregistrer</button></form></details>';
    }
    if (t.etat === 'en_cours' || t.etat === 'terminee' || t.etat === 'archivee') h += bouton('a_faire', t.etat === 'en_cours' ? 'Remettre à faire' : 'Rouvrir');
    if (t.etat === 'a_faire' || t.etat === 'en_cours') {
      h += '<details><summary>Marquer terminée…</summary><form method="post" action="/metis/carnet/' + t.id + '/etat"><input type="hidden" name="etat" value="terminee"><input type="hidden" name="revision" value="' + t.revision + '">'
        + '<textarea name="resultat" maxlength="4000" placeholder="Résultat (facultatif) : ce qui a été fait" aria-label="Résultat de la tâche ' + t.id + '"></textarea><button type="submit">Terminer</button></form></details>';
    }
    if (estMaster) h += '<details><summary>Supprimer…</summary><form method="post" action="/metis/carnet/' + t.id + '/supprimer"><button type="submit">Supprimer définitivement la tâche n° ' + t.id + '</button></form></details>';
    h += '</div>';
  }
  return h + '</article>';
}

function formulaire(depots) {
  const puce = (name, value, texte, type = 'checkbox', coche = false, couleur = '') => '<label><input type="' + type + '" name="' + name + '" value="' + esc(value) + '"' + (coche ? ' checked' : '') + (type === 'radio' ? ' required' : '') + '><span' + (couleur ? ' style="--c:' + couleur + '"' : '') + '>' + esc(texte) + '</span></label>';
  return '<details class="carnet-boite" open><summary>Noter une petite chose à faire</summary><form class="carnet-form" method="post" action="/metis/carnet">'
    + '<div class="carnet-ligne"><label>Ce qu’il faut faire<input type="text" name="titre" maxlength="200" required placeholder="Ex. : le bouton Exporter du Tableur ne réagit pas sur mobile"></label>'
    + '<label>Priorité<select name="priorite">' + K.PRIORITES.map((p) => '<option value="' + p + '"' + (p === 'normale' ? ' selected' : '') + '>' + lib(p) + '</option>').join('') + '</select></label></div>'
    + '<fieldset><legend>Type d’action</legend><div class="carnet-puces">' + K.TYPES.map((t, i) => puce('type', t, lib(t), 'radio', i === 0, TEINTES[t])).join('') + '</div></fieldset>'
    + '<fieldset><legend>Dépôts concernés</legend><div class="carnet-puces">' + depots.map((d) => puce('depots', d, d)).join('') + '</div></fieldset>'
    + '<label>Autres dépôts (séparés par des virgules)<input type="text" name="autres_depots" maxlength="400" placeholder="ex. atlas-focus, fabrik"></label>'
    + '<label>Détails (facultatif)<textarea name="detail" maxlength="4000" placeholder="Contexte, étapes pour reproduire, idée de solution…"></textarea></label>'
    + '<button class="carnet-bouton plein" type="submit">Ajouter au carnet</button></form></details>';
}

function mount(router, { garde, envoyer, pasTrouve, formulaire: lecteurFormulaire = require('../serveur/routeur').formulaire, origineSure = require('../serveur/routeur').origineSure }) {
  const M = require('../modules/metisdocs');
  const lirePost = lecteurFormulaire('24kb');
  const avisDe = (q) => (q.ok ? '<div class="carnet-avis" role="status">' + esc(String(q.ok).slice(0, 300)) + '</div>' : q.err ? '<div class="carnet-avis erreur" role="alert">' + esc(String(q.err).slice(0, 300)) + '</div>' : '');
  const retour = (res, ok, err, ancre = '') => res.redirect(303, '/metis/carnet?' + (ok ? 'ok=' + encodeURIComponent(ok) : 'err=' + encodeURIComponent(err)) + ancre);

  router.get('/carnet', (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    try {
      const filtre = { type: K.TYPES.includes(req.query.type) ? req.query.type : '', depot: /^[A-Za-z0-9._-]{1,80}$/.test(req.query.depot || '') ? req.query.depot : '' };
      const taches = K.lister(moi.id, filtre), c = K.compter(moi.id), ecrit = M.peutEcrire(moi.id), master = M.estMaster(moi.id);
      const depots = K.depotsProposes(moi.id);
      let h = CSS + '<header class="carnet-tete"><p class="sur">Métis · Carnet</p><h1>Les petites choses à faire</h1>'
        + '<p>Ce qui traîne, noté en passant : bugs, améliorations, idées. Quand aucun travail n’est donné, un agent vient choisir ici, marque la tâche en cours, puis terminée. Une tâche terminée passe aux archives au bout de ' + K.DELAI_ARCHIVE_JOURS + ' jours.</p></header>'
        + avisDe(req.query)
        + '<div class="carnet-chiffres"><a href="#col-a_faire"><b>' + c.a_faire + '</b><span>à faire</span></a><a href="#col-en_cours"><b>' + c.en_cours + '</b><span>en cours</span></a><a href="#col-terminee"><b>' + c.terminee + '</b><span>terminées cette semaine</span></a><a href="/metis/carnet/archives"><b>' + c.archivee + '</b><span>archivées →</span></a></div>';
      if (ecrit) h += formulaire(depots);
      h += '<form class="carnet-filtres" method="get" action="/metis/carnet"><label>Type<select name="type"><option value="">Tous les types</option>' + K.TYPES.map((t) => '<option value="' + t + '"' + (filtre.type === t ? ' selected' : '') + '>' + lib(t) + '</option>').join('') + '</select></label>'
        + '<label>Dépôt<select name="depot"><option value="">Tous les dépôts</option>' + [...new Set([...(filtre.depot ? [filtre.depot] : []), ...depots])].map((d) => '<option' + (filtre.depot === d ? ' selected' : '') + '>' + esc(d) + '</option>').join('') + '</select></label>'
        + '<button class="carnet-bouton" type="submit">Filtrer</button>' + (filtre.type || filtre.depot ? '<a href="/metis/carnet" style="font-size:13px;padding:8px 4px">Tout afficher</a>' : '') + '</form>';
      h += '<div class="carnet-tableau">' + K.ETATS.map((e) => {
        const liste = taches.filter((t) => t.etat === e);
        return '<section class="carnet-col" id="col-' + e + '" aria-label="' + lib(e) + '"><h2><span>' + lib(e) + '</span><span>' + liste.length + '</span></h2>'
          + (liste.length ? liste.map((t) => carte(t, ecrit, master)).join('') : '<div class="carnet-vide">' + (e === 'a_faire' ? 'Rien à faire ici' + (filtre.type || filtre.depot ? ' pour ce filtre.' : ' : le carnet est à jour.') : e === 'en_cours' ? 'Aucune tâche en cours.' : 'Rien de terminé ces 7 derniers jours.') + '</div>') + '</section>';
      }).join('') + '</div>';
      h += '<details class="carnet-boite" style="margin-top:24px"><summary>Pour les agents (connecteur Métis)</summary><div style="padding:0 20px 16px" class="carnet-aide">'
        + '<code>carnet_lister</code> (etat <code>a_faire</code>) pour choisir, <code>carnet_prendre</code> avant de commencer — refusé si un autre agent l’a déjà —, <code>carnet_terminer</code> avec le résultat réel, <code>carnet_relacher</code> pour rendre une tâche. <code>carnet_ajouter</code> note ce qu’on découvre en chemin.</div></details>';
      envoyer(res, moi, 'Carnet — Métis', h, { actif: 'carnet', fil: [['Métis', '/metis'], ['Carnet', null]] });
    } catch (e) { next(e); }
  });

  router.get('/carnet/archives', (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    try {
      const taches = K.lister(moi.id, { archives: true, limite: 500 }), ecrit = M.peutEcrire(moi.id), master = M.estMaster(moi.id);
      let h = CSS + '<header class="carnet-tete"><p class="sur">Métis · Carnet</p><h1>Tâches archivées</h1><p>Les tâches terminées depuis plus de ' + K.DELAI_ARCHIVE_JOURS + ' jours, les plus récentes d’abord. « Rouvrir » en remet une dans le carnet.</p></header>'
        + avisDe(req.query) + '<p><a href="/metis/carnet">← Retour au carnet</a></p>';
      h += taches.length ? '<div style="max-width:820px">' + taches.map((t) => carte(t, ecrit, master)).join('') + '</div>' : '<div class="carnet-vide">Aucune tâche archivée pour l’instant.</div>';
      envoyer(res, moi, 'Archives du carnet — Métis', h, { actif: 'carnet', fil: [['Métis', '/metis'], ['Carnet', '/metis/carnet'], ['Archives', null]] });
    } catch (e) { next(e); }
  });

  router.post('/carnet', lirePost, (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    if (!M.peutEcrire(moi.id) || !origineSure(req)) return pasTrouve(res, moi);
    try {
      const b = req.body || {};
      const liste = [].concat(b.depots || []).concat(String(b.autres_depots || '').split(','));
      const t = K.ajouter(moi.id, { titre: String(b.titre || ''), detail: String(b.detail || ''), type: String(b.type || ''), priorite: String(b.priorite || 'normale'), depots: liste.map(String) });
      retour(res, 'Noté au carnet (n° ' + t.id + ').', null, '#tache-' + t.id);
    } catch (e) { if (e instanceof K.CarnetError) return retour(res, null, e.message); next(e); }
  });

  router.post('/carnet/:id(\\d{1,9})/etat', lirePost, (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    if (!M.peutEcrire(moi.id) || !origineSure(req)) return pasTrouve(res, moi);
    try {
      const b = req.body || {}, id = Number(req.params.id), revision = b.revision ? Number(b.revision) : undefined;
      const etat = String(b.etat || '');
      let t;
      if (etat === 'en_cours') t = K.prendre(moi.id, { id, revision, agent: moi.pseudo + ' (page web)' });
      else if (etat === 'terminee') t = K.terminer(moi.id, { id, revision, resultat: String(b.resultat || ''), depuis_web: true, ...(K.lire(moi.id, id).agent ? {} : { agent: moi.pseudo + ' (page web)' }) });
      else if (etat === 'a_faire') t = K.relacher(moi.id, { id, revision, motif: '' });
      else return retour(res, null, 'État inconnu.');
      retour(res, 'Tâche n° ' + t.id + ' : ' + lib(t.etat).toLowerCase() + '.', null, '#tache-' + t.id);
    } catch (e) { if (e instanceof K.CarnetError) return retour(res, null, e.message); next(e); }
  });

  router.post('/carnet/:id(\\d{1,9})/modifier', lirePost, (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    if (!M.peutEcrire(moi.id) || !origineSure(req)) return pasTrouve(res, moi);
    try {
      const b = req.body || {}, id = Number(req.params.id);
      const t = K.modifier(moi.id, {
        id, revision: b.revision ? Number(b.revision) : undefined,
        titre: String(b.titre || ''), detail: String(b.detail || ''), type: String(b.type || ''), priorite: String(b.priorite || ''),
        depots: String(b.depots || '').split(','),
      });
      retour(res, 'Tâche n° ' + t.id + ' modifiée.', null, '#tache-' + t.id);
    } catch (e) { if (e instanceof K.CarnetError) return retour(res, null, e.message, '#tache-' + req.params.id); next(e); }
  });

  router.post('/carnet/:id(\\d{1,9})/supprimer', lirePost, (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    if (!M.estMaster(moi.id) || !origineSure(req)) return pasTrouve(res, moi);
    try { K.supprimer(moi.id, Number(req.params.id)); retour(res, 'Tâche n° ' + req.params.id + ' supprimée.'); }
    catch (e) { if (e instanceof K.CarnetError) return retour(res, null, e.message); next(e); }
  });
}

module.exports = { mount, carte };
