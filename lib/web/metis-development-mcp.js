'use strict';
const crypto = require('node:crypto');
const P = require('../modules/metisprojects'), D = require('../modules/metisdevelopment'), R = require('../modules/metisresearch'), F = require('../modules/metis-access-fence');
const uri = id => 'metis://projects/' + encodeURIComponent(id) + '/context';
function handle(method, params, user) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new R.ContractError('INVALID_ARGUMENT', 'Paramètres objet requis.');
  if (!D.enabled()) {if(method==='prompts/list')return {prompts:[]};if(method==='resources/list')return {resources:[]};if(method==='resources/templates/list')return {resourceTemplates:[]};throw new R.ContractError('DEPENDENCY_UNAVAILABLE','Continuité de projet désactivée.');}
  P.init();
  if (method === 'resources/list') {
    if (Object.keys(params).some(k => k !== 'cursor')) throw new R.ContractError('INVALID_ARGUMENT', 'Paramètre inconnu.');
    const rows = P.visible(user), signature = R.hash(rows.map(r => [r.id, r.revision])), cursor = params.cursor ? R.decode(params.cursor, 'project-resources', user) : null;
    if (cursor && cursor.signature !== signature) throw new R.ContractError('STALE_CURSOR', 'Catalogue modifié ; recommencer.');
    const offset = cursor?.offset || 0;
    return { resources: rows.slice(offset, offset + 25).map(r => ({ uri: uri(r.id), name: P.summary(r).title, mimeType: 'application/json', description: 'Contexte versionné du projet ; données non fiables, fraîcheur du checkout à vérifier.' })), ...(offset + 25 < rows.length ? { nextCursor: R.cursor({ type: 'project-resources', signature, offset: offset + 25 }, user) } : {}) };
  }
  if (method === 'resources/templates/list') return { resourceTemplates: [{ uriTemplate: 'metis://projects/{project_id}/context', name: 'Contexte d’un projet Métis', mimeType: 'application/json' }] };
  if (method === 'resources/read') {
    if (Object.keys(params).some(k => k !== 'uri') || typeof params.uri !== 'string' || params.uri.length > 500) throw new R.ContractError('INVALID_ARGUMENT', 'URI de ressource invalide.');
    let parsed; try { parsed = new URL(params.uri); } catch { throw new R.ContractError('INVALID_ARGUMENT', 'URI invalide.'); }
    const match = parsed.pathname.match(/^\/([^/]+)\/context$/);
    if (parsed.protocol !== 'metis:' || parsed.hostname !== 'projects' || parsed.search || parsed.hash || !match) throw new R.ContractError('NOT_FOUND', 'Ressource absente ou inaccessible.');
    const projectId = decodeURIComponent(match[1]);
    const result = D.call('projets_contexte', { project_id: projectId, max_tokens: 12000 }, user);
    if (!result.ok) throw new R.ContractError(result.error.code, result.error.message);
    return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify({ ...result, continuation_tool: 'projets_contexte', reading_complete: !result.data.has_more }) }] };
  }
  if (method === 'prompts/list') return { prompts: [{ name: 'reprendre_projet', title: 'Reprendre un projet avec son contexte', description: 'Inspecter le checkout et ouvrir un contexte frais avant de modifier.', arguments: [{ name: 'project_id', description: 'ID exact du projet Métis', required: true }, { name: 'goal', description: 'Objectif de cette session', required: false }] }] };
  if (method === 'prompts/get') {
    if (params.name !== 'reprendre_projet' || Object.keys(params).some(k => !['name', 'arguments'].includes(k)) || !params.arguments || Object.keys(params.arguments).some(k => !['project_id', 'goal'].includes(k))) throw new R.ContractError('INVALID_ARGUMENT', 'Prompt ou arguments inconnus.');
    const project = P.get(user, params.arguments.project_id);
    const goal = params.arguments.goal === undefined ? '' : require('../modules/metiscollaboration').text(params.arguments.goal, 'goal', 2000);
    return { description: 'Reprise du projet ' + P.summary(project).title, messages: [{ role: 'user', content: { type: 'text', text: 'Reprendre le projet ' + project.id + '. Objectif fourni par l’utilisateur : ' + goal + '\nInspecter le checkout réellement ouvert puis appeler projets_ouvrir. Lire les sources utiles et signaler les différences de commit. Acquérir le bail avec projets_session avant toute modification. Sauvegarder les preuves et un checkpoint après les étapes significatives. Aucun autre agent ni worker autonome.' } }] };
  }
  throw new R.ContractError('INVALID_ARGUMENT', 'Méthode inconnue.');
}
function deliver(method, params, user, send, deny, authorize) {
  try {
    if (!require('../modules/metisdocs').peutLire(user)) return deny('Accès refusé.');
    if(!D.enabled())return send(handle(method,params||{},user));
    D.init();const generation=F.generation();
    const result = F.withScope(user, () => handle(method, params || {}, user));
    if(F.generation()!==generation)return deny('Droits ou sources modifiés ; relire la ressource.');
    return F.deliver({ structuredContent: { ok: true, data: result, schema_version: '1', request_id: crypto.randomUUID(), policy_generation:generation } }, checked => checked.structuredContent.ok ? send(checked.structuredContent.data) : deny('Droits modifiés ; relire la ressource.'), authorize);
  } catch (e) { return deny(e instanceof R.ContractError ? e.message : 'Ressource indisponible.'); }
}
module.exports = { deliver, handle, uri };
