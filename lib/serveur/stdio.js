'use strict';

// =============================================================================
//  « metis mcp » : pont MCP stdio → HTTP
// -----------------------------------------------------------------------------
//  Les clients qui ne lancent que des serveurs stdio (Claude Desktop, Codex…)
//  démarrent `npx @plagnito/metis mcp` ; le pont relaie chaque message JSON-RPC
//  (une ligne) vers le serveur Métis et rend sa réponse sur une ligne.
//  Il n'ouvre PAS la base lui-même : un seul processus écrit, celui de
//  « metis serve ». Les messages sont relayés dans l'ordre, un à la fois.
// =============================================================================

const readline = require('node:readline');

function pont({ url, jeton, entree = process.stdin, sortie = process.stdout, fetchImpl = fetch } = {}) {
  const cible = (url && url !== true ? String(url) : process.env.METIS_URL) || 'http://127.0.0.1:' + (process.env.METIS_PORT || 4747) + '/mcp';
  const secret = (jeton && jeton !== true ? String(jeton) : process.env.METIS_JETON) || '';
  const ecrire = (obj) => sortie.write(JSON.stringify(obj) + '\n');
  let file = Promise.resolve();

  const relayer = async (ligne) => {
    let id = null;
    try { const m = JSON.parse(ligne); id = m && m.id !== undefined ? m.id : null; } catch {
      return ecrire({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ligne JSON invalide.' } });
    }
    try {
      const r = await fetchImpl(cible, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(secret ? { Authorization: 'Bearer ' + secret } : {}) }, body: ligne, signal: AbortSignal.timeout(120000) });
      if (r.status === 202) return;
      const texte = await r.text();
      if (!texte) return;
      try { ecrire(JSON.parse(texte)); }
      catch { if (id !== null) ecrire({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Réponse illisible du serveur Métis (HTTP ' + r.status + ').' } }); }
    } catch (e) {
      if (id !== null) ecrire({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Serveur Métis injoignable (' + cible + ') : ' + e.message + '. Lancez « metis serve ».' } });
    }
  };

  const lignes = readline.createInterface({ input: entree, crlfDelay: Infinity });
  lignes.on('line', (ligne) => { if (ligne.trim()) file = file.then(() => relayer(ligne)); });
  return new Promise((resolve) => lignes.on('close', () => file.then(resolve)));
}

module.exports = { pont };
