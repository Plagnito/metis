'use strict';

// =============================================================================
//  /metis/github — les issues GitHub dans l'interface
// -----------------------------------------------------------------------------
//  Dépôts suivis (et leur projet), issues ouvertes avec leur tâche, limites des
//  agents (réglées ICI par le propriétaire, jamais par un outil MCP), journal des
//  actions faites sur GitHub. Formulaires sans JavaScript, même origine exigée.
// =============================================================================

const G = require('../modules/metis-github');
const P = () => require('../modules/metisprojects');
const M = () => require('../modules/metisdocs');

const STYLE = `<style>
.gh{max-width:1100px;margin:0 auto;padding:28px clamp(18px,3vw,48px) 60px}
.gh h1{font-family:var(--serif);font-weight:500;font-size:40px;margin:0 0 6px}
.gh h2{font-family:var(--serif);font-weight:500;font-size:24px;margin:34px 0 12px}
.gh .intro{color:var(--texte2);max-width:760px}
.gh table{width:100%;border-collapse:collapse;font-size:14.5px;background:var(--carte);border:1px solid var(--ligne);border-radius:12px;overflow:hidden}
.gh th,.gh td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--ligne);vertical-align:top}
.gh th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--pale);font-weight:600}
.gh .eti{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--ligne);margin:0 4px 2px 0;color:var(--texte2)}
.gh form.ligne{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
.gh input,.gh select{font:inherit;font-size:14px;padding:8px 10px;border-radius:9px;border:1px solid var(--ligne);background:var(--carte);color:var(--texte)}
.gh button{font:inherit;font-size:14px;padding:8px 14px;border-radius:9px;border:1px solid var(--ligne);background:var(--texte);color:var(--fond);cursor:pointer}
.gh button.discret{background:none;color:var(--texte2)}
.gh .avis{padding:10px 14px;border-radius:10px;border:1px solid var(--ligne);background:var(--carte);margin:14px 0}
.gh .erreur{border-color:var(--acc)}
.gh .presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:10px 0 16px}
.gh .presets div{background:var(--carte);border:1px solid var(--ligne);border-radius:12px;padding:12px 14px;font-size:14px;color:var(--texte2)}
.gh .presets b{display:block;color:var(--texte);font-size:15px;margin-bottom:4px}
.gh .ko{color:var(--acc)}.gh .gh-pale{color:var(--texte2)}
</style>`;

const LIBELLE_ACTION = { lire: 'lire', commenter: 'commenter', lier_pr: 'lier une PR', fermer: 'fermer et rouvrir', etiqueter: 'étiqueter', assigner: 'assigner', creer: 'créer des issues' };
const DESCRIPTION_PRESET = {
  lecture: 'Lit les issues et leurs commentaires. N’écrit rien sur GitHub. C’est la limite de tout agent jamais réglé.',
  contributeur: 'Lit, commente et signale la pull request qui corrige une issue.',
  mainteneur: 'Tout : commenter, lier une PR, fermer, rouvrir, étiqueter, assigner, créer des issues.',
};

function mount(router, ctx) {
  const { garde, envoyer, pasTrouve, esc } = ctx;
  const lire = (ctx.formulaire || require('../serveur/routeur').formulaire)('8kb');
  const origineSure = ctx.origineSure || require('../serveur/routeur').origineSure;
  const date = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }); };
  const retour = (res, ok, err) => res.redirect(303, '/metis/github?' + (ok ? 'ok=' + encodeURIComponent(ok) : 'err=' + encodeURIComponent(err)));

  router.get('/github', (req, res, next) => {
    const moi = garde(req, res); if (!moi) return;
    try {
      const ecrit = M().peutEcrire(moi.id), proprio = M().estMaster(moi.id);
      const depots = G.depots(moi.id), ouvertes = G.issues(moi.id, { etat: 'open', limite: 300 });
      let projets = []; try { projets = P().visible(moi.id).map((r) => P().summary(r)); } catch { /* projets désactivés */ }
      const titreProjet = new Map(projets.map((p) => [p.id, p.title]));
      let h = STYLE + '<div class="gh"><h1>Issues GitHub</h1><p class="intro">Chaque issue d’un dépôt suivi devient une tâche de son projet : les agents la reprennent comme n’importe quelle tâche. Ils peuvent aussi agir sur GitHub, chacun dans les limites que vous lui fixez ci-dessous ; toute action est journalisée.</p>'
        + (req.query.ok ? '<div class="avis" role="status">' + esc(String(req.query.ok).slice(0, 300)) + '</div>' : '')
        + (req.query.err ? '<div class="avis erreur" role="alert">' + esc(String(req.query.err).slice(0, 300)) + '</div>' : '')
        + '<p class="gh-pale">Jeton GitHub : ' + (G.jetonConfigure() ? 'configuré.' : '<b>absent</b> — lecture des dépôts publics seulement ; définissez <code>METIS_GITHUB_TOKEN</code> pour les dépôts privés et les actions.') + '</p>';

      h += '<h2>Dépôts suivis</h2>';
      h += depots.length ? '<table><thead><tr><th>Dépôt</th><th>Projet</th><th>Issues ouvertes</th><th>Synchronisé</th><th></th></tr></thead><tbody>' + depots.map((d) =>
        '<tr><td><a href="' + esc(d.url) + '" rel="noopener nofollow">' + esc(d.depot) + '</a></td><td><a href="/metis/projets/' + encodeURIComponent(d.project_id) + '">' + esc(titreProjet.get(d.project_id) || d.project_id) + '</a></td>'
        + '<td>' + d.ouvertes + ' / ' + d.issues + '</td><td>' + (d.synchro_le ? esc(date(d.synchro_le)) : '<span class="gh-pale">jamais</span>') + '</td>'
        + '<td>' + (ecrit ? '<form method="post" action="/metis/github/synchroniser"><input type="hidden" name="depot" value="' + esc(d.depot) + '"><button class="discret" type="submit">Synchroniser</button></form>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="gh-pale">Aucun dépôt suivi pour l’instant.</p>';
      if (ecrit) {
        h += projets.length
          ? '<form class="ligne" method="post" action="/metis/github/suivre"><input name="depot" placeholder="compte/dépôt" required maxlength="140" aria-label="Dépôt GitHub"><select name="project_id" aria-label="Projet">' + projets.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.title) + '</option>').join('') + '</select><button type="submit">Suivre ce dépôt</button></form>'
          : '<p class="gh-pale">Créez d’abord un projet (par un agent, avec projets_creer) pour y rattacher un dépôt.</p>';
      }

      h += '<h2>Issues ouvertes · ' + ouvertes.length + '</h2>';
      h += ouvertes.length ? '<table><thead><tr><th>Issue</th><th>Étiquettes</th><th>Assignée à</th><th>Tâche</th><th>PR</th></tr></thead><tbody>' + ouvertes.map((i) =>
        '<tr><td><a href="' + esc(i.url) + '" rel="noopener nofollow">' + esc(i.depot) + '#' + i.numero + '</a> ' + esc(i.titre) + '</td>'
        + '<td>' + i.etiquettes.map((e) => '<span class="eti">' + esc(e) + '</span>').join('') + '</td><td>' + esc(i.assignes.join(', ')) + '</td>'
        + '<td>' + (i.task_id ? '<a href="/metis/projets/' + encodeURIComponent(i.project_id) + '">' + esc(titreProjet.get(i.project_id) || 'projet') + '</a>' : '<span class="gh-pale">—</span>') + '</td>'
        + '<td>' + i.prs.map((u) => '<a href="' + esc(u) + '" rel="noopener nofollow">#' + esc(u.split('/').pop()) + '</a>').join(' ') + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="gh-pale">Aucune issue ouverte importée.</p>';

      if (proprio) {
        h += '<h2>Limites des agents</h2><p class="intro">Un agent est identifié par son client (le nom donné à son jeton, ou l’application OAuth). Aucun outil MCP ne modifie ces limites : un agent ne peut pas s’élever lui-même.</p>'
          + '<div class="presets">' + Object.keys(G.PRESETS).map((p) => '<div><b>' + esc(p[0].toUpperCase() + p.slice(1)) + '</b>' + esc(DESCRIPTION_PRESET[p]) + '</div>').join('') + '</div>';
        const regles = G.listeDroits(moi.id);
        h += regles.length ? '<table><thead><tr><th>Compte</th><th>Agent</th><th>Préréglage</th><th>Peut</th><th>Dépôts</th><th>Réglé le</th></tr></thead><tbody>' + regles.map((r) =>
          '<tr><td>' + esc(r.pseudo || r.compte) + '</td><td><code>' + esc(r.client) + '</code></td><td>' + esc(r.preset) + '</td><td>' + esc(r.actions.map((a) => LIBELLE_ACTION[a]).join(', ')) + '</td><td>' + (r.depots ? esc(r.depots.join(', ')) : 'tous les dépôts suivis') + '</td><td>' + esc(date(r.maj_le)) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="gh-pale">Aucun agent réglé : tous sont en lecture.</p>';
        h += '<form class="ligne" method="post" action="/metis/github/droits"><input name="pseudo" placeholder="Pseudo du compte" value="' + esc(moi.pseudo) + '" required maxlength="40" aria-label="Pseudo du compte">'
          + '<input name="client" placeholder="Agent (ex. claude-code)" required maxlength="100" aria-label="Agent"><select name="preset" aria-label="Préréglage">' + Object.keys(G.PRESETS).map((p) => '<option value="' + p + '">' + p + '</option>').join('') + '</select>'
          + '<input name="depots" placeholder="Dépôts (vide = tous)" maxlength="2000" aria-label="Dépôts permis, séparés par des virgules"><button type="submit">Régler</button></form>';
      }

      const j = G.journal(moi.id, { limite: 30 });
      h += '<h2>Journal des actions sur GitHub</h2>' + (j.length ? '<table><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Issue</th><th>Résultat</th></tr></thead><tbody>' + j.map((e) =>
        '<tr><td>' + esc(date(e.le)) + '</td><td>' + esc(e.pseudo || '') + ' · <code>' + esc(e.client) + '</code></td><td>' + esc(e.action) + '</td><td>' + esc(e.depot) + (e.numero ? '#' + e.numero : '') + '</td>'
        + '<td' + (e.ok ? '' : ' class="ko"') + '>' + (e.lien ? '<a href="' + esc(e.lien) + '" rel="noopener nofollow">' + esc(e.detail) + '</a>' : esc(e.detail)) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="gh-pale">Aucune action sur GitHub pour l’instant.</p>');
      h += '</div>';
      envoyer(res, moi, 'Issues GitHub — Métis', h, { actif: 'github', fil: [['Métis', '/metis'], ['Issues GitHub', null]] });
    } catch (e) { next(e); }
  });

  router.post('/github/suivre', lire, (req, res) => {
    const moi = garde(req, res); if (!moi) return;
    if (!origineSure(req)) return pasTrouve(res, moi);
    try { const r = G.suivreDepot(moi.id, { project_id: String(req.body.project_id || ''), depot: String(req.body.depot || '') }); retour(res, r.depot + ' est suivi. Synchronisez-le pour importer ses issues.'); }
    catch (e) { retour(res, null, e.message); }
  });
  router.post('/github/synchroniser', lire, async (req, res) => {
    const moi = garde(req, res); if (!moi) return;
    if (!origineSure(req)) return pasTrouve(res, moi);
    try { const r = await G.synchroniser(moi.id, { depot: String(req.body.depot || '') }); retour(res, r.depot + ' : ' + r.lues + ' issue(s) lue(s), ' + r.creees + ' tâche(s) créée(s), ' + r.mises_a_jour + ' mise(s) à jour.'); }
    catch (e) { retour(res, null, e.message); }
  });
  router.post('/github/droits', lire, (req, res) => {
    const moi = garde(req, res); if (!moi) return;
    if (!origineSure(req) || !M().estMaster(moi.id)) return pasTrouve(res, moi);
    try {
      const c = require('../core/comptes').compteParPseudo(String(req.body.pseudo || ''));
      if (!c) throw new Error('Compte inconnu : ' + String(req.body.pseudo || ''));
      const depots = String(req.body.depots || '').split(/[\s,]+/).filter(Boolean);
      const r = G.fixerDroits(moi.id, { compte: c.id, client: String(req.body.client || '').trim(), preset: String(req.body.preset || ''), depots: depots.length ? depots : null });
      retour(res, 'Agent « ' + r.client + ' » de ' + c.pseudo + ' : ' + r.preset + '.');
    } catch (e) { retour(res, null, e.message); }
  });
}

module.exports = { mount };
