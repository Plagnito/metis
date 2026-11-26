'use strict';
// This file is also used by the private settings page. It never starts a process.
function check(test, message) { if (!test) throw Object.assign(new Error(message), { code: 'INVALID_HARNESS_PERMISSIONS' }); }
const defaults = () => ({ version: 1, repositories: null, models: null, validations: null, max_timeout_ms: 1800000, max_prompt_bytes: 1000000, max_output_bytes: 1000000, codex_sandbox: 'workspace-write', claude_denied_tools: [], opencode_rules: [], metis_tools: null });
function validate(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Profil de harness requis.');
  const p = { ...defaults(), ...input };
  check(Object.keys(p).every(k => Object.hasOwn(defaults(), k)) && p.version === 1, 'Champ ou version de profil inconnu.');
  for (const key of ['repositories', 'models', 'validations']) check(p[key] === null || Array.isArray(p[key]) && p[key].length <= 100 && p[key].every(x => typeof x === 'string' && /^[\w./:@+-]{1,160}$/.test(x)), 'Liste invalide : ' + key);
  for (const [key, min, max] of [['max_timeout_ms', 1000, 1800000], ['max_prompt_bytes', 512, 1000000], ['max_output_bytes', 512, 1000000]]) check(Number.isSafeInteger(p[key]) && p[key] >= min && p[key] <= max, 'Borne invalide : ' + key);
  check(['read-only', 'workspace-write'].includes(p.codex_sandbox), 'Sandbox Codex invalide.');
  check(Array.isArray(p.claude_denied_tools) && p.claude_denied_tools.length <= 100 && p.claude_denied_tools.every(x => typeof x === 'string' && /^[\w.*()/: -]{1,200}$/.test(x)), 'Outils Claude invalides.');
  check(Array.isArray(p.opencode_rules) && p.opencode_rules.length <= 100 && p.opencode_rules.every(r => r && Object.keys(r).length === 3 && ['action', 'resource', 'effect'].every(k => typeof r[k] === 'string') && r.action.length > 0 && r.action.length <= 160 && r.resource.length > 0 && r.resource.length <= 500 && !/[\x00-\x1f]/.test(r.action + r.resource) && ['ask', 'allow', 'deny'].includes(r.effect)), 'Règles OpenCode invalides.');
  check(p.metis_tools===null||Array.isArray(p.metis_tools)&&p.metis_tools.length<=100&&new Set(p.metis_tools).size===p.metis_tools.length&&p.metis_tools.every(t=>typeof t==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(t)), 'Outils Métis invalides.');
  return JSON.parse(JSON.stringify(p));
}
function effective(adapter) {
  const p = validate(adapter.permissions || {});
  // Refuse rules that this adapter cannot apply. An export is not OS enforcement.
  check(adapter.kind === 'opencode-desktop' || p.opencode_rules.length === 0, 'Les règles OpenCode nécessitent le harness OpenCode.');
  check(adapter.kind === 'claude' || p.claude_denied_tools.length === 0, 'Les règles Claude nécessitent le harness Claude.');
  check(adapter.kind === 'codex' || p.codex_sandbox === 'workspace-write', 'La sandbox Codex nécessite le harness Codex.');
  check(adapter.approval_mode !== 'native_review' || p.codex_sandbox === 'workspace-write', 'native_review ne peut pas remplacer une sandbox read-only.');
  check(p.metis_tools===null || adapter.kind==='codex' && adapter.metis!==undefined,'Les outils Métis locaux exigent le raccordement natif explicite Codex.');
  return p;
}
function guard(adapter, repository, validationIds, timeout) {
  const p = effective(adapter);
  check(p.repositories === null || p.repositories.includes(repository), 'Dépôt interdit par ce profil.');
  const model = adapter.kind==='opencode-desktop' ? adapter.model_ref?.providerID+'/'+adapter.model_ref?.id : adapter.model;
  check(p.models === null || p.models.includes(model), 'Modèle interdit par ce profil.');
  check(p.validations === null || validationIds.every(id => p.validations.includes(id)), 'Validation interdite par ce profil.');
  check(timeout <= p.max_timeout_ms, 'Durée supérieure à la limite du profil.');
  return p;
}
function openCodeRules(adapter) {
  const p = effective(adapter);
  return [{ action: '*', resource: '*', effect: 'ask' }, ...p.opencode_rules,
    // Last match wins in V2. A user profile cannot authorize another agent.
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'deny' }];
}
module.exports = { defaults, validate, effective, guard, openCodeRules };
