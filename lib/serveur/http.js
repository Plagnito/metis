'use strict';

// =============================================================================
//  Le serveur HTTP de « metis serve » (node:http, sans dépendance)
// -----------------------------------------------------------------------------
//  POST /mcp      le serveur MCP (jeton « Authorization: Bearer metis_… »)
//  GET  /healthz  { ok, version } pour les superviseurs
//  GET  /         page d'accueil de l'instance (l'interface complète arrive au lot 2.2)
//
//  Écoute 127.0.0.1 par défaut : l'instance n'est joignable que depuis la machine.
//  L'ouvrir au réseau est un choix explicite (--hote 0.0.0.0), et l'accès distant
//  prévu passe par le relais, pas par un port ouvert.
// =============================================================================

const http = require('node:http');
const { traiter } = require('./mcp');
const PAQUET = require('../../package.json');

const LIMITE = 1024 * 1024;
const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

function accueil(instance) {
  const M = require('../modules/metisdocs');
  let docs = 0;
  try { M.init(); docs = instance.db.prepare('SELECT count(*) n FROM metis_docs').get().n; } catch { /* base neuve */ }
  const p = instance.proprietaire();
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Métis</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1d2433}'
    + 'code{background:#f1f3f7;padding:.1em .35em;border-radius:4px}h1{margin-bottom:.2rem}.m{color:#5b6478}</style></head><body>'
    + '<h1>Métis</h1><p class="m">Version ' + echapper(PAQUET.version) + (p ? ' · propriétaire : ' + echapper(p.pseudo) : '') + '</p>'
    + '<p>Ce Métis tourne sur cette machine. ' + docs + ' document(s) publié(s).</p>'
    + '<p>Les agents s’y connectent par le serveur MCP <code>/mcp</code>, avec un jeton créé par <code>metis jeton</code>.</p>'
    + '<p class="m">L’interface complète (documents, glossaire, projets, carnet, Security Center, issues) arrive dans une prochaine version.</p>'
    + '</body></html>';
}

/** Démarre le serveur. Rend { serveur, port, fermer() }. */
function demarrer(instance, { port = 4747, hote = '127.0.0.1' } = {}) {
  const serveur = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, version: PAQUET.version });
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
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
      if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        const html = accueil(instance);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      return json(res, 404, { error: 'Introuvable.' });
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

module.exports = { demarrer };
