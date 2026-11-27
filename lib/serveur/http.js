'use strict';

// =============================================================================
//  Le serveur HTTP de « metis serve » (node:http, sans dépendance)
// -----------------------------------------------------------------------------
//  POST /mcp          le serveur MCP (jeton « Authorization: Bearer metis_… »)
//  GET  /metis/…      l'interface : publications, glossaire, graphiques, recherche,
//                     carnet, projets (le même routeur que dans Atlas)
//  GET  /connexion    ouvre une session avec un lien à usage unique (metis lien)
//  POST /deconnexion  ferme la session
//  GET  /healthz      { ok, version } pour les superviseurs
//
//  Écoute 127.0.0.1 par défaut : l'instance n'est joignable que depuis la machine.
//  L'ouvrir au réseau est un choix explicite (--hote 0.0.0.0) ; l'accès distant
//  prévu passe par le relais, pas par un port ouvert.
// =============================================================================

const http = require('node:http');
const { traiter } = require('./mcp');
const { routeur, formulaire, origineSure } = require('./routeur');
const PAQUET = require('../../package.json');

const LIMITE = 1024 * 1024;
const COOKIE = 'metis_session';
const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Les pages se lisent sans JavaScript ; leur seul script est servi par l'instance.
const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function lireCorps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = []; let taille = 0;
    req.on('data', (c) => {
      taille += c.length;
      if (taille > LIMITE) { reject(Object.assign(new Error('trop gros'), { code: 'TROP_GROS' })); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(morceaux)));
    req.on('error', reject);
  });
}

function json(res, statut, corps, entetes = {}) {
  const texte = JSON.stringify(corps);
  res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texte), 'Cache-Control': 'no-store', ...entetes });
  res.end(texte);
}

function cookieDe(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function pageSimple(titre, corps) {
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow"><title>' + echapper(titre) + '</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.2rem;color:#141413;background:#f0eee6}'
    + 'code{background:#faf9f5;border:1px solid rgba(20,20,19,.12);padding:.1em .4em;border-radius:5px}h1{font-family:Georgia,serif;font-weight:500}</style></head><body>' + corps + '</body></html>';
}

function envoyerHtml(res, statut, html, entetes = {}) {
  res.writeHead(statut, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, ...entetes });
  res.end(html);
}

/** Démarre le serveur. Rend { serveur, port, fermer() }. */
function demarrer(instance, { port = 4747, hote = '127.0.0.1' } = {}) {
  const securise = /^https:/i.test(String(require('../host').publicUrl() || ''));
  const pages = require('../web/pages').metisPages({
    routeur,
    formulaire,
    origineSure,
    compteDe: (req) => instance.session(cookieDe(req)),
    connexion: (req) => '/connexion?suite=' + encodeURIComponent(req.originalUrl || '/metis'),
    pied: '<form method="post" action="/deconnexion" style="display:inline"><button type="submit" style="font:inherit;background:none;border:0;padding:0;color:inherit;cursor:pointer;text-decoration:underline">Se déconnecter</button></form>',
    textes: {},
  });

  const serveur = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const chemin = url.pathname;
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');

      if (chemin === '/healthz') return json(res, 200, { ok: true, version: PAQUET.version });

      if (chemin === '/mcp' || chemin === '/mcp/') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Utiliser POST (MCP, transport Streamable HTTP sans état).' }, { Allow: 'POST' });
        const jeton = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const qui = instance.verifierJeton(jeton);
        if (!qui) return json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Jeton Métis requis (Authorization: Bearer metis_…). Créez-en un avec « metis jeton ».' } }, { 'WWW-Authenticate': 'Bearer' });
        let message;
        try { message = JSON.parse((await lireCorps(req)).toString('utf8')); }
        catch (e) {
          if (e.code === 'TROP_GROS') return json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Requête trop volumineuse (maximum 1 Mio).' } });
          return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Corps JSON invalide.' } });
        }
        const r = await traiter(message, { ...qui, encoreValide: () => { const v = instance.verifierJeton(jeton); return !!v && v.compte === qui.compte && v.client === qui.client; } });
        if (r.corps === null) { res.writeHead(r.statut); return res.end(); }
        return json(res, r.statut, r.corps);
      }

      if (chemin === '/' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(302, { Location: '/metis' }); return res.end(); }

      if (chemin === '/connexion' && req.method === 'GET') {
        const suite = /^\/metis(\/|$|\?)/.test(url.searchParams.get('suite') || '') ? url.searchParams.get('suite') : '/metis';
        const code = url.searchParams.get('code');
        if (code) {
          const c = instance.consommerLien(code);
          if (c) {
            const valeur = instance.ouvrirSession(c.id);
            res.writeHead(303, { Location: suite, 'Set-Cookie': COOKIE + '=' + valeur + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 30 * 86400 + (securise ? '; Secure' : ''), 'Cache-Control': 'no-store' });
            return res.end();
          }
        }
        return envoyerHtml(res, code ? 403 : 200, pageSimple('Connexion — Métis', '<h1>Métis</h1>'
          + (code ? '<p><b>Ce lien de connexion n’est plus valable</b> (déjà utilisé, ou expiré après 15 minutes).</p>' : '')
          + '<p>Pour ouvrir l’interface, demandez un lien de connexion sur la machine de l’instance :</p><p><code>metis lien</code></p>'
          + '<p>Le lien s’ouvre une seule fois et expire au bout de 15 minutes. Un membre invité reçoit le sien avec <code>metis lien --pseudo SON_PSEUDO</code>.</p>'));
      }

      if (chemin === '/deconnexion' && req.method === 'POST') {
        if (!origineSure(req)) return envoyerHtml(res, 403, pageSimple('Refusé', '<p>Formulaire refusé.</p>'));
        instance.fermerSession(cookieDe(req));
        res.writeHead(303, { Location: '/connexion', 'Set-Cookie': COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
        return res.end();
      }

      if (chemin === '/metis' || chemin.startsWith('/metis/')) {
        res.setHeader('Content-Security-Policy', CSP);
        const sous = chemin.slice('/metis'.length) || '/';
        if (pages.traiter(req, res, { chemin: sous, prefixe: '/metis', url })) return;
      }

      return envoyerHtml(res, 404, pageSimple('Introuvable — Métis', '<h1>Page introuvable</h1><p><a href="/metis">Revenir à Métis</a></p>'));
    } catch (e) {
      try { require('../core/logger').error('metis', 'HTTP : ' + (e.stack || e.message)); } catch { /* */ }
      if (!res.headersSent) json(res, 500, { error: 'Erreur interne.' }); else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    serveur.once('error', reject);
    serveur.listen(port, hote, () => {
      serveur.off('error', reject);
      resolve({ serveur, port: serveur.address().port, fermer: () => new Promise((r) => serveur.close(() => r())) });
    });
  });
}

module.exports = { demarrer, origineSure };
