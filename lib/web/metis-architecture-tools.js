'use strict';
const A = require('../modules/metisarchitecture');
const B = require('../modules/metisbatch');
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string' };
const texts = { type: 'array', items: text, maxItems: 100 };
const pagination = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } };
const metadata = object({
  ...Object.fromEntries(Object.entries(A.ENUMS).map(([k, values]) => [k, { type: ['string', 'null'], enum: [...values, null] }])),
  ...Object.fromEntries(A.LISTS.map(k => [k, { type: ['array', 'null'], items: text, maxItems: 100 }])),
  ...Object.fromEntries(A.STRINGS.map(k => [k, { type: ['string', 'null'], maxLength: 240 }])),
  writes_persistent_state: { type: ['boolean', 'null'] },
  relations: { type: ['array', 'null'], maxItems: 100, items: object({ type: { type: 'string', enum: A.RELATIONS }, target: text }, ['type', 'target']) },
});
const batchOptions = { offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 4096, maximum: B.MAX_BYTES }, include_body: { type: 'boolean' } };
const transaction = { dry_run: { type: 'boolean', default: true }, empreinte_attendue: { type: 'string', description: 'Empreinte du diff renvoyée par le dry-run ; obligatoire pour commit.' } };
function tools(writer) {
  const result = [
    { name: 'query_architecture', title: 'Interroger le registre transversal', description: 'Fiches, documents/plans, experts, benchmarks, métriques, compétences et pools. IDs préfixés sigle:, document:, expert:, benchmark:, metric:, competence:, pool:. Métadonnées absentes=null. Filtres AND : valeurs exactes ou {op:eq|ne|in|contains|gt|gte|lt|lte|is_null,value}. Champs : ' + A.FIELDS.join(', ') + ', id, kind, nature, measured, has_benchmark, authority_count, dependency_degree, architecture_version. measured=null signifie inconnu ; ne:true inclut les inconnus. authority_count regroupe les source_of_truth actives par canonical_subject et authority_refs. Pagination max 500.', inputSchema: object({ filters: { type: 'object' }, ...pagination }), annotations: read },
    { name: 'audit_registre', title: 'Auditer le registre', description: 'Entrées non typées, composants sans benchmark, experts sans mesure, autorités concurrentes (canonical_subject), sigles/alias en collision, owner absent, runtime non implémenté, preuves manquantes, références dépréciées ou absentes, cycles de dépendance et orphelins. Counts sur tout le registre visible ; findings paginés.', inputSchema: object({ codes: texts, ...pagination }), annotations: read },
    { name: 'graphe_architecture', title: 'Graphe transversal', description: 'Nœuds et liens typés entre composants, protocoles, métriques, benchmarks, experts, plans et autorités. Degrés entrants/sortants, dépendances, cycles (composantes fortement connexes de depends_on), orphelins et références absentes. Les relations déclarées et les liens du registre expert ont une provenance. Pagination séparée des nœuds et liens.', inputSchema: object({ ...pagination, edge_offset: { type: 'integer', minimum: 0 }, edge_limit: { type: 'integer', minimum: 1, maximum: 500 } }), annotations: read },
    { name: 'canonicalite', title: 'Résoudre une autorité et ses anciens termes', description: 'Autorité actuelle d’un ID, sigle, alias ou canonical_subject ; conflits, vues dérivées et occurrences des anciens termes/alias dans les documents et fiches visibles. Aucun choix arbitraire si plusieurs autorités ou aucune déclaration.', inputSchema: object({ subject: text, ...pagination }, ['subject']), annotations: read },
    { name: 'proposer_gc', title: 'Proposer des candidats de simplification', description: 'Propositions KEEP / MERGE / DEMOTE / CONDITIONAL / TOMBSTONE, avec anomalies et preuves. Consultatif : ne modifie et ne supprime rien, décision humaine à confirmer par benchmarks.', inputSchema: object(pagination), annotations: read },
    { name: 'historique_architecture', title: 'Historique des métadonnées', description: 'Révisions des métadonnées d’un objet ; architecture_version est indépendant de la version de la fiche/publication ou de la révision de l’expert.', inputSchema: object({ id: text, ...pagination }, ['id']), annotations: read },
    { name: 'lire_fiches', title: 'Lire plusieurs fiches en un appel', description: 'Entre 1 et 100 sigles, versions et sections de leurs fiches. include_body=false pour un audit compact. Résultats individuels, erreurs partielles, next_offset si budget dépassé (max_bytes <=786432).', inputSchema: object({ sigles: { ...texts, minItems: 1 }, ...batchOptions }, ['sigles']), annotations: read },
    { name: 'lire_batch', title: 'Lire fiches, sections et publications en lot', description: 'Entre 1 et 100 demandes {id,section?,version?}. IDs sigle:, document:, expert:. Sections par titre exact ou numéro (1..), versions conservées et données graphiques jointes. Résultats individuels et pagination au budget d’octets.', inputSchema: object({ requests: { type: 'array', minItems: 1, maxItems: 100, items: object({ id: text, section: { type: ['string', 'integer'] }, version: { type: 'integer', minimum: 1 } }, ['id']) }, ...batchOptions }, ['requests']), annotations: read },
  ];
  if (writer) result.push(
    { name: 'modifier_architecture', title: 'Modifier des métadonnées en transaction', description: 'Lot atomique de 1 à 100 objets, patches de métadonnées. version_attendue=architecture_version de query_architecture (0 si aucune déclaration). Champs non fournis conservés, null efface une déclaration. canonical_owner/relations/authority_refs sont des IDs préfixés ; canonical_subject regroupe les sources de vérité ; evidence_refs et implementation_refs citent des preuves. dry_run=true par défaut : diff et empreinte sans écriture. Commit : mêmes changes, dry_run=false et empreinte_attendue ; conflit ou erreur annule tout. Historique conservé.', inputSchema: object({ changes: { type: 'array', minItems: 1, maxItems: 100, items: object({ id: text, version_attendue: { type: 'integer', minimum: 0 }, metadata }, ['id', 'version_attendue', 'metadata']) }, ...transaction }, ['changes']), annotations: write },
    { name: 'rediger_fiches', title: 'Modifier des fiches en transaction', description: 'Lot atomique de rediger_fiche, avec version_attendue obligatoire pour chaque fiche (0 pour créer). Modifie nature, définitions, corps ou sections. dry_run=true par défaut, diff puis commit avec empreinte_attendue et versions inchangées. Une seule erreur annule le lot, historique conservé.', inputSchema: object({ fiches: { type: 'array', minItems: 1, maxItems: 100, items: object({ sigle: text, version_attendue: { type: 'integer', minimum: 0 }, sens: text, detail: text, categorie: text, nature: { type: 'string', enum: [...require('../modules/metisdocs').NATURES, ''] }, corps: text, section: { type: ['integer', 'string'] }, mode: { type: 'string', enum: require('../modules/metisdocs').MODES_SECTION }, nouveau_titre: text }, ['sigle', 'version_attendue']) }, ...transaction }, ['fiches']), annotations: write }
  );
  return result;
}
function call(name, args, user, opts) {
  const map = { query_architecture: A.query, audit_registre: A.audit, graphe_architecture: A.graph, canonicalite: A.canonical, proposer_gc: A.gc, historique_architecture: A.history, modifier_architecture: A.mutate, lire_fiches: B.read, lire_batch: B.read, rediger_fiches: B.write };
  if (!map[name]) return null;
  try { validateSchema(args, tools(true).find(t => t.name === name).inputSchema, 'arguments'); const r = map[name](user, args, opts); return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, ...(r.ok === false ? { isError: true } : {}) }; }
  catch (e) { const r = { ok: false, error: e.message }; return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, isError: true }; }
}
function validateSchema(value, schema, path) {
  if(!schema||!Object.keys(schema).length)return;
  if(schema.anyOf&&!schema.anyOf.some(part=>{try{validateSchema(value,part,path);return true;}catch{return false;}}))throw new Error(path+' : aucune alternative valide.');
  if(Object.hasOwn(schema,'const')&&JSON.stringify(value)!==JSON.stringify(schema.const))throw new Error(path+' : constante attendue.');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type&&!types.includes(type) && !(type === 'integer' && types.includes('number'))) throw new Error(path + ' : type attendu ' + types.join('|'));
  if (schema.enum && !schema.enum.includes(value)) throw new Error(path + ' : valeur hors enum.');
  if (type === 'integer' || type === 'number') { if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(path + ' : nombre hors limites.'); }
  if (type === 'string' && schema.maxLength && value.length > schema.maxLength) throw new Error(path + ' : texte trop long.');
  if(type==='string'&&(schema.minLength!==undefined&&value.length<schema.minLength||schema.pattern&&!new RegExp(schema.pattern,'u').test(value)))throw new Error(path+' : texte hors contrat.');
  if (type === 'array') {
    if ((schema.minItems && value.length < schema.minItems) || (schema.maxItems && value.length > schema.maxItems)) throw new Error(path + ' : taille du lot hors limites.');
    value.forEach((v, i) => validateSchema(v, schema.items, path + '[' + i + ']'));
    if(schema.uniqueItems&&new Set(value.map(v=>JSON.stringify(v))).size!==value.length)throw new Error(path+' : éléments uniques requis.');
  }
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(path + '.' + key + ' obligatoire.');
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[key]) validateSchema(v, schema.properties[key], path + '.' + key);
      else if (schema.additionalProperties === false) throw new Error(path + '.' + key + ' inconnu.');
    }
  }
}
module.exports = { tools, call,validateSchema };
