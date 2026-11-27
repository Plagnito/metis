'use strict';

// =============================================================================
//  Le tunnel vers le relais (plagnito.com) — côté appareil
// -----------------------------------------------------------------------------
//  L'appareil APPELLE le relais (connexion sortante : elle traverse la box sans
//  ouvrir de port) et garde la ligne ouverte. Le relais y fait passer les requêtes
//  des personnes et des agents autorisés ; l'appareil les rejoue sur son propre
//  serveur local et renvoie la réponse. Le relais ne garde rien.
//
//  Protocole metis-relais.v1 (messages JSON, un par trame) :
//    relais → appareil  { t:'req', id, methode, chemin, entetes, corps(base64|null), identite }
//    appareil → relais  { t:'res', id, statut, entetes, corps(base64) }
//  L'appareil s'authentifie par le sous-protocole WebSocket « metis-cle.<instance>.<secret> »
//  (un en-tête que tout client WebSocket sait poser, navigateur compris).
//
//  Une requête relayée est rejouée en local avec un SECRET DE PROCESSUS (en mémoire,
//  jamais écrit) : seul ce processus peut marquer une requête comme venue du relais,
//  donc personne sur la machine ne peut se faire passer pour un compte relayé.
// =============================================================================

const crypto = require('node:crypto');

const SECRET_LOCAL = crypto.randomBytes(32).toString('base64url');
const LIMITE_REPONSE = 4 * 1024 * 1024;
const ENTETES_TRANSMIS = ['content-type', 'accept', 'accept-language'];
const ENTETES_RENDUS = ['content-type', 'location', 'cache-control', 'content-disposition'];

/** La requête vient-elle du relais (rejouée par ce processus) ? Rend l'identité relayée, ou null. */
function identiteRelayee(req) {
  const s = req.headers['x-metis-relais'];
  if (typeof s !== 'string' || s.length !== SECRET_LOCAL.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(SECRET_LOCAL))) return null;
  try {
    const i = JSON.parse(Buffer.from(String(req.headers['x-metis-identite'] || ''), 'base64').toString('utf8'));
    if (!i || !Number.isSafeInteger(i.atlas_id) || typeof i.pseudo !== 'string' || !['proprietaire', 'editeur', 'lecteur'].includes(i.role)) return null;
    return { atlas_id: i.atlas_id, pseudo: i.pseudo.slice(0, 40), role: i.role, client: typeof i.client === 'string' ? i.client.slice(0, 100) : null };
  } catch { return null; }
}

/**
 * Ouvre et maintient la ligne. options : relais (https://…), instance, secret, portLocal,
 * journal(texte). Rend { arreter(), etat() }.
 */
function demarrer({ relais, instance, secret, portLocal, journal = () => {} }) {
  const url = String(relais).replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/metis-relais';
  let ws = null, arrete = false, delai = 1000, connecte = false, minuterie = null;

  const rejouer = async (m) => {
    const entetes = { 'x-metis-relais': SECRET_LOCAL, 'x-metis-identite': Buffer.from(JSON.stringify(m.identite || {})).toString('base64') };
    for (const k of ENTETES_TRANSMIS) if (m.entetes && typeof m.entetes[k] === 'string') entetes[k] = m.entetes[k];
    try {
      const r = await fetch('http://127.0.0.1:' + portLocal + m.chemin, {
        method: m.methode, headers: entetes, redirect: 'manual', signal: AbortSignal.timeout(25000),
        body: m.corps && !['GET', 'HEAD'].includes(m.methode) ? Buffer.from(m.corps, 'base64') : undefined,
      });
      const corps = Buffer.from(await r.arrayBuffer());
      if (corps.length > LIMITE_REPONSE) return { statut: 502, entetes: { 'content-type': 'text/plain; charset=utf-8' }, corps: Buffer.from('Réponse trop volumineuse pour le relais.') };
      const rendus = {};
      for (const k of ENTETES_RENDUS) { const v = r.headers.get(k); if (v) rendus[k] = v; }
      return { statut: r.status, entetes: rendus, corps };
    } catch (e) {
      return { statut: 502, entetes: { 'content-type': 'text/plain; charset=utf-8' }, corps: Buffer.from('Instance injoignable en local : ' + e.message) };
    }
  };

  const ouvrir = () => {
    if (arrete) return;
    try { ws = new WebSocket(url, ['metis-relais.v1', 'metis-cle.' + instance + '.' + secret]); }
    catch (e) { journal('relais : ' + e.message); return planifier(); }
    ws.onopen = () => { connecte = true; delai = 1000; journal('relais : ligne ouverte (' + relais + ')'); };
    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.t !== 'req' || typeof m.id !== 'string' || typeof m.chemin !== 'string' || !m.chemin.startsWith('/')) return;
      const r = await rejouer(m);
      try { ws.send(JSON.stringify({ t: 'res', id: m.id, statut: r.statut, entetes: r.entetes, corps: r.corps.toString('base64') })); } catch { /* ligne tombée */ }
    };
    ws.onclose = (ev) => {
      connecte = false;
      if (ev.code === 4001) { journal('relais : refusé (instance inconnue ou secret invalide) — relancez « metis link ».'); arrete = true; return; }
      if (ev.code === 4002) journal('relais : une autre connexion a pris la ligne de cette instance.');
      planifier();
    };
    ws.onerror = () => { /* onclose suit */ };
  };
  const planifier = () => {
    if (arrete) return;
    clearTimeout(minuterie);
    minuterie = setTimeout(ouvrir, delai);
    delai = Math.min(delai * 2, 60000);
  };
  ouvrir();
  return {
    arreter() { arrete = true; clearTimeout(minuterie); try { ws && ws.close(1000); } catch { /* */ } },
    etat: () => ({ connecte, relais, instance }),
  };
}

module.exports = { demarrer, identiteRelayee, SECRET_LOCAL };
