'use strict';

// Projection du registre existant. Pas de scheduler, modèle, shell ou réseau.
const crypto = require('node:crypto');
const S = require('./metis-securite');
const digest = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function inventory() {
  return S.etatDepots().map((d) => ({ depot: d.nom_complet, importance: d.importance,
    public: d.public, dernier_audit: d.dernier_audit, pousse_le: d.pousse_le, failles: d.failles }))
    .sort((a, b) => a.depot.localeCompare(b.depot, 'en'));
}
function generate() {
  const rows = inventory();
  const counts = { actif: 0, faible: 0, mort: 0 };
  for (const row of rows) counts[row.importance.niveau]++;
  const priorities = rows.filter((r) => r.importance.niveau !== 'mort').map((r) => {
    const f = r.failles, reasons = [];
    let score = f.critique * 100 + f.haute * 50 + f.moyenne * 20 + f.basse * 5;
    if (score) reasons.push('failles ouvertes déclarées');
    if (!r.dernier_audit) { score += 5; reasons.push('jamais audité'); }
    if (r.public) { score += 3; reasons.push('dépôt public'); }
    if (r.dernier_audit && r.pousse_le && r.pousse_le > r.dernier_audit) { score += 3; reasons.push('push postérieur au dernier audit'); }
    return { depot: r.depot, importance: r.importance.niveau, score, raisons: reasons };
  }).sort((a, b) => (a.importance === 'actif' ? 0 : 1) - (b.importance === 'actif' ? 0 : 1)
    || b.score - a.score || a.depot.localeCompare(b.depot, 'en')).slice(0, 8);
  return { available: true, schema_version: 1, jour: S.paris().jour, inventory_sha256: digest(rows),
    total: rows.length, importance: counts, priorites: priorities,
    methode: 'Priorité heuristique : critique 100, haute 50, moyenne 20, basse 5 ; jamais audité +5, public +3, push post-audit +3 ; actifs avant faibles. Pas une mesure de sécurité ni de criticité runtime.',
    limites: 'Registre documentaire seulement ; exécution et couverture inconnues. Un push peut être un transfert. Aucun plan ni appel externe créé.' };
}
function assertForPlanning(account, ref) {
  const fail = () => { throw new S.ErreurSecurite('FAILED_PRECONDITION', 'Rapport Security Center courant et checkpoint approuvé requis avant la planification.', 409); };
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some((k) => !['id', 'revision'].includes(k))
      || !/^command:[a-f0-9-]{36}$/.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail();
  let run;
  // Le registre des exécutions vient de l'hôte (Atlas : Command Center) ; sans lui, aucun
  // rapport ne peut être vérifié et la planification qui en exige un est refusée.
  const H = require('../host');
  try { if (!H.fournit('commandes')) fail(); run = H.get('commandes').get(account, ref.id); } catch (e) { if (e instanceof S.ErreurSecurite) throw e; fail(); }
  if (run.kind !== 'execution' || run.revision !== ref.revision || run.data.status !== 'completed') fail();
  const nodes = run.data.definition.nodes;
  const report = nodes.find((n) => n.type === 'security_report');
  const gate = report && nodes.find((n) => n.type === 'checkpoint' && n.after.includes(report.id));
  const state = report && run.data.nodes.find((n) => n.id === report.id);
  const approval = gate && run.data.nodes.find((n) => n.id === gate.id);
  if (!state || state.state !== 'succeeded' || !approval || approval.state !== 'succeeded' || approval.approved_by !== 'atlas:' + account) fail();
  const result = state.result;
  if (!result || result.jour !== S.paris().jour || result.inventory_sha256 !== digest(inventory())) fail();
  return { id: run.id, revision: run.revision, inventory_sha256: result.inventory_sha256 };
}
const template = () => ({ title: 'Security Center — rapport avant planification', budget_ms: 60000,
  nodes: [{ id: 'rapport', type: 'security_report', after: [] }, { id: 'validation', type: 'checkpoint', after: ['rapport'] }] });
module.exports = { generate, assertForPlanning, template };
