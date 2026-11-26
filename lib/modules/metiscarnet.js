'use strict';

// Carnet des petites choses à faire : une liste commune à Métis, où le propriétaire note ce qui
// traîne (bug, amélioration…) et où un agent sans consigne vient chercher du travail.
// Volontairement plus simple que les projets : pas de dépendances, pas de planning.
// Cycle : a_faire → en_cours (un agent la prend) → terminee → archivée 7 jours plus tard.
const { db } = require('../core/db');

const TYPES = ['bug', 'amelioration', 'nouveaute', 'maintenance', 'documentation', 'securite', 'idee'];
const ETATS = ['a_faire', 'en_cours', 'terminee'];
const PRIORITES = ['haute', 'normale', 'basse'];
const LIBELLES = {
  bug: 'Bug', amelioration: 'Amélioration', nouveaute: 'Nouveauté', maintenance: 'Maintenance', documentation: 'Documentation', securite: 'Sécurité', idee: 'Idée',
  a_faire: 'À faire', en_cours: 'En cours', terminee: 'Terminée', haute: 'Haute', normale: 'Normale', basse: 'Basse',
};
// Proposés en un clic dans le formulaire ; tout autre nom de dépôt reste accepté.
// Fournis par l'hôte : chaque instance a les siens (liste vide par défaut).
const DEPOTS_CONNUS = require('../host').depotsConnus();
const DELAI_ARCHIVE_JOURS = 7;
const JOUR = 86400000;

class CarnetError extends Error { constructor(code, message) { super(message); this.code = code; } }
const echec = (code, message) => { throw new CarnetError(code, message); };
const M = () => require('./metisdocs');

let pret = false;
function init() {
  if (pret) return;
  db.exec(`CREATE TABLE IF NOT EXISTS metis_carnet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titre TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL, depots TEXT NOT NULL DEFAULT '[]', priorite TEXT NOT NULL DEFAULT 'normale',
    etat TEXT NOT NULL DEFAULT 'a_faire',
    agent TEXT, agent_client TEXT, pris_le TEXT, termine_le TEXT, resultat TEXT NOT NULL DEFAULT '',
    archive_le TEXT,
    cree_par INTEGER, cree_par_nom TEXT NOT NULL DEFAULT '', cree_le TEXT NOT NULL, maj_le TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS idx_metis_carnet_etat ON metis_carnet(archive_le, etat, id);`);
  pret = true;
}

const iso = (t) => new Date(t).toISOString();
let maintenant = () => Date.now(); // remplaçable par les tests (_horloge)
const horloge = () => maintenant();

function texte(v, champ, max, requis = true) {
  if (v === undefined || v === null) { if (requis) echec('INVALID_ARGUMENT', champ + ' : requis.'); return ''; }
  if (typeof v !== 'string') echec('INVALID_ARGUMENT', champ + ' : texte attendu.');
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (requis && !s) echec('INVALID_ARGUMENT', champ + ' : ne peut pas être vide.');
  if (s.length > max) echec('INVALID_ARGUMENT', champ + ' : au plus ' + max + ' caractères.');
  return s;
}
function choix(v, valeurs, champ) {
  if (!valeurs.includes(v)) echec('INVALID_ARGUMENT', champ + ' : valeur attendue parmi ' + valeurs.join(', ') + '.');
  return v;
}
/** Accepte un tableau ou une chaîne « atlas, comet » ; rend des noms dédoublonnés. */
function depots(v) {
  if (v === undefined || v === null) return [];
  const liste = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : echec('INVALID_ARGUMENT', 'depots : liste attendue.');
  const vus = new Map();
  for (const brut of liste) {
    if (typeof brut !== 'string') echec('INVALID_ARGUMENT', 'depots : noms de dépôts attendus.');
    const nom = brut.trim().replace(/^.*\//, '').replace(/\.git$/, '');
    if (!nom) continue;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(nom)) echec('INVALID_ARGUMENT', 'depots : « ' + nom.slice(0, 40) + ' » n’est pas un nom de dépôt.');
    if (!vus.has(nom.toLowerCase())) vus.set(nom.toLowerCase(), nom);
  }
  if (vus.size > 12) echec('INVALID_ARGUMENT', 'depots : au plus 12 dépôts.');
  return [...vus.values()];
}

/** Passe aux archives ce qui est terminé depuis au moins 7 jours. Appelé à chaque lecture. */
function archiver(maintenant = horloge()) {
  init();
  const limite = iso(maintenant - DELAI_ARCHIVE_JOURS * JOUR);
  return db.prepare("UPDATE metis_carnet SET archive_le=?, revision=revision+1 WHERE archive_le IS NULL AND etat='terminee' AND termine_le<=?").run(iso(maintenant), limite).changes;
}

function forme(r, maintenant = horloge()) {
  if (!r) return null;
  const archiveDans = r.etat === 'terminee' && !r.archive_le && r.termine_le
    ? Math.max(0, Math.ceil((Date.parse(r.termine_le) + DELAI_ARCHIVE_JOURS * JOUR - maintenant) / JOUR)) : null;
  return {
    id: r.id, titre: r.titre, detail: r.detail, type: r.type, depots: JSON.parse(r.depots), priorite: r.priorite,
    etat: r.archive_le ? 'archivee' : r.etat, agent: r.agent || null, pris_le: r.pris_le, termine_le: r.termine_le,
    resultat: r.resultat || '', archive_le: r.archive_le, archive_dans_jours: archiveDans,
    cree_par: r.cree_par_nom, cree_le: r.cree_le, maj_le: r.maj_le, revision: r.revision,
    lien: require('../host').publicUrl() + '/metis/carnet#tache-' + r.id,
  };
}
const ligne = (id) => db.prepare('SELECT * FROM metis_carnet WHERE id=?').get(id);
function idDe(v) {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) echec('INVALID_ARGUMENT', 'id : numéro de tâche attendu.');
  return n;
}
function trouver(id) {
  const r = ligne(idDe(id));
  if (!r) echec('NOT_FOUND', 'Tâche ' + id + ' absente du carnet.');
  return r;
}
function exigerLecture(user) { if (!M().peutLire(user)) echec('PERMISSION_DENIED', 'Accès Métis requis.'); init(); archiver(); }
function exigerEcriture(user) { exigerLecture(user); if (!M().peutEcrire(user)) echec('PERMISSION_DENIED', 'Écriture Métis requise.'); }
function nomDe(user) {
  try { const p = require('../core/comptes').compte(Number(user)); if (p && p.pseudo) return p.pseudo; } catch { /* base sans joueurs */ }
  return 'compte ' + user;
}

// ── Lecture ────────────────────────────────────────────────────────────────
const ORDRE_PRIO = "CASE priorite WHEN 'haute' THEN 0 WHEN 'normale' THEN 1 ELSE 2 END";
function lister(user, f = {}) {
  exigerLecture(user);
  const archives = f.archives === true || f.archives === '1' || f.archives === 'true';
  const conditions = [archives ? 'archive_le IS NOT NULL' : 'archive_le IS NULL'], params = [];
  if (f.etat !== undefined && f.etat !== '' && !archives) { conditions.push('etat=?'); params.push(choix(f.etat, ETATS, 'etat')); }
  if (f.type !== undefined && f.type !== '') { conditions.push('type=?'); params.push(choix(f.type, TYPES, 'type')); }
  if (f.depot !== undefined && f.depot !== '') {
    const [d] = depots([texte(f.depot, 'depot', 80)]);
    conditions.push('EXISTS (SELECT 1 FROM json_each(depots) WHERE lower(value)=lower(?))'); params.push(d);
  }
  const ordre = archives ? 'archive_le DESC, id DESC' : "CASE etat WHEN 'en_cours' THEN 0 WHEN 'a_faire' THEN 1 ELSE 2 END, " + ORDRE_PRIO + ', id';
  const limite = f.limite === undefined ? 200 : Number(f.limite);
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > 500) echec('INVALID_ARGUMENT', 'limite : entre 1 et 500.');
  const rows = db.prepare('SELECT * FROM metis_carnet WHERE ' + conditions.join(' AND ') + ' ORDER BY ' + ordre + ' LIMIT ?').all(...params, limite);
  const now = horloge();
  return rows.map((r) => forme(r, now));
}
function compter(user) {
  exigerLecture(user);
  const c = { a_faire: 0, en_cours: 0, terminee: 0, archivee: 0 };
  for (const r of db.prepare('SELECT CASE WHEN archive_le IS NULL THEN etat ELSE \'archivee\' END e, count(*) n FROM metis_carnet GROUP BY e').all()) c[r.e] = r.n;
  return c;
}
function lire(user, id) { exigerLecture(user); return forme(trouver(id)); }
/** Les dépôts déjà cités (les plus fréquents d'abord), puis les dépôts connus. */
function depotsProposes(user) {
  exigerLecture(user);
  const cites = db.prepare('SELECT value nom, count(*) n FROM metis_carnet, json_each(depots) GROUP BY lower(value) ORDER BY n DESC, value').all().map((r) => r.nom);
  const vus = new Set(cites.map((x) => x.toLowerCase()));
  return [...cites, ...DEPOTS_CONNUS.filter((x) => !vus.has(x.toLowerCase()))];
}

// ── Écriture ───────────────────────────────────────────────────────────────
function ajouter(user, a) {
  exigerEcriture(user);
  const titre = texte(a.titre, 'titre', 200), detail = texte(a.detail, 'detail', 4000, false);
  const type = choix(a.type, TYPES, 'type'), priorite = choix(a.priorite ?? 'normale', PRIORITES, 'priorite');
  const liste = depots(a.depots);
  if (db.prepare('SELECT count(*) n FROM metis_carnet WHERE archive_le IS NULL').get().n >= 1000) echec('RESOURCE_EXHAUSTED', 'Carnet plein (1000 tâches ouvertes).');
  const t = iso(horloge());
  const id = Number(db.prepare('INSERT INTO metis_carnet(titre,detail,type,depots,priorite,etat,cree_par,cree_par_nom,cree_le,maj_le) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(titre, detail, type, JSON.stringify(liste), priorite, 'a_faire', Number(user), texte(a.auteur, 'auteur', 80, false) || nomDe(user), t, t).lastInsertRowid);
  return forme(ligne(id));
}
function verifierRevision(r, a) {
  if (a.revision !== undefined && a.revision !== null && Number(a.revision) !== r.revision)
    echec('REVISION_CONFLICT', 'La tâche ' + r.id + ' a changé (révision ' + r.revision + ') ; la relire avant de recommencer.');
}
/** Un agent prend la tâche. Refusé si un autre agent l'a déjà : deux agents ne font pas le même travail. */
function prendre(user, a) {
  exigerEcriture(user);
  const r = trouver(a.id);
  if (r.archive_le) echec('FAILED_PRECONDITION', 'Tâche archivée : la rouvrir d’abord.');
  const agent = texte(a.agent, 'agent', 120), client = clientCourant();
  if (r.etat === 'en_cours') {
    if (r.agent === agent) return forme(r); // rejeu : déjà à lui
    echec('ALREADY_CLAIMED', 'Déjà en cours par « ' + r.agent + ' » depuis le ' + r.pris_le + '. Choisir une autre tâche.');
  }
  if (r.etat === 'terminee') echec('FAILED_PRECONDITION', 'Tâche déjà terminée.');
  verifierRevision(r, a);
  const t = iso(horloge());
  const n = db.prepare("UPDATE metis_carnet SET etat='en_cours', agent=?, agent_client=?, pris_le=?, maj_le=?, revision=revision+1 WHERE id=? AND etat='a_faire' AND archive_le IS NULL")
    .run(agent, client, t, t, r.id).changes;
  if (!n) echec('ALREADY_CLAIMED', 'Tâche prise entre-temps ; la relire.');
  return forme(ligne(r.id));
}
function terminer(user, a) {
  exigerEcriture(user);
  const r = trouver(a.id);
  if (r.archive_le) echec('FAILED_PRECONDITION', 'Tâche déjà archivée.');
  if (r.etat === 'terminee') return forme(r);
  verifierRevision(r, a);
  const resultat = texte(a.resultat, 'resultat', 4000, a.depuis_web !== true);
  const agent = a.agent === undefined ? r.agent : texte(a.agent, 'agent', 120);
  const t = iso(horloge());
  db.prepare("UPDATE metis_carnet SET etat='terminee', agent=?, termine_le=?, resultat=?, maj_le=?, revision=revision+1 WHERE id=?").run(agent || null, t, resultat, t, r.id);
  return forme(ligne(r.id));
}
/** Remet la tâche « à faire » : un agent qui abandonne, ou une tâche terminée/archivée qu'on rouvre. */
function relacher(user, a) {
  exigerEcriture(user);
  const r = trouver(a.id);
  if (r.etat === 'a_faire' && !r.archive_le) return forme(r);
  verifierRevision(r, a);
  const motif = texte(a.motif, 'motif', 1000, false);
  const t = iso(horloge());
  const resultat = motif ? (r.resultat ? r.resultat + '\n\n' : '') + 'Remise à faire : ' + motif : r.resultat;
  db.prepare("UPDATE metis_carnet SET etat='a_faire', agent=NULL, agent_client=NULL, pris_le=NULL, termine_le=NULL, archive_le=NULL, resultat=?, maj_le=?, revision=revision+1 WHERE id=?").run(resultat, t, r.id);
  return forme(ligne(r.id));
}
/** Corriger une tâche, TANT QU'ELLE N'EST PAS COMMENCÉE (carnet n° 29). Une fois prise, un
 *  agent travaille d'après ce qu'il a lu : changer le texte sous lui ferait livrer autre chose
 *  que ce qui est écrit. Pour la changer quand même : la remettre à faire, puis la modifier. */
function modifier(user, a) {
  exigerEcriture(user);
  const r = trouver(a.id);
  if (r.archive_le || r.etat !== 'a_faire')
    echec('FAILED_PRECONDITION', 'La tâche ' + r.id + ' est déjà ' + (r.etat === 'en_cours' ? 'en cours' : 'terminée') + ' : on ne la modifie plus. La remettre à faire d’abord.');
  verifierRevision(r, a);
  const champs = {};
  if (a.titre !== undefined) champs.titre = texte(a.titre, 'titre', 200);
  if (a.detail !== undefined) champs.detail = texte(a.detail, 'detail', 4000, false);
  if (a.type !== undefined) champs.type = choix(a.type, TYPES, 'type');
  if (a.priorite !== undefined) champs.priorite = choix(a.priorite, PRIORITES, 'priorite');
  if (a.depots !== undefined) champs.depots = JSON.stringify(depots(a.depots));
  if (!Object.keys(champs).length) return forme(r);
  champs.maj_le = iso(horloge());
  db.prepare('UPDATE metis_carnet SET ' + Object.keys(champs).map((k) => k + '=?').join(', ') + ', revision=revision+1 WHERE id=?').run(...Object.values(champs), r.id);
  return forme(ligne(r.id));
}
/** Réservé à Master, depuis la page : effacer une entrée notée par erreur. Les agents n'ont pas cet outil. */
function supprimer(user, id) {
  exigerEcriture(user);
  if (!M().estMaster(user)) echec('PERMISSION_DENIED', 'Suppression réservée à Master.');
  const r = trouver(id);
  db.prepare('DELETE FROM metis_carnet WHERE id=?').run(r.id);
  return { id: r.id, supprimee: true };
}
function clientCourant() {
  try { const i = require('../core/sqlite-context').identity(); return i && i.client ? String(i.client).slice(0, 200) : null; } catch { return null; }
}

module.exports = {
  init, archiver, lister, compter, lire, depotsProposes, ajouter, prendre, terminer, relacher, modifier, supprimer,
  TYPES, ETATS, PRIORITES, LIBELLES, DEPOTS_CONNUS, DELAI_ARCHIVE_JOURS, CarnetError,
  _horloge: (fn) => { maintenant = fn || (() => Date.now()); },
};
