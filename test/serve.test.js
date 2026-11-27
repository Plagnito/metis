'use strict';

// « metis serve » de bout en bout, dans un dossier jetable : la VRAIE commande est lancée
// (processus enfant), le premier lancement crée le propriétaire et son jeton, le MCP répond
// par HTTP et par le pont stdio, un jeton révoqué ne passe plus, un second serveur sur la
// même base est refusé. Rien n'est écrit hors du dossier jetable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'metis.js');
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-serve-'));
const env = { ...process.env, METIS_DONNEES: dossier };
let n = 0;
const ok = async (titre, fn) => { await fn(); n++; console.log('  ✅ ' + titre); };

function lancerServeur() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--pseudo', 'proprio'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '', erreurs = '';
    const delai = setTimeout(() => reject(new Error('serveur muet : ' + sortie + erreurs)), 20000);
    p.stderr.on('data', (d) => { erreurs += d; });
    p.stdout.on('data', (d) => {
      sortie += d;
      const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(sortie);
      const jeton = /(metis_[A-Za-z0-9_-]{43})/.exec(sortie);
      if (port && jeton) { // premier lancement : on attend aussi le jeton
        clearTimeout(delai); resolve({ p, port: Number(port[1]), jeton: jeton && jeton[1], sortie });
      }
    });
    p.on('exit', (c) => { clearTimeout(delai); reject(new Error('serveur arrêté (' + c + ') : ' + sortie + erreurs)); });
  });
}
const rpc = async (port, jeton, method, params) => {
  const r = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: 'Bearer ' + jeton } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { statut: r.status, corps: r.status === 202 ? null : await r.json() };
};

let serveur;
(async () => {
  serveur = await lancerServeur();

  await ok('le premier lancement crée le propriétaire et lui donne un jeton', () => {
    assert(serveur.jeton, serveur.sortie);
    assert.match(serveur.sortie, /propriétaire « proprio »/);
    assert.match(serveur.sortie, /claude mcp add --transport http metis/);
    assert(fs.existsSync(path.join(dossier, 'metis.db')));
  });

  await ok('/healthz et la page d’accueil répondent', async () => {
    const h = await (await fetch('http://127.0.0.1:' + serveur.port + '/healthz')).json();
    assert.equal(h.ok, true);
    const page = await (await fetch('http://127.0.0.1:' + serveur.port + '/')).text();
    assert.match(page, /Métis/);
    assert.match(page, /proprio/);
  });

  await ok('sans jeton, le MCP refuse (401)', async () => {
    const r = await rpc(serveur.port, null, 'tools/list');
    assert.equal(r.statut, 401);
    assert.equal((await rpc(serveur.port, 'metis_' + 'x'.repeat(43), 'tools/list')).statut, 401);
  });

  await ok('avec le jeton : initialize, tools/list, et un appel qui écrit', async () => {
    const init = await rpc(serveur.port, serveur.jeton, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.corps.result.serverInfo.name, 'metis');
    assert.match(init.corps.result.instructions, /http:\/\/127\.0\.0\.1:\d+\/metis/);
    assert.doesNotMatch(init.corps.result.instructions, /plagnito/);
    const liste = await rpc(serveur.port, serveur.jeton, 'tools/list');
    const noms = liste.corps.result.tools.map((t) => t.name);
    for (const nom of ['publier_document', 'carnet_ajouter', 'projets_creer', 'search_everything', 'securite_etat']) assert(noms.includes(nom), nom);
    const ajout = await rpc(serveur.port, serveur.jeton, 'tools/call', { name: 'carnet_ajouter', arguments: { titre: 'Premier essai', type: 'idee' } });
    assert.notEqual(ajout.corps.result.isError, true, JSON.stringify(ajout.corps));
    const lu = await rpc(serveur.port, serveur.jeton, 'tools/call', { name: 'carnet_lister', arguments: {} });
    assert(lu.corps.result.structuredContent.taches.some((t) => t.titre === 'Premier essai'));
    const notif = await fetch('http://127.0.0.1:' + serveur.port + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + serveur.jeton }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(notif.status, 202);
  });

  await ok('le pont stdio relaie vers le serveur', () => {
    const entree = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'carnet_lister', arguments: {} } }),
    ].join('\n') + '\n';
    const r = spawnSync(process.execPath, [BIN, 'mcp', '--url', 'http://127.0.0.1:' + serveur.port + '/mcp'], { input: entree, env: { ...env, METIS_JETON: serveur.jeton }, encoding: 'utf8', timeout: 20000 });
    const lignes = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lignes.length, 2, r.stdout + r.stderr);
    assert.equal(lignes[0].id, 1);
    assert.equal(lignes[0].result.serverInfo.name, 'metis');
    assert(lignes[1].result.structuredContent.taches.length >= 1);
  });

  await ok('un jeton créé par « metis jeton » marche, puis ne marche plus une fois révoqué', async () => {
    const cree = spawnSync(process.execPath, [BIN, 'jeton', '--client', 'codex'], { env, encoding: 'utf8' });
    const j = /(metis_[A-Za-z0-9_-]{43})/.exec(cree.stdout);
    assert(j, cree.stdout + cree.stderr);
    assert.equal((await rpc(serveur.port, j[1], 'ping')).statut, 200);
    const liste = spawnSync(process.execPath, [BIN, 'jetons'], { env, encoding: 'utf8' }).stdout;
    const ligne = liste.split('\n').find((l) => l.includes('  codex  '));
    assert(ligne, liste);
    const rev = spawnSync(process.execPath, [BIN, 'revoquer', ligne.split('  ')[0]], { env, encoding: 'utf8' });
    assert.match(rev.stdout, /révoqué/);
    assert.equal((await rpc(serveur.port, j[1], 'ping')).statut, 401);
  });

  await ok('un second serveur sur la même base est refusé', () => {
    const r = spawnSync(process.execPath, [BIN, 'serve', '--port', '0'], { env, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /utilise déjà/);
  });

  console.log(`serve : ${n} vérifications`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (serveur) { serveur.p.kill(); await new Promise((r) => serveur.p.once('exit', r)); }
  fs.rmSync(dossier, { recursive: true, force: true });
});
