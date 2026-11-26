'use strict';

// Lance chaque fichier test/*.test.js dans son propre processus (un hôte par
// processus : host.configure() ne s'appelle qu'une fois) et rend 1 au moindre échec.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const fichiers = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let echecs = 0;
for (const f of fichiers) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { echecs++; console.error(`\n✗ ${f} (code ${r.status})`); }
}
console.log(`\n${fichiers.length - echecs}/${fichiers.length} fichier(s) de test réussi(s)`);
process.exit(echecs ? 1 : 0);
