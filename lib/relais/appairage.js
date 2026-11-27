'use strict';

// =============================================================================
//  « metis link » : relier l'instance à un compte sur le relais (plagnito.com)
// -----------------------------------------------------------------------------
//  1. L'appareil demande un code au relais (POST /api/chez-soi/appairage).
//  2. Le propriétaire ouvre l'adresse de confirmation, connecté à son compte, lit
//     ce que le relais verra (les échanges passent par lui, il ne les garde pas)
//     et confirme.
//  3. L'appareil, qui interroge le relais, reçoit alors l'identifiant de l'instance
//     et son secret (montré une seule fois) : il les garde dans sa base.
// =============================================================================

const RELAIS_DEFAUT = 'https://plagnito.com';

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS metis_relais (
      cle TEXT PRIMARY KEY CHECK (cle = 'lien'), relais TEXT NOT NULL, instance TEXT NOT NULL, secret TEXT NOT NULL,
      proprietaire_atlas INTEGER NOT NULL, proprietaire_pseudo TEXT NOT NULL, lie_le TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metis_comptes_relayes (
      atlas_id INTEGER PRIMARY KEY, compte INTEGER NOT NULL REFERENCES metis_comptes(id), vu_le TEXT NOT NULL);`);
}

function lien(db) {
  schema(db);
  const r = db.prepare("SELECT * FROM metis_relais WHERE cle = 'lien'").get();
  return r ? { ...r } : null;
}

function oublier(db) { schema(db); return db.prepare("DELETE FROM metis_relais WHERE cle = 'lien'").run().changes === 1; }

async function demander(relais, nom, fetchImpl = fetch) {
  const r = await fetchImpl(relais.replace(/\/+$/, '') + '/api/chez-soi/appairage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nom }), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.code) throw new Error('Le relais refuse l’appairage : ' + (j && j.error ? j.error : 'HTTP ' + r.status));
  return j; // { code, attente, confirmer, expire_le }
}

/** Attend la confirmation ; rend { instance, secret, proprietaire: { atlas_id, pseudo } }. */
async function attendre(relais, attente, { intervalle = 3000, fetchImpl = fetch, signal } = {}) {
  for (;;) {
    if (signal && signal.aborted) throw new Error('Appairage abandonné.');
    const r = await fetchImpl(relais.replace(/\/+$/, '') + '/api/chez-soi/appairage/' + encodeURIComponent(attente), { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (r.status === 404 || (j && j.etat === 'expire')) throw new Error('Le code a expiré sans confirmation. Relancez « metis link ».');
    if (j && j.etat === 'lie') return j;
    await new Promise((ok) => setTimeout(ok, intervalle));
  }
}

function enregistrer(db, relais, r) {
  schema(db);
  db.prepare(`INSERT INTO metis_relais (cle, relais, instance, secret, proprietaire_atlas, proprietaire_pseudo, lie_le) VALUES ('lien', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cle) DO UPDATE SET relais = excluded.relais, instance = excluded.instance, secret = excluded.secret,
      proprietaire_atlas = excluded.proprietaire_atlas, proprietaire_pseudo = excluded.proprietaire_pseudo, lie_le = excluded.lie_le`)
    .run(relais.replace(/\/+$/, ''), r.instance, r.secret, Number(r.proprietaire.atlas_id), String(r.proprietaire.pseudo), new Date().toISOString());
}

/**
 * Le compte local d'une personne relayée. Le propriétaire Atlas qui a relié l'instance
 * est le propriétaire local ; un invité reçoit un compte membre (créé à sa première
 * visite) et le rôle que le propriétaire lui a donné sur le relais.
 */
function compteRelaye(instance, ident) {
  const db = instance.db;
  const l = lien(db);
  if (!l || !ident) return null;
  if (ident.role === 'proprietaire') {
    if (Number(ident.atlas_id) !== Number(l.proprietaire_atlas)) return null;
    const p = instance.proprietaire();
    return p ? { id: p.id, pseudo: p.pseudo } : null;
  }
  if (Number(ident.atlas_id) === Number(l.proprietaire_atlas)) return null; // rôle incohérent : on refuse
  let r = db.prepare('SELECT compte FROM metis_comptes_relayes WHERE atlas_id = ?').get(Number(ident.atlas_id));
  if (!r) {
    const base = String(ident.pseudo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 26) || 'invite';
    let pseudo = base.length >= 2 ? base : 'invite-' + base, n = 1;
    while (instance.comptes.compteParPseudo(pseudo)) pseudo = base.slice(0, 26) + '-' + (++n);
    const c = instance.creerCompte(pseudo, 'membre');
    db.prepare('INSERT INTO metis_comptes_relayes (atlas_id, compte, vu_le) VALUES (?, ?, ?)').run(Number(ident.atlas_id), c.id, new Date().toISOString());
    r = { compte: c.id };
  } else {
    db.prepare('UPDATE metis_comptes_relayes SET vu_le = ? WHERE atlas_id = ?').run(new Date().toISOString(), Number(ident.atlas_id));
  }
  const c = instance.comptes.compte(r.compte);
  if (!c || !c.active) return null;
  // Le rôle suit celui que le propriétaire a fixé sur le relais.
  const M = require('../modules/metisdocs');
  const p = instance.proprietaire();
  const voulu = ident.role === 'editeur' ? 'editeur' : 'lecteur';
  const actuel = M.lecteurs().find((x) => Number(x.id) === c.id);
  if (!actuel || actuel.role !== voulu) M.accorder(p.id, c.pseudo, voulu);
  return { id: c.id, pseudo: c.pseudo };
}

module.exports = { RELAIS_DEFAUT, schema, lien, oublier, demander, attendre, enregistrer, compteRelaye };
