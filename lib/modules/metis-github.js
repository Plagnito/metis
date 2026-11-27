'use strict';

// =============================================================================
//  Issues GitHub dans Métis
// -----------------------------------------------------------------------------
//  Un dépôt GitHub est SUIVI par un projet Métis. La synchronisation importe ses
//  issues (pas les pull requests) et fait de chacune une TÂCHE du projet : les
//  agents et l'équipe la reprennent avec tout ce que les projets savent déjà
//  faire (priorités, sessions, critères, preuves, reprise). Le miroir local garde
//  le lien issue ↔ tâche, l'état, les étiquettes, les assignations et les PR liées.
//
//  Les agents peuvent AGIR sur GitHub (commenter, lier une PR, fermer, rouvrir,
//  étiqueter, assigner, créer une issue), mais chacun dans les limites que le
//  propriétaire lui fixe (table metis_github_droits) :
//    lecture      lire les issues ;
//    contributeur lire, commenter, lier une PR ;
//    mainteneur   tout.
//  Un agent jamais réglé est en LECTURE. Aucun outil MCP ne modifie ces limites :
//  un agent ne s'élève pas lui-même (interface du propriétaire ou « metis agent »).
//  Toute écriture faite sur GitHub, réussie ou refusée par GitHub, est JOURNALISÉE
//  (qui, par quel agent, quelle issue, quel résultat).
//
//  Jeton GitHub : entrée d'hôte `github.jeton()`, sinon METIS_GITHUB_TOKEN ou
//  GITHUB_TOKEN. Sans jeton : dépôts publics en lecture seulement, et toute
//  écriture est refusée en le disant.
// =============================================================================

const crypto = require('node:crypto');
const { db } = require('../core/db');
const H = require('../host');
const M = () => require('./metisdocs');
const P = () => require('./metisprojects');

const ACTIONS = ['lire', 'commenter', 'lier_pr', 'fermer', 'etiqueter', 'assigner', 'creer'];
const PRESETS = {
  lecture: ['lire'],
  contributeur: ['lire', 'commenter', 'lier_pr'],
  mainteneur: [...ACTIONS],
};
const PRESET_DEFAUT = 'lecture';
const CLIENT_SYNCHRO = 'metis-github';
const DEPOT = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/;

let installe = false;
let fetchImpl = (...a) => fetch(...a);
function _fixerFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); }

class ErreurGithub extends Error {
  constructor(code, message, statut = 400) { super(message); this.code = code; this.statut = statut; }
}
const refuser = (code, message, statut) => { throw new ErreurGithub(code, message, statut); };
const maintenant = () => new Date().toISOString();

function init() {
  if (installe) return;
  db.exec(`CREATE TABLE IF NOT EXISTS metis_github_depots (
      depot TEXT PRIMARY KEY, projet TEXT NOT NULL, suivi_par INTEGER NOT NULL, suivi_le TEXT NOT NULL,
      synchro_le TEXT, synchro_message TEXT);
    CREATE TABLE IF NOT EXISTS metis_github_issues (
      depot TEXT NOT NULL, numero INTEGER NOT NULL, titre TEXT NOT NULL, etat TEXT NOT NULL, raison TEXT,
      etiquettes TEXT NOT NULL DEFAULT '[]', assignes TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL, auteur TEXT,
      maj_github TEXT, projet TEXT NOT NULL, tache TEXT, prs TEXT NOT NULL DEFAULT '[]', vu_le TEXT NOT NULL,
      PRIMARY KEY (depot, numero));
    CREATE TABLE IF NOT EXISTS metis_github_droits (
      compte INTEGER NOT NULL, client TEXT NOT NULL, preset TEXT NOT NULL, depots TEXT,
      maj_le TEXT NOT NULL, par INTEGER NOT NULL, PRIMARY KEY (compte, client));
    CREATE TABLE IF NOT EXISTS metis_github_journal (
      id INTEGER PRIMARY KEY, le TEXT NOT NULL, compte INTEGER NOT NULL, client TEXT NOT NULL, action TEXT NOT NULL,
      depot TEXT NOT NULL, numero INTEGER, ok INTEGER NOT NULL, detail TEXT, lien TEXT);
    CREATE TRIGGER IF NOT EXISTS metis_github_journal_fige BEFORE UPDATE ON metis_github_journal
      BEGIN SELECT RAISE(ABORT, 'Journal GitHub immuable'); END;
    CREATE TRIGGER IF NOT EXISTS metis_github_journal_garde BEFORE DELETE ON metis_github_journal
      BEGIN SELECT RAISE(ABORT, 'Journal GitHub immuable'); END;`);
  installe = true;
}

// ── Jeton et appels GitHub ───────────────────────────────────────────────────
function jeton() {
  const c = H.github ? H.github() : {};
  const j = typeof c.jeton === 'function' ? c.jeton() : (process.env.METIS_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
  return String(j || '').trim();
}

async function appelGithub(methode, chemin, corps) {
  const j = jeton();
  const entetes = { Accept: 'application/vnd.github+json', 'User-Agent': 'metis-github', 'X-GitHub-Api-Version': '2022-11-28' };
  if (j) entetes.Authorization = 'Bearer ' + j;
  if (corps !== undefined) entetes['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetchImpl('https://api.github.com' + chemin, { method: methode, headers: entetes, body: corps === undefined ? undefined : JSON.stringify(corps), signal: AbortSignal.timeout(20000) });
  } catch (e) { refuser('GITHUB_INJOIGNABLE', 'GitHub injoignable : ' + e.message, 502); }
  const texte = await r.text();
  let donnees = null; try { donnees = texte ? JSON.parse(texte) : null; } catch { /* texte brut */ }
  if (!r.ok) {
    const raison = donnees && donnees.message ? donnees.message : 'HTTP ' + r.status;
    const code = r.status === 401 ? 'GITHUB_JETON' : r.status === 403 ? 'GITHUB_REFUS' : r.status === 404 ? 'GITHUB_INTROUVABLE' : r.status === 422 ? 'GITHUB_INVALIDE' : 'GITHUB_ERREUR';
    refuser(code, 'GitHub a répondu ' + r.status + ' : ' + raison + (r.status === 404 && !j ? ' (dépôt privé ? aucun jeton GitHub configuré)' : ''), r.status === 401 || r.status === 403 ? 403 : 502);
  }
  return donnees;
}
const cheminDepot = (depot) => '/repos/' + depot.split('/').map(encodeURIComponent).join('/');

// ── Droits des agents ────────────────────────────────────────────────────────
function droits(compte, client) {
  init();
  const r = db.prepare('SELECT preset, depots FROM metis_github_droits WHERE compte = ? AND client = ?').get(Number(compte), String(client || ''));
  const preset = r && PRESETS[r.preset] ? r.preset : PRESET_DEFAUT;
  return { preset, actions: new Set(PRESETS[preset]), depots: r && r.depots ? JSON.parse(r.depots) : null, regle: !!r };
}

/** Le propriétaire fixe les limites GitHub d'un agent (client) d'un compte. */
function fixerDroits(par, { compte, client, preset, depots = null }) {
  init();
  if (!M().estMaster(par)) refuser('PERMISSION_DENIED', 'Seul le propriétaire de l’instance règle les limites des agents.', 403);
  if (!Object.hasOwn(PRESETS, preset)) refuser('INVALID_ARGUMENT', 'preset : ' + Object.keys(PRESETS).join(', ') + '.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(String(client || ''))) refuser('INVALID_ARGUMENT', 'client : identifiant de l’agent attendu.');
  const cible = require('../core/comptes').compte(Number(compte));
  if (!cible) refuser('NOT_FOUND', 'Compte inconnu.', 404);
  let liste = null;
  if (depots != null) {
    if (!Array.isArray(depots) || depots.length > 50 || !depots.every((d) => DEPOT.test(d))) refuser('INVALID_ARGUMENT', 'depots : liste de « compte/dépôt » (au plus 50), ou rien pour tous les dépôts suivis.');
    liste = [...new Set(depots.map((d) => d.toLowerCase()))];
  }
  db.prepare(`INSERT INTO metis_github_droits (compte, client, preset, depots, maj_le, par) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(compte, client) DO UPDATE SET preset = excluded.preset, depots = excluded.depots, maj_le = excluded.maj_le, par = excluded.par`)
    .run(Number(compte), String(client), preset, liste ? JSON.stringify(liste) : null, maintenant(), Number(par));
  return { ok: true, compte: Number(compte), client: String(client), preset, actions: PRESETS[preset], depots: liste };
}

function listeDroits(moi) {
  init();
  if (!M().estMaster(moi)) refuser('PERMISSION_DENIED', 'Réservé au propriétaire de l’instance.', 403);
  return db.prepare('SELECT d.compte, d.client, d.preset, d.depots, d.maj_le, c.pseudo FROM metis_github_droits d LEFT JOIN player_accounts c ON c.id = d.compte ORDER BY d.maj_le DESC').all()
    .map((r) => ({ compte: r.compte, pseudo: r.pseudo, client: r.client, preset: r.preset, actions: PRESETS[r.preset] || [], depots: r.depots ? JSON.parse(r.depots) : null, maj_le: r.maj_le }));
}

// ── Dépôts suivis ────────────────────────────────────────────────────────────
function normaliserDepot(v) {
  const m = DEPOT.exec(String(v || '').trim());
  if (!m) refuser('INVALID_ARGUMENT', 'depot : « compte/dépôt » attendu (ex. mon-equipe/site).');
  return m[1] + '/' + m[2];
}

function projetLisible(moi, projet) {
  try { P().init(); return P().get(moi, projet); } catch { refuser('NOT_FOUND', 'Projet absent ou inaccessible.', 404); }
}

function depotSuivi(moi, depot) {
  init();
  const d = db.prepare('SELECT * FROM metis_github_depots WHERE lower(depot) = lower(?)').get(depot);
  if (!d) refuser('NOT_FOUND', 'Dépôt non suivi : ' + depot + '. github_suivre_depot le rattache à un projet.', 404);
  projetLisible(moi, d.projet);
  return d;
}

function suivreDepot(moi, { project_id, depot }) {
  init();
  if (!M().peutEcrire(moi)) refuser('PERMISSION_DENIED', 'Réservé aux comptes qui peuvent écrire.', 403);
  const nom = normaliserDepot(depot);
  projetLisible(moi, String(project_id || ''));
  db.prepare(`INSERT INTO metis_github_depots (depot, projet, suivi_par, suivi_le) VALUES (?, ?, ?, ?)
    ON CONFLICT(depot) DO UPDATE SET projet = excluded.projet, suivi_par = excluded.suivi_par, suivi_le = excluded.suivi_le`)
    .run(nom, String(project_id), Number(moi), maintenant());
  return { ok: true, depot: nom, project_id: String(project_id) };
}

function depots(moi) {
  init();
  const lisible = (projet) => { try { projetLisible(moi, projet); return true; } catch { return false; } };
  return db.prepare('SELECT * FROM metis_github_depots ORDER BY depot').all().filter((d) => lisible(d.projet)).map((d) => {
    const n = db.prepare("SELECT count(*) n, sum(etat = 'open') ouvertes FROM metis_github_issues WHERE depot = ?").get(d.depot);
    return { depot: d.depot, project_id: d.projet, suivi_le: d.suivi_le, synchro_le: d.synchro_le, synchro_message: d.synchro_message, issues: n.n, ouvertes: n.ouvertes || 0, url: 'https://github.com/' + d.depot };
  });
}

// ── Issues → tâches ──────────────────────────────────────────────────────────
const PRIORITE = (etiquettes) => {
  const e = etiquettes.map((x) => x.toLowerCase());
  if (e.some((x) => /urgent|critical|critique|p0/.test(x))) return 'urgent';
  if (e.some((x) => /bug|security|sécurité|securite|p1|high/.test(x))) return 'high';
  if (e.some((x) => /low|minor|p3/.test(x))) return 'low';
  return 'normal';
};
const nettoyer = (t, max) => String(t || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
const titreTache = (i) => nettoyer('#' + i.number + ' · ' + i.title, 160);
const descriptionTache = (depot, i) => nettoyer('Issue GitHub ' + depot + '#' + i.number + ' : ' + i.html_url
  + (i.labels && i.labels.length ? '\nÉtiquettes : ' + i.labels.map((l) => l.name).join(', ') : '')
  + '\n\n' + (i.body || '(sans description)'), 2000);

function avecIdentite(moi, fn) {
  const J = require('./metis-research-journal'), C = require('./metiscollaboration');
  return J.withIdentity(moi, CLIENT_SYNCHRO, () => {
    try { C.init(); C.call('register_agent', { label: 'Synchronisation GitHub', idempotency_key: 'metis-github-agent-' + moi }, moi); } catch { /* déjà inscrit */ }
    return fn();
  });
}

function ecrireTache(moi, projet, nom, args) {
  const r = P().call(nom, { project_id: projet, expected_revision: P().get(moi, projet).revision, max_tokens: 15000, ...args }, moi);
  if (!r || !r.ok) refuser('PROJET_REFUS', 'Le projet a refusé la tâche : ' + JSON.stringify(r && r.error ? r.error.message || r.error : r).slice(0, 300), 409);
  return r.data;
}

function etatTache(issue) { return issue.state === 'closed' ? (issue.state_reason === 'not_planned' ? 'cancelled' : 'done') : null; }

/** Importe les issues d'un dépôt suivi et en fait des tâches du projet. */
async function synchroniser(moi, { depot }) {
  init();
  if (!M().peutEcrire(moi)) refuser('PERMISSION_DENIED', 'Réservé aux comptes qui peuvent écrire.', 403);
  const d = depotSuivi(moi, normaliserDepot(depot));
  const derniere = d.synchro_le;
  const brut = [];
  for (let page = 1; page <= 10; page++) {
    const lot = await appelGithub('GET', cheminDepot(d.depot) + '/issues?state=all&sort=updated&direction=desc&per_page=100&page=' + page + (derniere ? '&since=' + encodeURIComponent(derniere) : ''));
    if (!Array.isArray(lot) || !lot.length) break;
    brut.push(...lot);
    if (lot.length < 100) break;
  }
  const issues = brut.filter((i) => i && !i.pull_request && Number.isInteger(i.number));
  const bilan = { ok: true, depot: d.depot, project_id: d.projet, lues: issues.length, creees: 0, mises_a_jour: 0, fermees: 0, sans_tache: 0, erreurs: [] };
  avecIdentite(moi, () => {
    for (const i of issues.sort((a, b) => a.number - b.number)) {
      const avant = db.prepare('SELECT * FROM metis_github_issues WHERE depot = ? AND numero = ?').get(d.depot, i.number);
      const etiquettes = (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
      const assignes = (i.assignees || []).map((a) => a.login).filter(Boolean);
      let tache = avant && avant.tache;
      const fin = etatTache(i);
      if (!tache && i.state === 'open') {
        // Une issue qui n'obtient pas sa tâche (projet plein : 200 tâches au plus) reste dans le
        // miroir, et le bilan le dit ; la synchronisation continue avec les suivantes.
        try {
          tache = ecrireTache(moi, d.projet, 'projets_tache_creer', { title: titreTache(i), description: descriptionTache(d.depot, i), state: 'ready', priority: PRIORITE(etiquettes), assignee: nettoyer(assignes.join(', '), 80), idempotency_key: 'gh-' + d.depot + '-' + i.number }).task.id;
          bilan.creees++;
        } catch (e) {
          if (!(e instanceof ErreurGithub)) throw e;
          bilan.sans_tache++;
          if (bilan.erreurs.length < 5) bilan.erreurs.push('#' + i.number + ' : ' + e.message.slice(0, 200));
        }
      } else if (tache) {
        const courante = JSON.parse(P().get(moi, d.projet).data).tasks.find((t) => t.id === tache);
        if (courante) {
          const champs = { title: titreTache(i), priority: PRIORITE(etiquettes), assignee: nettoyer(assignes.join(', '), 80) };
          if (fin && !['done', 'cancelled'].includes(courante.state)) { champs.state = fin; if (fin === 'done') champs.outcome = 'Issue fermée sur GitHub (' + (i.state_reason || 'completed') + ').'; bilan.fermees++; }
          if (!fin && ['done', 'cancelled'].includes(courante.state)) champs.state = 'ready';
          const change = Object.entries(champs).some(([k, v]) => courante[k] !== v);
          if (change) { ecrireTache(moi, d.projet, 'projets_tache_modifier', { task_id: tache, ...champs, idempotency_key: 'gh-' + d.depot + '-' + i.number + '-' + crypto.createHash('sha256').update(JSON.stringify(champs)).digest('hex').slice(0, 16) }); bilan.mises_a_jour++; }
        }
      }
      db.prepare(`INSERT INTO metis_github_issues (depot, numero, titre, etat, raison, etiquettes, assignes, url, auteur, maj_github, projet, tache, vu_le)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(depot, numero) DO UPDATE SET titre = excluded.titre, etat = excluded.etat, raison = excluded.raison, etiquettes = excluded.etiquettes,
          assignes = excluded.assignes, url = excluded.url, maj_github = excluded.maj_github, projet = excluded.projet, tache = COALESCE(excluded.tache, metis_github_issues.tache), vu_le = excluded.vu_le`)
        .run(d.depot, i.number, nettoyer(i.title, 300), i.state, i.state_reason || null, JSON.stringify(etiquettes), JSON.stringify(assignes), String(i.html_url || ''), i.user ? i.user.login : null, i.updated_at || null, d.projet, tache || null, maintenant());
    }
  });
  db.prepare('UPDATE metis_github_depots SET synchro_le = ?, synchro_message = ? WHERE depot = ?').run(maintenant(), bilan.lues + ' issue(s) lue(s)' + (bilan.sans_tache ? ', ' + bilan.sans_tache + ' sans tâche (projet plein ?)' : ''), d.depot);
  return bilan;
}

function issues(moi, { depot = null, etat = null, limite = 100 } = {}) {
  init();
  const lignes = (depot ? [depotSuivi(moi, normaliserDepot(depot))] : depots(moi).map((x) => ({ depot: x.depot })))
    .flatMap((d) => db.prepare('SELECT * FROM metis_github_issues WHERE depot = ?' + (etat ? ' AND etat = ?' : '') + ' ORDER BY numero DESC').all(...[d.depot, ...(etat ? [etat] : [])]));
  return lignes.slice(0, Math.max(1, Math.min(500, Number(limite) || 100))).map((r) => ({
    depot: r.depot, numero: r.numero, titre: r.titre, etat: r.etat, raison: r.raison, etiquettes: JSON.parse(r.etiquettes),
    assignes: JSON.parse(r.assignes), url: r.url, auteur: r.auteur, maj_github: r.maj_github, project_id: r.projet, task_id: r.tache, prs: JSON.parse(r.prs),
  }));
}

// ── Actions des agents sur GitHub ────────────────────────────────────────────
function autoriser(moi, client, action, depot) {
  if (!M().peutLire(moi)) refuser('PERMISSION_DENIED', 'Accès Métis requis.', 403);
  if (action !== 'lire' && !M().peutEcrire(moi)) refuser('PERMISSION_DENIED', 'Ce compte ne peut que lire.', 403);
  const d = depotSuivi(moi, normaliserDepot(depot));
  const dr = droits(moi, client);
  if (!dr.actions.has(action)) refuser('AGENT_LIMITE', 'Limite de cet agent (« ' + client + ' », préréglage ' + dr.preset + ') : l’action « ' + action + ' » n’est pas permise. Le propriétaire peut l’élargir dans Issues GitHub.', 403);
  if (dr.depots && !dr.depots.includes(d.depot.toLowerCase())) refuser('AGENT_LIMITE', 'Limite de cet agent : le dépôt ' + d.depot + ' ne lui est pas ouvert.', 403);
  if (action !== 'lire' && !jeton()) refuser('GITHUB_JETON', 'Aucun jeton GitHub configuré : écrire sur GitHub est impossible (METIS_GITHUB_TOKEN).', 403);
  return d;
}

function journaliser(moi, client, action, depot, numero, ok, detail, lien) {
  db.prepare('INSERT INTO metis_github_journal (le, compte, client, action, depot, numero, ok, detail, lien) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(maintenant(), Number(moi), String(client), action, depot, numero == null ? null : Number(numero), ok ? 1 : 0, nettoyer(detail, 500), lien || null);
}

async function agir(moi, client, action, depot, numero, fn) {
  const d = autoriser(moi, client, action, depot);
  try {
    const r = await fn(d);
    journaliser(moi, client, action, d.depot, numero ?? r.numero, true, r.detail, r.lien);
    return { ok: true, depot: d.depot, ...r };
  } catch (e) {
    if (e instanceof ErreurGithub && /^GITHUB_/.test(e.code)) journaliser(moi, client, action, d.depot, numero, false, e.message, null);
    throw e;
  }
}

const numeroValide = (n) => { if (!Number.isInteger(n) || n < 1) refuser('INVALID_ARGUMENT', 'numero : numéro d’issue attendu.'); return n; };
const texteValide = (t, champ, max = 20000) => { const v = nettoyer(t, max + 1).trim(); if (!v || v.length > max) refuser('INVALID_ARGUMENT', champ + ' : texte de 1 à ' + max + ' caractères.'); return v; };
const listeNoms = (l, champ) => { if (!Array.isArray(l) || l.length > 20 || !l.every((x) => typeof x === 'string' && x.trim() && x.length <= 100)) refuser('INVALID_ARGUMENT', champ + ' : liste de noms (au plus 20).'); return l.map((x) => x.trim()); };

function majMiroir(depot, i) {
  if (!i || !Number.isInteger(i.number)) return;
  db.prepare('UPDATE metis_github_issues SET etat = ?, raison = ?, etiquettes = ?, assignes = ?, maj_github = ?, vu_le = ? WHERE depot = ? AND numero = ?')
    .run(i.state, i.state_reason || null, JSON.stringify((i.labels || []).map((l) => (typeof l === 'string' ? l : l.name))), JSON.stringify((i.assignees || []).map((a) => a.login)), i.updated_at || null, maintenant(), depot, i.number);
}

async function lireIssue(moi, client, { depot, numero }) {
  const d = autoriser(moi, client, 'lire', depot);
  numeroValide(numero);
  const i = await appelGithub('GET', cheminDepot(d.depot) + '/issues/' + numero);
  const commentaires = await appelGithub('GET', cheminDepot(d.depot) + '/issues/' + numero + '/comments?per_page=50');
  const local = db.prepare('SELECT projet, tache, prs FROM metis_github_issues WHERE depot = ? AND numero = ?').get(d.depot, numero);
  return { ok: true, depot: d.depot, numero, titre: i.title, etat: i.state, raison: i.state_reason || null, url: i.html_url, auteur: i.user && i.user.login,
    etiquettes: (i.labels || []).map((l) => l.name), assignes: (i.assignees || []).map((a) => a.login), corps: nettoyer(i.body, 20000),
    commentaires: (commentaires || []).map((c) => ({ auteur: c.user && c.user.login, le: c.created_at, texte: nettoyer(c.body, 4000), url: c.html_url })),
    project_id: local ? local.projet : d.projet, task_id: local ? local.tache : null, prs: local ? JSON.parse(local.prs) : [], content_trust: 'untrusted_data' };
}

const commenter = (moi, client, { depot, numero, texte }) => agir(moi, client, 'commenter', depot, numero, async (d) => {
  numeroValide(numero);
  const c = await appelGithub('POST', cheminDepot(d.depot) + '/issues/' + numero + '/comments', { body: texteValide(texte, 'texte') });
  return { numero, detail: 'Commentaire publié', lien: c && c.html_url };
});

const lierPr = (moi, client, { depot, numero, pr_url, texte }) => agir(moi, client, 'lier_pr', depot, numero, async (d) => {
  numeroValide(numero);
  const url = String(pr_url || '');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)) refuser('INVALID_ARGUMENT', 'pr_url : adresse d’une pull request GitHub attendue.');
  const c = await appelGithub('POST', cheminDepot(d.depot) + '/issues/' + numero + '/comments', { body: (texte ? texteValide(texte, 'texte', 4000) + '\n\n' : '') + 'Proposition de correction : ' + url });
  const r = db.prepare('SELECT prs FROM metis_github_issues WHERE depot = ? AND numero = ?').get(d.depot, numero);
  if (r) db.prepare('UPDATE metis_github_issues SET prs = ? WHERE depot = ? AND numero = ?').run(JSON.stringify([...new Set([...JSON.parse(r.prs), url])]), d.depot, numero);
  return { numero, detail: 'PR liée : ' + url, lien: c && c.html_url };
});

async function changerEtat(moi, client, action, { depot, numero, raison, texte }, etat) {
  return agir(moi, client, 'fermer', depot, numero, async (d) => {
    numeroValide(numero);
    if (texte) await appelGithub('POST', cheminDepot(d.depot) + '/issues/' + numero + '/comments', { body: texteValide(texte, 'texte', 4000) });
    const corps = { state: etat };
    if (etat === 'closed') corps.state_reason = raison === 'not_planned' ? 'not_planned' : 'completed';
    const i = await appelGithub('PATCH', cheminDepot(d.depot) + '/issues/' + numero, corps);
    majMiroir(d.depot, i);
    // La tâche liée suit l'issue.
    const l = db.prepare('SELECT projet, tache FROM metis_github_issues WHERE depot = ? AND numero = ?').get(d.depot, numero);
    if (l && l.tache) {
      avecIdentite(moi, () => {
        const fin = etat === 'closed' ? (corps.state_reason === 'not_planned' ? 'cancelled' : 'done') : 'ready';
        ecrireTache(moi, l.projet, 'projets_tache_modifier', { task_id: l.tache, state: fin, ...(fin === 'done' ? { outcome: 'Issue fermée sur GitHub par un agent (' + client + ').' } : {}), idempotency_key: 'gh-' + d.depot + '-' + numero + '-' + action + '-' + Date.now() });
      });
    }
    return { numero, detail: etat === 'closed' ? 'Issue fermée (' + corps.state_reason + ')' : 'Issue rouverte', lien: i && i.html_url, etat: i && i.state };
  });
}
const fermer = (moi, client, a) => changerEtat(moi, client, 'fermer', a, 'closed');
const rouvrir = (moi, client, a) => changerEtat(moi, client, 'rouvrir', a, 'open');

const etiqueter = (moi, client, { depot, numero, ajouter = [], retirer = [] }) => agir(moi, client, 'etiqueter', depot, numero, async (d) => {
  numeroValide(numero);
  const plus = listeNoms(ajouter, 'ajouter'), moins = listeNoms(retirer, 'retirer');
  if (!plus.length && !moins.length) refuser('INVALID_ARGUMENT', 'ajouter ou retirer : au moins une étiquette.');
  if (plus.length) await appelGithub('POST', cheminDepot(d.depot) + '/issues/' + numero + '/labels', { labels: plus });
  for (const e of moins) { try { await appelGithub('DELETE', cheminDepot(d.depot) + '/issues/' + numero + '/labels/' + encodeURIComponent(e)); } catch (err) { if (err.code !== 'GITHUB_INTROUVABLE') throw err; } }
  majMiroir(d.depot, await appelGithub('GET', cheminDepot(d.depot) + '/issues/' + numero));
  return { numero, detail: 'Étiquettes' + (plus.length ? ' + ' + plus.join(', ') : '') + (moins.length ? ' − ' + moins.join(', ') : '') };
});

const assigner = (moi, client, { depot, numero, ajouter = [], retirer = [] }) => agir(moi, client, 'assigner', depot, numero, async (d) => {
  numeroValide(numero);
  const plus = listeNoms(ajouter, 'ajouter'), moins = listeNoms(retirer, 'retirer');
  if (!plus.length && !moins.length) refuser('INVALID_ARGUMENT', 'ajouter ou retirer : au moins une personne.');
  if (plus.length) await appelGithub('POST', cheminDepot(d.depot) + '/issues/' + numero + '/assignees', { assignees: plus });
  if (moins.length) await appelGithub('DELETE', cheminDepot(d.depot) + '/issues/' + numero + '/assignees', { assignees: moins });
  majMiroir(d.depot, await appelGithub('GET', cheminDepot(d.depot) + '/issues/' + numero));
  return { numero, detail: 'Assignations' + (plus.length ? ' + ' + plus.join(', ') : '') + (moins.length ? ' − ' + moins.join(', ') : '') };
});

const creerIssue = (moi, client, { depot, titre, texte = '', etiquettes = [] }) => agir(moi, client, 'creer', depot, null, async (d) => {
  const i = await appelGithub('POST', cheminDepot(d.depot) + '/issues', { title: texteValide(titre, 'titre', 256), body: texte ? texteValide(texte, 'texte') : '', ...(etiquettes.length ? { labels: listeNoms(etiquettes, 'etiquettes') } : {}) });
  return { numero: i.number, detail: 'Issue créée : ' + i.title, lien: i.html_url };
});

function journal(moi, { limite = 50, depot = null } = {}) {
  init();
  if (!M().peutLire(moi)) refuser('PERMISSION_DENIED', 'Accès Métis requis.', 403);
  const suivis = new Set(depots(moi).map((d) => d.depot));
  return db.prepare('SELECT j.*, c.pseudo FROM metis_github_journal j LEFT JOIN player_accounts c ON c.id = j.compte' + (depot ? ' WHERE j.depot = ?' : '') + ' ORDER BY j.id DESC LIMIT ?')
    .all(...[...(depot ? [normaliserDepot(depot)] : []), Math.max(1, Math.min(500, Number(limite) || 50))])
    .filter((r) => suivis.has(r.depot))
    .map((r) => ({ le: r.le, pseudo: r.pseudo, client: r.client, action: r.action, depot: r.depot, numero: r.numero, ok: !!r.ok, detail: r.detail, lien: r.lien }));
}

module.exports = {
  ACTIONS, PRESETS, PRESET_DEFAUT, ErreurGithub, init, droits, fixerDroits, listeDroits,
  suivreDepot, depots, synchroniser, issues, lireIssue, commenter, lierPr, fermer, rouvrir, etiqueter, assigner, creerIssue, journal,
  jetonConfigure: () => !!jeton(), _fixerFetch,
};
