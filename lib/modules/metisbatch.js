'use strict';
const { db } = require('../core/db');
const A = require('./metisarchitecture');
const M = () => require('./metisdocs');
const MAX_BYTES = 768 * 1024;
const size = x => Buffer.byteLength(JSON.stringify(x), 'utf8');
function read(user, args = {}) {
  if (!M().peutLire(user)) return { ok: false, error: 'Accès refusé.' };
  const requests = args.requests || (Array.isArray(args.sigles) ? args.sigles.map(s => ({ id: 'sigle:' + s })) : null);
  if (!Array.isArray(requests) || !requests.length || requests.length > 100) return { ok: false, error: 'Entre 1 et 100 demandes par lot.' };
  const offset = args.offset ?? 0, max = args.max_bytes ?? MAX_BYTES;
  if (!Number.isInteger(offset) || offset < 0 || offset >= requests.length || !Number.isInteger(max) || max < 4096 || max > MAX_BYTES) return { ok: false, error: 'offset dans le lot ; max_bytes entre 4096 et 786432.' };
  const out = { ok: true, total: requests.length, offset, next_offset: null, partial_errors: 0, items: [] };
  for (let i = offset; i < requests.length; i++) {
    const req = requests[i]; let result;
    try {
      if (!req || typeof req.id !== 'string' || req.id.length > 240 || (req.version !== undefined && (!Number.isInteger(req.version) || req.version < 1))) throw new Error('Demande : {id, section?, version?}.');
      if (req.id.startsWith('sigle:')) result = M().lireFiche(user, req.id.slice(6), { version: req.version });
      else if (req.id.startsWith('expert:')) result = require('./metisexperts').lire(user, req.id.slice(7), { revision: req.version });
      else if (req.id.startsWith('document:')) result = M().lire(user, req.id.slice(9), { version: req.version });
      else throw new Error('Préfixes : sigle:, document:, expert:.');
      if (!result) result = { ok: false, error: 'Objet absent ou inaccessible.' };
      if (req.section !== undefined && result.ok !== false) {
        if (typeof result.corps !== 'string') throw new Error('Cet objet ne contient pas de sections Markdown.');
        const parsed = M().sections(result.corps);
        const s = typeof req.section === 'number' || /^\d+$/.test(req.section) ? parsed.sections[Number(req.section) - 1] : parsed.sections.find(s => s.titre === req.section);
        if (!s) throw new Error('Section absente : titre exact ou numéro requis.');
        result = { ok: true, version: result.version, section: s.titre, texte: parsed.lignes.slice(s.ligne, s.fin).join('\n') };
      } else if (args.include_body === false && result.ok !== false) {
        const { corps, versions, revisions, description, mesures, ...summary } = result; result = summary;
      }
      if (result.ok !== false && args.include_body !== false) {
        const body = result.corps ?? result.texte;
        if (body !== undefined) result = { ...result, graphiques: M().graphiquesDuCorps(body).map(g => ({ n: g.n, spec: g.spec, erreurs: g.erreurs })) };
      }
    } catch (e) { result = { ok: false, error: e.message }; }
    let item = { index: i, id: req && req.id, result };
    if (size(item) > max - 512) item = { index: i, id: req && req.id, result: { ok: false, error: 'Objet trop volumineux : lire une section ou include_body=false.', code: 'item_too_large' } };
    out.items.push(item);
    if (item.result.ok === false) out.partial_errors++;
    if (size(out) > max) { out.items.pop(); if (item.result.ok === false) out.partial_errors--; out.next_offset = i; break; }
  }
  return out;
}
function write(user, args = {}, opts = {}) {
  if (!M().peutEcrire(user)) return { ok: false, error: 'Réservé à Master ou aux éditeurs.' };
  if (!Array.isArray(args.fiches) || !args.fiches.length || args.fiches.length > 100) return { ok: false, error: 'fiches : entre 1 et 100 modifications.' };
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return { ok: false, error: 'dry_run : booléen.' };
  const seen = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    const diff = [];
    for (const patch of args.fiches) {
      if (!patch || typeof patch.sigle !== 'string' || seen.has(patch.sigle.trim())) throw new Error('Chaque fiche doit avoir un sigle unique.');
      seen.add(patch.sigle.trim());
      const before = M().lireFiche(user, patch.sigle.trim());
      if (!Number.isInteger(patch.version_attendue) || patch.version_attendue !== (before.ok ? before.version : 0)) throw new Error('Conflit de version : ' + patch.sigle + ' (version_attendue requise, 0 pour créer).');
      const section = typeof patch.section === 'string' && /^\d+$/.test(patch.section) ? Number(patch.section) : patch.section;
      const result = M().redigerFiche(user, { ...patch, section }, { ...opts, silencieux: true });
      if (!result.ok) throw new Error(patch.sigle + ' : ' + result.error);
      const after = M().lireFiche(user, patch.sigle.trim());
      const fields = f => f.ok ? Object.fromEntries(['sens', 'detail', 'categorie', 'nature', 'corps', 'version'].map(k => [k, f[k]])) : null;
      const b = fields(before), a = fields(after);
      const keys = Object.keys(a).filter(k => !b || a[k] !== b[k]);
      diff.push({ sigle: patch.sigle.trim(), version_before: before.ok ? before.version : 0, version_after: after.version,
        before: b ? Object.fromEntries(keys.map(k => [k, b[k]])) : null,
        after: Object.fromEntries(keys.map(k => [k, a[k]])) });
    }
    const fingerprint = A.hash(diff);
    if (args.dry_run !== false) { db.exec('ROLLBACK'); return { ok: true, dry_run: true, empreinte: fingerprint, diff }; }
    if (fingerprint !== args.empreinte_attendue) throw new Error('empreinte_attendue doit correspondre au dry-run courant.');
    db.exec('COMMIT'); return { ok: true, dry_run: false, empreinte: fingerprint, diff };
  } catch (e) { db.exec('ROLLBACK'); return { ok: false, error: e.message }; }
  finally { M().invaliderGlossaire(); }
}
module.exports = { read, write, MAX_BYTES };
