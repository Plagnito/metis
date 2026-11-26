'use strict';

// =============================================================================
//  L'HÔTE DE MÉTIS — la seule porte vers ce qui n'appartient pas à Métis
// -----------------------------------------------------------------------------
//  Métis tourne de deux façons :
//   • seul, chez quelqu'un (`metis serve`) : il apporte sa propre base SQLite ;
//   • DANS une application qui l'héberge (Atlas, sur plagnito.com) : il travaille
//     sur la base, le journal et l'identité de cette application.
//
//  Les modules de `lib/modules` ne savent pas lequel des deux cas ils vivent : ils
//  demandent `../core/db`, `../core/sqlite-context` ou `../core/logger`, qui sont
//  des façades vers l'hôte configuré ici.
//
//  Chaque entrée se donne comme une FABRIQUE (une fonction), résolue au premier
//  usage seulement : charger un module pur (graphiques) n'ouvre aucune base.
//
//  Contrat :
//    db()            → { db: DatabaseSync, ... }      (forme de core/db)
//    sqliteContext() → { register, withIdentity, bindWriters, identity }
//    logger()        → { debug, info, warn, error }
//    publicUrl       → adresse publique de l'instance (sans « / » final)
// =============================================================================

const ENTREES = ['db', 'sqliteContext', 'logger'];
let config = null;
const resolues = new Map();

function configure(hote) {
  if (config) throw new Error('Hôte Métis déjà configuré : configure() ne s’appelle qu’une fois par processus.');
  if (!hote || typeof hote !== 'object') throw new TypeError('configure() attend un objet hôte.');
  for (const cle of ENTREES) {
    if (typeof hote[cle] !== 'function') throw new TypeError(`Hôte Métis incomplet : « ${cle} » doit être une fonction qui rend l’objet.`);
  }
  if (hote.publicUrl != null) {
    const url = new URL(String(hote.publicUrl));
    if (!/^https?:$/.test(url.protocol) || url.search || url.hash) throw new TypeError('publicUrl doit être une adresse http(s) sans paramètres.');
  }
  config = { ...hote, publicUrl: hote.publicUrl ? String(hote.publicUrl).replace(/\/+$/, '') : null };
}

function configured() { return config !== null; }

function get(cle) {
  if (!ENTREES.includes(cle)) throw new Error(`Entrée d’hôte inconnue : ${cle}`);
  if (!config) throw new Error(`Hôte Métis non configuré : « ${cle} » demandé avant host.configure().`);
  if (!resolues.has(cle)) {
    const valeur = config[cle]();
    if (!valeur || typeof valeur !== 'object') throw new TypeError(`L’hôte a rendu une valeur invalide pour « ${cle} ».`);
    resolues.set(cle, valeur);
  }
  return resolues.get(cle);
}

function publicUrl() { return config?.publicUrl ?? null; }

// Façade paresseuse : lire une propriété résout l'hôte à ce moment-là. Les fonctions
// sont rendues telles quelles (pas de bind) : les objets de l'hôte sont des modules
// CommonJS dont les fonctions ne dépendent pas de `this`.
function facade(cle) {
  return new Proxy(Object.create(null), {
    get: (_, prop) => get(cle)[prop],
    has: (_, prop) => prop in get(cle),
    ownKeys: () => Reflect.ownKeys(get(cle)),
    getOwnPropertyDescriptor: (_, prop) => {
      const d = Reflect.getOwnPropertyDescriptor(get(cle), prop);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

// Réservé aux tests du paquet : repartir d'un hôte vierge.
function _reinitialiser() { config = null; resolues.clear(); }

module.exports = { configure, configured, get, publicUrl, facade, _reinitialiser };
