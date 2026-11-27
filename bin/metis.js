#!/usr/bin/env node
'use strict';

// =============================================================================
//  metis — Métis chez soi
//    metis serve   [--port 4747] [--hote 127.0.0.1] [--donnees DOSSIER] [--url-publique URL] [--pseudo NOM]
//    metis lien    [--pseudo NOM] [--donnees DOSSIER]     lien de connexion à usage unique (15 min)
//    metis compte  --pseudo NOM [--donnees DOSSIER]       crée un compte membre
//    metis jeton   [--client NOM] [--donnees DOSSIER]     crée un jeton d'accès (montré une fois)
//    metis jetons  [--donnees DOSSIER]                    liste les jetons
//    metis agent   --client NOM [--github lecture|contributeur|mainteneur] [--depots a/b,c/d] [--pseudo NOM]
//                                                         limites GitHub d'un agent (sans --github : les affiche)
//    metis revoquer <id> [--donnees DOSSIER]              révoque un jeton
//    metis mcp     [--url URL] [--jeton JETON]            pont MCP stdio vers un Métis (local par défaut)
//    metis version | metis aide
// =============================================================================

const os = require('node:os');
const PAQUET = require('../package.json');

// Les domaines de la v1 sont actifs par défaut ; une variable posée à 0 les coupe.
for (const f of ['RESEARCH', 'COLLAB', 'CONTEXT', 'AUDIT', 'SCIENCE', 'CONTINUITY']) {
  if (process.env['METIS_' + f + '_ENABLED'] === undefined) process.env['METIS_' + f + '_ENABLED'] = '1';
}

function options(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [cle, val] = a.slice(2).split('=', 2);
      o[cle] = val !== undefined ? val : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else o._.push(a);
  }
  return o;
}

const AIDE = `Métis ${PAQUET.version} — recherche, projets et collaboration d'agents, chez soi.

  metis serve      démarre le serveur (interface et MCP sur http://127.0.0.1:4747)
      --port N           port d'écoute (4747)
      --hote ADRESSE     adresse d'écoute (127.0.0.1 : cette machine seulement)
      --donnees DOSSIER  dossier des données (METIS_DONNEES, sinon ~/.metis)
      --url-publique URL adresse affichée dans les liens (sinon http://127.0.0.1:PORT)
      --pseudo NOM       pseudo du propriétaire, au premier lancement
  metis lien       lien de connexion à l'interface (usage unique, 15 min ; --pseudo pour un membre)
  metis compte     crée un compte membre (--pseudo NOM) ; donnez-lui l'accès dans l'interface
  metis jeton      crée un jeton d'accès pour un agent (--client claude-code)
  metis jetons     liste les jetons
  metis agent      limites GitHub d'un agent : --client NOM --github lecture|contributeur|mainteneur
                   (--depots a/b,c/d pour n'ouvrir que ces dépôts ; sans --github : affiche ses limites)
  metis revoquer ID  révoque un jeton
  metis mcp        pont MCP stdio (--url http://127.0.0.1:4747/mcp, --jeton ou METIS_JETON)
  metis version
`;

function pseudoParDefaut() {
  const brut = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const p = String(brut).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  return p.length >= 2 ? p : 'proprietaire';
}

function consignesConnexion(url, jeton) {
  return [
    '',
    '  Jeton (montré une seule fois, gardez-le) :',
    '    ' + jeton,
    '',
    '  Claude Code :',
    '    claude mcp add --transport http metis ' + url + ' --header "Authorization: Bearer ' + jeton + '"',
    '  Client MCP en stdio (Claude Desktop, Codex…) : commande « npx @plagnito/metis mcp »,',
    '    variable METIS_JETON=' + jeton,
    '',
  ].join('\n');
}

async function serve(o) {
  const port = Number(o.port || process.env.METIS_PORT || 4747);
  const hote = String(o.hote || '127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port : entier de 0 à 65535.');
  const { ouvrir } = require('../lib/defaut/instance');
  const instance = ouvrir({ dossier: o.donnees, publicUrl: o['url-publique'] || 'http://' + (hote === '0.0.0.0' ? '127.0.0.1' : hote) + ':' + port });
  let premier = null;
  if (!instance.proprietaire()) {
    const p = instance.creerCompte(o.pseudo && o.pseudo !== true ? String(o.pseudo) : pseudoParDefaut(), 'proprietaire');
    premier = { pseudo: p.pseudo, jeton: instance.creerJeton(p.id, 'proprietaire') };
  }
  const { demarrer } = require('../lib/serveur/http');
  const s = await demarrer(instance, { port, hote });
  const base = 'http://' + (hote === '0.0.0.0' ? '127.0.0.1' : hote) + ':' + s.port;
  process.stdout.write('Métis ' + PAQUET.version + ' — ' + base + '  (données : ' + instance.dossier + ')\n');
  const proprio = instance.proprietaire();
  process.stdout.write('  Interface (lien à usage unique, 15 min) : ' + base + '/connexion?code=' + instance.creerLien(proprio.id) + '\n');
  if (premier) process.stdout.write('\n  Premier lancement : propriétaire « ' + premier.pseudo + ' » créé.' + consignesConnexion(base + '/mcp', premier.jeton));
  const arreter = async () => { await s.fermer(); instance.fermer(); process.exit(0); };
  process.once('SIGINT', arreter);
  process.once('SIGTERM', arreter);
}

function avecInstance(o, fn) {
  const { ouvrir } = require('../lib/defaut/instance');
  // Pas de verrou : ces commandes écrivent une ligne pendant qu'un serveur peut tourner (WAL).
  const instance = ouvrir({ dossier: o.donnees, verrou: false });
  try { return fn(instance); } finally { instance.fermer(); }
}

function lien(o) {
  avecInstance(o, (instance) => {
    const c = o.pseudo && o.pseudo !== true ? instance.comptes.compteParPseudo(String(o.pseudo)) : instance.proprietaire();
    if (!c) throw new Error(o.pseudo ? 'Aucun compte « ' + o.pseudo + ' » (metis compte --pseudo pour le créer).' : 'Aucune instance ici : lancez d’abord « metis serve ».');
    const base = (o.url && o.url !== true ? String(o.url) : 'http://127.0.0.1:' + (process.env.METIS_PORT || 4747)).replace(/\/+$/, '');
    process.stdout.write('Lien de connexion pour ' + c.pseudo + ' (usage unique, 15 min) :\n  ' + base + '/connexion?code=' + instance.creerLien(c.id) + '\n');
  });
}

function compte(o) {
  if (!o.pseudo || o.pseudo === true) throw new Error('Usage : metis compte --pseudo NOM');
  avecInstance(o, (instance) => {
    const c = instance.creerCompte(String(o.pseudo), 'membre');
    process.stdout.write('Compte « ' + c.pseudo + ' » créé. Donnez-lui l’accès dans l’interface (Gérer les accès), puis un lien : metis lien --pseudo ' + c.pseudo + '\n');
  });
}

function jeton(o) {
  avecInstance(o, (instance) => {
    const p = instance.proprietaire();
    if (!p) throw new Error('Aucune instance ici : lancez d’abord « metis serve ».');
    const client = o.client && o.client !== true ? String(o.client) : 'agent';
    const j = instance.creerJeton(p.id, client);
    process.stdout.write('Jeton créé pour le client « ' + client + ' » (compte ' + p.pseudo + ').' + consignesConnexion('http://127.0.0.1:' + (process.env.METIS_PORT || 4747) + '/mcp', j));
  });
}

function jetons(o) {
  avecInstance(o, (instance) => {
    const l = instance.jetons();
    if (!l.length) return process.stdout.write('Aucun jeton.\n');
    for (const j of l) process.stdout.write([j.id, j.pseudo, j.client, 'créé ' + j.cree_le, j.dernier_usage ? 'utilisé ' + j.dernier_usage : 'jamais utilisé', j.revoque_le ? 'RÉVOQUÉ ' + j.revoque_le : 'actif'].join('  ') + '\n');
  });
}

function agent(o) {
  if (!o.client || o.client === true) throw new Error('Usage : metis agent --client NOM [--github lecture|contributeur|mainteneur] [--depots a/b,c/d] [--pseudo NOM]');
  avecInstance(o, (instance) => {
    const G = require('../lib/modules/metis-github');
    const proprio = instance.proprietaire();
    if (!proprio) throw new Error('Aucune instance ici : lancez d’abord « metis serve ».');
    const c = o.pseudo && o.pseudo !== true ? instance.comptes.compteParPseudo(String(o.pseudo)) : proprio;
    if (!c) throw new Error('Aucun compte « ' + o.pseudo + ' ».');
    if (o.github && o.github !== true) {
      const depots = o.depots && o.depots !== true ? String(o.depots).split(',').map((x) => x.trim()).filter(Boolean) : null;
      G.fixerDroits(proprio.id, { compte: c.id, client: String(o.client), preset: String(o.github), depots });
    }
    const d = G.droits(c.id, String(o.client));
    process.stdout.write('Agent « ' + o.client + ' » de ' + c.pseudo + ' : ' + d.preset + (d.regle ? '' : ' (jamais réglé)') + ' — peut : ' + [...d.actions].join(', ')
      + (d.depots ? ' — dépôts : ' + d.depots.join(', ') : ' — tous les dépôts suivis') + '\n');
  });
}

function revoquer(o) {
  const id = o._[1];
  if (!id) throw new Error('Usage : metis revoquer <id> (metis jetons donne les identifiants).');
  avecInstance(o, (instance) => process.stdout.write(instance.revoquerJeton(id) ? 'Jeton révoqué.\n' : 'Aucun jeton actif avec cet identifiant.\n'));
}

async function principal(argv) {
  const o = options(argv);
  const commande = o._[0] || 'aide';
  switch (commande) {
    case 'serve': return serve(o);
    case 'lien': return lien(o);
    case 'compte': return compte(o);
    case 'jeton': return jeton(o);
    case 'jetons': return jetons(o);
    case 'revoquer': return revoquer(o);
    case 'agent': return agent(o);
    case 'mcp': return require('../lib/serveur/stdio').pont({ url: o.url, jeton: o.jeton });
    case 'version': case '--version': case '-v': return process.stdout.write(PAQUET.version + '\n');
    case 'aide': case '--help': case '-h': case 'help': return process.stdout.write(AIDE);
    default: process.stderr.write('Commande inconnue : ' + commande + '\n\n' + AIDE); process.exitCode = 2;
  }
}

principal(process.argv.slice(2)).catch((e) => { process.stderr.write((e.message || String(e)) + '\n'); process.exitCode = 1; });
