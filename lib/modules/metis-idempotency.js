'use strict';
const crypto = require('node:crypto');
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fingerprint(args) {
  const business = Object.fromEntries(Object.entries(args).filter(([key]) => !['max_bytes', 'max_tokens'].includes(key)));
  return 'business-v1:' + crypto.createHash('sha256').update(stable(business)).digest('hex');
}
// Les anciens hashes ne conservent pas la requête. Seul un rejeu exact selon
// l'ancien algorithme permet de les lier sans risque à une empreinte métier.
function matches(previous, current, legacy) { return previous === current || previous === legacy; }
function upgrade(db, actor, operation, key, previous, current) {
  if (previous !== current) db.prepare('UPDATE metis_research_requests SET fingerprint=? WHERE actor=? AND operation=? AND request_key=? AND fingerprint=?')
    .run(current, actor, operation, key, previous);
}
module.exports = { fingerprint, matches, upgrade };
