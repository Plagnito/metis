'use strict';

// Contexte SQLite par défaut, pour Métis qui tourne SEUL (sans application hôte).
// Copie fidèle de la primitive d'Atlas : les noms des fonctions SQL (atlas_actor_id,
// atlas_client_id, atlas_fold) sont GARDÉS tels quels, parce que des déclencheurs
// déjà inscrits dans des bases existantes les appellent. Les renommer casserait ces bases.
// Connection primitives only: no dependency on application modules or schemas.
const registered = new WeakSet();
let context = null;
function register(db) {
  if (registered.has(db)) return;
  db.function('atlas_actor_id', () => context?.actor ?? null);
  db.function('atlas_client_id', () => context?.client ?? null);
  db.function('atlas_fold', { deterministic: true }, value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('fr'));
  registered.add(db);
}
function withIdentity(user, client, fn) {
  const previous = context;
  context = { actor: user ? 'atlas:' + Number(user) : null, client: client || previous?.client || null };
  try { return fn(); } finally { context = previous; }
}
function bindWriters(exports, names) {
  for (const name of names) {
    const original = exports[name];
    exports[name] = function(...args) { return withIdentity(args[0], null, () => original.apply(this, args)); };
  }
}
module.exports = { register, withIdentity, bindWriters, identity: () => context ? { ...context } : null };
