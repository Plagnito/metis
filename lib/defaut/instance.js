'use strict';

// =============================================================================
//  L'instance autonome : un dossier de données, une base SQLite, des comptes
//  locaux et des jetons d'accès. C'est l'hôte de Métis quand rien d'autre (Atlas)
//  ne l'héberge.
//
//  <dossier>/metis.db     la base (WAL) ;
//  <dossier>/metis.verrou le serveur qui la tient (pid) : un SECOND serveur sur la
//                         même base est refusé. Deux processus qui écrivent chacun
//                         leurs caches sur la même base s'effacent en silence.
//
//  Comptes : `metis_comptes` (le premier est le propriétaire). Une vue
//  `player_accounts` lui donne le nom que lisent quelques requêtes héritées
//  d'Atlas (droits de lecture, déclencheurs de politique) ; elle n'est créée
//  que si aucune table de ce nom n'existe.
//
//  Jetons : `metis_jetons`. Seule l'EMPREINTE (SHA-256) est gardée ; le jeton
//  lui-même n'est montré qu'une fois, à sa création. Chaque jeton porte un
//  « client » (claude-code, codex, equipe-ci…) : c'est la clé des limites par
//  agent (metis-app-permissions).
// =============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const host = require('../host');
const contexte = require('./sqlite-context');
const markdown = require('./markdown');

const PSEUDO = /^[\p{L}\p{N}_.-]{2,32}$/u;
const CLIENT = /^[a-z0-9][a-z0-9_.-]{1,47}$/;
const empreinte = (jeton) => crypto.createHash('sha256').update(String(jeton)).digest('hex');

function dossierParDefaut() {
  return process.env.METIS_DONNEES || path.join(os.homedir(), '.metis');
}

// ── Verrou : un seul serveur par dossier de données ──────────────────────────
function vivant(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function verrouiller(dossier) {
  const fichier = path.join(dossier, 'metis.verrou');
  try {
    const autre = Number(JSON.parse(fs.readFileSync(fichier, 'utf8')).pid);
    if (autre && autre !== process.pid && vivant(autre)) {
      throw Object.assign(new Error('Un serveur Métis (pid ' + autre + ') utilise déjà ' + dossier + '. Arrêtez-le, ou choisissez un autre dossier avec --donnees.'), { code: 'METIS_VERROU' });
    }
  } catch (e) { if (e.code === 'METIS_VERROU') throw e; }
  fs.writeFileSync(fichier, JSON.stringify({ pid: process.pid, depuis: new Date().toISOString() }));
  const liberer = () => { try { if (Number(JSON.parse(fs.readFileSync(fichier, 'utf8')).pid) === process.pid) fs.unlinkSync(fichier); } catch { /* déjà parti */ } };
  process.once('exit', liberer);
  return liberer;
}

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS metis_comptes (
      id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('proprietaire','membre')), active INTEGER NOT NULL DEFAULT 1, cree_le TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metis_jetons (
      id TEXT PRIMARY KEY, compte INTEGER NOT NULL REFERENCES metis_comptes(id), client TEXT NOT NULL,
      empreinte TEXT NOT NULL UNIQUE, cree_le TEXT NOT NULL, dernier_usage TEXT, revoque_le TEXT);
    CREATE TABLE IF NOT EXISTS metis_liens (
      empreinte TEXT PRIMARY KEY, compte INTEGER NOT NULL REFERENCES metis_comptes(id), expire_le TEXT NOT NULL, utilise_le TEXT);
    CREATE TABLE IF NOT EXISTS metis_sessions (
      empreinte TEXT PRIMARY KEY, compte INTEGER NOT NULL REFERENCES metis_comptes(id), cree_le TEXT NOT NULL, expire_le TEXT NOT NULL);`);
  const existe = db.prepare("SELECT type FROM sqlite_master WHERE name='player_accounts'").get();
  if (!existe) db.exec(`CREATE VIEW player_accounts AS SELECT id, pseudo, lower(pseudo) AS pseudo_lc, active FROM metis_comptes`);
}

/**
 * Ouvre (ou crée) une instance et configure l'hôte de Métis sur elle.
 * options : dossier, publicUrl, securite, verrou (true par défaut), memoire (tests).
 */
function ouvrir(options = {}) {
  const dossier = options.memoire ? null : path.resolve(options.dossier || dossierParDefaut());
  let liberer = () => {};
  if (dossier) {
    fs.mkdirSync(dossier, { recursive: true });
    if (options.verrou !== false) liberer = verrouiller(dossier);
  }
  const db = new DatabaseSync(dossier ? path.join(dossier, 'metis.db') : ':memory:');
  if (dossier) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  contexte.register(db);
  schema(db);

  const compte = (id) => {
    const r = db.prepare('SELECT id, pseudo, role, active FROM metis_comptes WHERE id = ?').get(Number(id));
    return r ? { ...r } : null;
  };
  const comptes = {
    compte,
    estProprietaire: (c) => !!c && c.role === 'proprietaire' && c.active !== 0,
    compteParPseudo: (pseudo) => {
      const r = db.prepare('SELECT id, pseudo, role, active FROM metis_comptes WHERE pseudo = ?').get(String(pseudo || ''));
      return r ? { ...r } : null;
    },
  };

  const journal = (niveau) => (domaine, message) => { if (niveau !== 'debug' || process.env.METIS_DEBUG) process.stderr.write('[' + niveau + '] ' + domaine + ' : ' + message + '\n'); };

  if (!host.configured()) {
    host.configure({
      db: () => ({ db }),
      sqliteContext: () => contexte,
      logger: () => ({ debug: journal('debug'), info: journal('info'), warn: journal('warn'), error: journal('error') }),
      comptes: () => comptes,
      rendu: () => markdown,
      publicUrl: options.publicUrl || null,
      securite: options.securite || undefined,
    });
  }

  const instance = {
    dossier, db, comptes,
    proprietaire() {
      const r = db.prepare("SELECT id FROM metis_comptes WHERE role = 'proprietaire' ORDER BY id LIMIT 1").get();
      return r ? compte(r.id) : null;
    },
    creerCompte(pseudo, role = 'membre') {
      if (!PSEUDO.test(String(pseudo || ''))) throw new Error('Pseudo : 2 à 32 lettres, chiffres, « _ », « . » ou « - ».');
      if (!['proprietaire', 'membre'].includes(role)) throw new Error('Rôle : proprietaire ou membre.');
      const id = db.prepare('INSERT INTO metis_comptes (pseudo, role, cree_le) VALUES (?, ?, ?)').run(pseudo, role, new Date().toISOString()).lastInsertRowid;
      return compte(id);
    },
    /** Crée un jeton et le rend EN CLAIR, une seule fois. */
    creerJeton(compteId, client = 'agent') {
      if (!CLIENT.test(String(client))) throw new Error('Client : 2 à 48 caractères, minuscules, chiffres, « _ », « . » ou « - ».');
      if (!compte(compteId)) throw new Error('Compte inconnu : ' + compteId);
      const jeton = 'metis_' + crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO metis_jetons (id, compte, client, empreinte, cree_le) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), Number(compteId), client, empreinte(jeton), new Date().toISOString());
      return jeton;
    },
    /** Le compte et le client d'un jeton valide, ou null. */
    verifierJeton(jeton) {
      if (typeof jeton !== 'string' || !/^metis_[A-Za-z0-9_-]{43}$/.test(jeton)) return null;
      const r = db.prepare('SELECT j.id, j.compte, j.client FROM metis_jetons j JOIN metis_comptes c ON c.id = j.compte WHERE j.empreinte = ? AND j.revoque_le IS NULL AND c.active = 1').get(empreinte(jeton));
      if (!r) return null;
      db.prepare('UPDATE metis_jetons SET dernier_usage = ? WHERE id = ?').run(new Date().toISOString(), r.id);
      return { compte: r.compte, client: r.client };
    },
    /** Lien de connexion à usage unique (le code en clair, une seule fois). */
    creerLien(compteId, minutes = 15) {
      if (!compte(compteId)) throw new Error('Compte inconnu : ' + compteId);
      const code = crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO metis_liens (empreinte, compte, expire_le) VALUES (?, ?, ?)').run(empreinte(code), Number(compteId), new Date(Date.now() + minutes * 60e3).toISOString());
      return code;
    },
    /** Consomme un lien : rend le compte s'il est valide, non expiré et jamais utilisé. */
    consommerLien(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) return null;
      const maintenant = new Date().toISOString();
      const r = db.prepare('UPDATE metis_liens SET utilise_le = ? WHERE empreinte = ? AND utilise_le IS NULL AND expire_le > ? RETURNING compte').get(maintenant, empreinte(code), maintenant);
      const c = r && compte(r.compte);
      return c && c.active ? c : null;
    },
    /** Ouvre une session navigateur ; rend la valeur du cookie (en clair, une fois). */
    ouvrirSession(compteId, jours = 30) {
      const valeur = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO metis_sessions (empreinte, compte, cree_le, expire_le) VALUES (?, ?, ?, ?)').run(empreinte(valeur), Number(compteId), new Date().toISOString(), new Date(Date.now() + jours * 86400e3).toISOString());
      return valeur;
    },
    /** Le compte { id, pseudo } d'une session valide, ou null. */
    session(valeur) {
      if (typeof valeur !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(valeur)) return null;
      const r = db.prepare('SELECT c.id, c.pseudo FROM metis_sessions s JOIN metis_comptes c ON c.id = s.compte WHERE s.empreinte = ? AND s.expire_le > ? AND c.active = 1').get(empreinte(valeur), new Date().toISOString());
      return r ? { id: r.id, pseudo: r.pseudo } : null;
    },
    fermerSession(valeur) { db.prepare('DELETE FROM metis_sessions WHERE empreinte = ?').run(empreinte(String(valeur || ''))); },
    jetons() {
      return db.prepare('SELECT j.id, c.pseudo, j.client, j.cree_le, j.dernier_usage, j.revoque_le FROM metis_jetons j JOIN metis_comptes c ON c.id = j.compte ORDER BY j.cree_le').all().map((r) => ({ ...r }));
    },
    revoquerJeton(id) {
      return db.prepare('UPDATE metis_jetons SET revoque_le = ? WHERE id = ? AND revoque_le IS NULL').run(new Date().toISOString(), String(id)).changes === 1;
    },
    fermer() { try { db.close(); } catch { /* déjà fermée */ } liberer(); },
  };
  return instance;
}

module.exports = { ouvrir, dossierParDefaut, empreinte };
