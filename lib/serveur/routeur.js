'use strict';

// =============================================================================
//  Un routeur au contrat d'Express, sans dépendance, pour « metis serve »
// -----------------------------------------------------------------------------
//  Les pages de Métis (lib/web/pages.js et ses sous-pages) sont écrites pour un
//  routeur Express : Atlas leur donne le sien, l'instance autonome celui-ci. Il ne
//  couvre que ce dont elles se servent :
//    router.get / router.post (chemin, …gestionnaires) ; chemins « /a/:x » et
//    « /a/:x(regex).svg » ; req.params, req.query, req.body, req.originalUrl ;
//    res.status, res.set, res.type, res.send, res.json, res.redirect.
// =============================================================================

const querystring = require('node:querystring');

const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', text: 'text/plain; charset=utf-8', js: 'text/javascript; charset=utf-8' };

// « /graphique/:id([a-f0-9]{16}).svg » → /^\/graphique\/(?<id>[a-f0-9]{16})\.svg\/?$/
function compiler(chemin) {
  let re = '', i = 0;
  while (i < chemin.length) {
    if (chemin[i] === ':') {
      const nom = /^:([A-Za-z_]\w*)/.exec(chemin.slice(i))[1];
      i += nom.length + 1;
      let motif = '[^/]+?';
      if (chemin[i] === '(') {
        let profondeur = 0, j = i;
        for (; j < chemin.length; j++) { if (chemin[j] === '(') profondeur++; else if (chemin[j] === ')' && --profondeur === 0) break; }
        motif = chemin.slice(i + 1, j);
        i = j + 1;
      }
      re += '(?<' + nom + '>' + motif + ')';
    } else { re += chemin[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + re + '/?$');
}

function augmenterReponse(res) {
  res.status = (n) => { res.statusCode = n; return res; };
  res.set = (cle, valeur) => { if (typeof cle === 'object') { for (const k of Object.keys(cle)) res.setHeader(k, cle[k]); } else res.setHeader(cle, valeur); return res; };
  res.type = (t) => { res.setHeader('Content-Type', TYPES[t] || (t.includes('/') ? t : 'application/octet-stream')); return res; };
  res.send = (corps) => {
    if (corps !== null && typeof corps === 'object' && !Buffer.isBuffer(corps)) return res.json(corps);
    const tampon = Buffer.isBuffer(corps) ? corps : Buffer.from(String(corps == null ? '' : corps), 'utf8');
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', Buffer.isBuffer(corps) ? 'application/octet-stream' : TYPES.html);
    if (/^image\/svg\+xml$/.test(String(res.getHeader('Content-Type')))) res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Length', tampon.length);
    res.end(res.req && res.req.method === 'HEAD' ? undefined : tampon);
    return res;
  };
  res.json = (obj) => { res.setHeader('Content-Type', TYPES.json); return res.send(JSON.stringify(obj)); };
  res.redirect = (a, b) => { const [statut, url] = typeof a === 'number' ? [a, b] : [302, a]; res.statusCode = statut; res.setHeader('Location', url); res.end(); return res; };
  return res;
}

/** Lecteur de formulaires urlencoded (middleware), au plus `limite` octets. */
function formulaire(limite = '4kb') {
  const max = /^(\d+)kb$/i.test(limite) ? Number(/^(\d+)/.exec(limite)[1]) * 1024 : Number(limite) || 4096;
  return (req, res, suite) => {
    if (req.body !== undefined) return suite();
    if (!/^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] || ''))) { req.body = {}; return suite(); }
    const morceaux = []; let taille = 0, fini = false;
    req.on('data', (c) => { taille += c.length; if (taille > max && !fini) { fini = true; res.statusCode = 413; res.end('Formulaire trop volumineux.'); req.destroy(); } else morceaux.push(c); });
    req.on('end', () => { if (fini) return; req.body = querystring.parse(Buffer.concat(morceaux).toString('utf8')); suite(); });
  };
}

function routeur() {
  const routes = [];
  const ajouter = (methode) => (chemin, ...gestionnaires) => { routes.push({ methode, re: compiler(chemin), gestionnaires }); };
  const r = { get: ajouter('GET'), post: ajouter('POST') };

  /**
   * Traite une requête dont le chemin (sans le préfixe de montage) est `chemin`.
   * Rend true si une route a répondu (ou est en train de répondre), false sinon.
   */
  r.traiter = (req, res, { chemin, prefixe = '', url }) => {
    const methode = req.method === 'HEAD' ? 'GET' : req.method;
    for (const route of routes) {
      if (route.methode !== methode) continue;
      const m = route.re.exec(chemin);
      if (!m) continue;
      req.params = {};
      for (const [k, v] of Object.entries(m.groups || {})) { try { req.params[k] = decodeURIComponent(v); } catch { req.params[k] = v; } }
      req.query = Object.fromEntries(url.searchParams);
      req.originalUrl = prefixe + chemin + url.search;
      res.req = req;
      augmenterReponse(res);
      let i = 0;
      const suite = (err) => {
        if (err) return echec(err);
        const g = route.gestionnaires[i++];
        if (!g) return;
        try { const p = g(req, res, suite); if (p && typeof p.catch === 'function') p.catch(echec); } catch (e) { echec(e); }
      };
      const echec = (e) => {
        try { require('../core/logger').error('metis', 'Page ' + chemin + ' : ' + (e.stack || e.message)); } catch { /* */ }
        if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', TYPES.text); res.end('Erreur interne.'); } else res.end();
      };
      suite();
      return true;
    }
    return false;
  };
  return r;
}

// Un formulaire vient-il de cette instance ? (Origin, sinon Referer, comparé à Host)
function origineSure(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o || !req.headers.host) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

module.exports = { routeur, formulaire, origineSure, compiler };
