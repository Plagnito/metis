'use strict';
// Adresses publiques de l'instance. L'hôte donne `publicUrl` (Atlas : https://plagnito.com) ;
// sans elle, les liens restent relatifs (« /metis/… ») et valent pour l'instance qui les sert.
const host = require('./host');

function base() { return host.publicUrl() || ''; }
function url(chemin) { return base() + chemin; }
// L'hôte sans le schéma (« plagnito.com »), pour un texte lisible ; vide sans publicUrl.
function hote() { return base().replace(/^https?:\/\//, ''); }
// Même chose, prête à être collée DANS une chaîne SQL entre apostrophes.
function sql(chemin) { return url(chemin).replace(/'/g, "''"); }

module.exports = { base, url, hote, sql };
