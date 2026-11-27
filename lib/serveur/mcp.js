'use strict';

// =============================================================================
//  Le transport MCP de l'instance autonome — Streamable HTTP sans état
// -----------------------------------------------------------------------------
//  Un POST JSON-RPC, une réponse JSON. Le compte et le client viennent du jeton
//  (lib/defaut/instance.js). Comme dans Atlas, l'accès est revérifié AVANT de
//  répondre : un jeton révoqué ou un droit retiré pendant l'appel coupe la
//  réponse au lieu de livrer des données qu'on n'a plus le droit de lire.
//  Les limites par agent (metis-app-permissions) s'appliquent au client du jeton.
// =============================================================================

const MCP = require('../web/metis-mcp');
const M = () => require('../modules/metisdocs');
const permissions = () => require('../modules/metis-app-permissions');
const PAQUET = require('../../package.json');
// Une écriture est signée du pseudo ET de l'agent qui l'a faite (« nolan · claude-code ») :
// sur une instance à soi, « qui » ne suffit pas, on veut savoir « par quel agent ».
const signature = (moi, client) => { const c = require('../core/comptes').compte(moi); return (c ? c.pseudo : 'compte ' + moi) + ' · ' + client; };

/**
 * Traite un message JSON-RPC déjà décodé.
 * ctx : { compte, client, encoreValide() → bool }.
 * Rend { statut, corps } (corps null pour une notification : 202 sans corps).
 */
async function traiter(m, ctx) {
  const { compte: moi, client } = ctx;
  const encoreValide = ctx.encoreValide || (() => true);
  if (Array.isArray(m)) return { statut: 400, corps: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Les lots JSON-RPC ne sont pas pris en charge.' } } };
  if (!m || typeof m !== 'object') return { statut: 400, corps: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Requête JSON-RPC invalide.' } } };
  const id = m.id === undefined ? null : m.id;
  const erreur = (code, message) => ({ statut: 200, corps: { jsonrpc: '2.0', id, error: { code, message } } });
  if (typeof m.method !== 'string') return erreur(-32600, 'Requête JSON-RPC invalide.');
  if (m.id === undefined && m.method.startsWith('notifications/')) return { statut: 202, corps: null };
  if (!M().peutLire(moi)) return { statut: 403, corps: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Accès refusé.' } } };

  const P = permissions();
  return P.withClient(moi, client, async () => {
    const tampon = P.snapshot();
    const livrer = (result) => new Promise((resolve) => {
      require('../modules/metis-access-fence').deliver(require('../modules/metis-recovery').toolResult(result), (verifie) => {
        try {
          if (!encoreValide()) throw Object.assign(new Error('Connexion révoquée.'), { code: 'PERMISSION_DENIED' });
          verifie = P.delivery(verifie, m.method, tampon);
        } catch (e) { verifie = P.error(e); }
        resolve({ statut: 200, corps: { jsonrpc: '2.0', id, result: verifie } });
      }, encoreValide);
    });
    try {
      P.checkMethod(m.method);
      switch (m.method) {
        case 'initialize': {
          const demande = m.params && m.params.protocolVersion;
          return livrer({
            protocolVersion: MCP.VERSIONS.includes(demande) ? demande : MCP.VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: 'metis', title: 'Métis : recherche, projets et collaboration d’agents', version: PAQUET.version },
            instructions: MCP.instructions(moi),
          });
        }
        case 'ping': return livrer({});
        case 'tools/list': return livrer({ tools: P.filterTools(MCP.catalogueDe(moi)) });
        case 'tools/call': {
          const p = m.params || {};
          if (typeof p.name !== 'string' || !p.name || (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))) {
            return erreur(-32602, 'Nom d’outil et arguments objet requis.');
          }
          if (!MCP.nomsConnus().has(p.name)) return erreur(-32602, 'Outil inconnu.');
          P.checkCall(p.name, p.arguments || {});
          const r = await require('../modules/metis-research-journal').withIdentity(moi, client,
            () => MCP.appeler(p.name, p.arguments || {}, moi, { auteur: signature(moi, client), current: encoreValide }));
          return livrer(r);
        }
        case 'resources/list': case 'resources/templates/list': case 'resources/read': case 'prompts/list': case 'prompts/get':
          return new Promise((resolve) => require('../web/metis-development-mcp').deliver(m.method, m.params, moi,
            (result) => resolve(livrer(result)), (message) => resolve(erreur(-32001, message)), encoreValide));
        default: return erreur(-32601, 'Méthode inconnue : ' + m.method);
      }
    } catch (e) {
      if (e.code && String(e.code).startsWith('APP_')) return { statut: 200, corps: { jsonrpc: '2.0', id, result: P.error(e) } };
      try { require('../core/logger').error('metis', 'MCP ' + m.method + ' : ' + (e.stack || e.message)); } catch { /* */ }
      return erreur(-32603, 'Erreur interne du serveur.');
    }
  });
}

module.exports = { traiter };
