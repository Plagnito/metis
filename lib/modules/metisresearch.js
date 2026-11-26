'use strict';

// Derived, bounded views over Atlas. No parallel corpus, runtime or orchestrator.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const U = () => require('../url'); // adresses publiques de l'instance (hôte)
const M = () => require('./metisdocs');
const X = () => require('./metisexperts');
const A = () => require('./metisarchitecture');
const J = require('./metis-research-journal');
const DOMAINS = ['document', 'fiche', 'architecture', 'expert', 'benchmark', 'pool', 'competence', 'metric', 'note', 'contract', 'agent', 'work', 'handoff', 'review','source','claim','evidence','decision','dataset','protocol','run','session','research_note','subscription','project'];
const KINDS = ['document', 'fiche', 'architecture', 'expert', 'benchmark', 'pool', 'competence', 'metric', 'note', 'work_item','source','claim','evidence','decision','dataset','protocol','run','session','research_note','subscription','project','task','project_note','milestone','project_context','project_checkpoint','project_evidence','project_document','project_session'];
const NAMES = new Set(['changes_since', 'metis_overview', 'search_everything', 'context_pack', 'validate_context_pack', 'audit_triage', 'impact_analysis', 'propose_repairs']);
function enabled(name) {
  return process.env.METIS_RESEARCH_ENABLED === '1'
    && (!['context_pack','validate_context_pack'].includes(name) || process.env.METIS_CONTEXT_ENABLED === '1')
    && (!['audit_triage','impact_analysis','propose_repairs'].includes(name) || process.env.METIS_AUDIT_ENABLED === '1');
}
const size = x => Buffer.byteLength(JSON.stringify(x));
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const rates = new Map();
let contract = null;
let access = null; // Synchronous request-local ACL snapshot; refreshed for every call.
class ContractError extends Error {
  constructor(code, message, retryable = false, details) { super(message); Object.assign(this, { code, retryable, details }); }
}
const fail = (code, message, retryable = false, details) => { throw new ContractError(code, message, retryable, details); };
function integer(x, fallback, min, max, name) {
  if (x === undefined) return fallback;
  if (!Number.isSafeInteger(x) || x < min || x > max) fail('INVALID_ARGUMENT', `${name}: entier entre ${min} et ${max}.`);
  return x;
}
function list(x, values, fallback, name) {
  if (x === undefined) return fallback;
  if (!Array.isArray(x) || x.length > values.length || x.some(v => !values.includes(v)) || new Set(x).size !== x.length) fail('INVALID_ARGUMENT', name + ': liste de valeurs connues et uniques.');
  return [...x].sort();
}
function init() { M().init(); X().init(); A().init(); J.install(db); require('./metis-access-fence').register(); }
function high() { return db.prepare('SELECT COALESCE(MAX(seq),0) n FROM metis_research_events').get().n; }
function config() { return contract ??= db.prepare('SELECT * FROM metis_research_contract WHERE id=1').get(); }
function snapshot(version) { return config().epoch + ':' + version; }
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', config().secret).update(body).digest('base64url');
}
function identity(user) { return { account: Number(user), role: access?.user === user ? access.role : M().roleDe(user) }; }
function cursor(payload, user) { return sign({ v: 1, epoch: config().epoch, ...identity(user), ...payload }); }
function decode(token, type, user) {
  if(type==='pack'&&typeof token==='string'&&/^pack:[0-9a-f-]{36}$/.test(token)){
    const row=db.prepare('SELECT data FROM metis_context_manifests WHERE id=? AND account=?').get(token,Number(user));
    if(!row)fail('PERMISSION_DENIED','Contexte absent ou lié à un autre compte.');return JSON.parse(row.data);
  }
  if (typeof token !== 'string' || token.length > (type === 'pack' ? 16000 : 4096)) fail('INVALID_ARGUMENT', 'Curseur invalide.');
  const [body, signature, extra] = token.split('.');
  const expected = crypto.createHmac('sha256', config().secret).update(body || '').digest('base64url');
  if (extra || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail('INVALID_ARGUMENT', 'Curseur invalide.');
  let data; try { data = JSON.parse(Buffer.from(body, 'base64url')); } catch { fail('INVALID_ARGUMENT', 'Curseur invalide.'); }
  if (data.v !== 1 || data.epoch !== config().epoch || data.type !== type || data.account !== Number(user) || data.role !== identity(user).role) fail('STALE_CURSOR', 'Curseur incompatible avec ce journal, compte ou rôle.', false);
  return data;
}
function envelope(request, data, version, extra = {}) { return { ok: true, data, request_id: request, schema_version: '1', snapshot_version: snapshot(version),policy_generation:require('./metis-access-fence').generation(), ...extra }; }
function budget(args, tokenDefault = 12000) {
  const bytes = integer(args.max_bytes, 48000, 2048, 60000, 'max_bytes');
  const tokens = integer(args.max_tokens, tokenDefault, 512, 15000, 'max_tokens');
  // UTF-8 bytes are a deliberately conservative upper bound, not a tokenizer count.
  return Math.min(bytes, tokens);
}
function assertBudget(result,args,tokenDefault=12000,message='Réponse au-delà du budget.',effective=budget(args,tokenDefault)) {
  const required=size(result);if(required<=effective)return result;
  fail('TRUNCATED',message,false,{required_bytes:required,effective_budget_bytes:effective,
    maximum_budget_bytes:15000,accounting:'utf8_bytes',adjust_parameters:Object.hasOwn(args,'goal')&&Object.hasOwn(args,'role')?['budget_tokens','max_tokens','max_bytes']:['max_bytes','max_tokens'],
    fits_maximum_budget:required<=15000,automatic_retry:false});
}
function coveredKinds(){return KINDS.filter(kind=>!['project','task','project_note','milestone','project_context','project_checkpoint','project_evidence','project_document','project_session'].includes(kind)||require('./metisprojects').enabled()).filter(kind=>kind!=='work_item'||process.env.METIS_COLLAB_ENABLED==='1').filter(kind=>!['source','claim','evidence','decision','dataset','protocol','run'].includes(kind)||require('./metisscience').enabled()).filter(kind=>!['session','research_note','subscription'].includes(kind)||require('./metiscontinuity').enabled());}
function visibleResource(id, user, visibility) {
  if(!require('./metis-app-permissions').canRead(user,id))return false;
  if(/^(project|task|project_note|milestone|project_context|project_checkpoint|project_evidence|project_document|project_session):/.test(id))return require('./metisprojects').enabled()&&require('./metis-access-fence').canRead(user,id);
  if(id.startsWith('project:'))return require('./metisprojects').rawReadable(user,id);
  if(/^(channel|thread|message|connection|delivery|usage):/.test(id))return require('./metisnexus').canRead(user,id);
  if(/^(session|research_note|subscription):/.test(id))return require('./metiscontinuity').enabled()&&require('./metis-access-fence').canRead(user,id);
  if(/^(source|claim|evidence|decision|dataset|protocol|run):/.test(id))return require('./metisscience').enabled()&&require('./metis-access-fence').canRead(user,id);
  if (/^(work|handoff|review|agent):/.test(id)) return require('./metiscollaboration').canReadResource(user,id);
  if (id.startsWith('document:')) {
    const status = access?.user === user ? access.documents.get(id.slice(9)) : db.prepare('SELECT statut FROM metis_docs WHERE slug=?').get(id.slice(9))?.statut;
    const writer = access?.user === user ? access.writer : M().peutEcrire(user);
    return !!status && (writer || (status === 'publie' && (!visibility || visibility === 'publie')));
  }
  return true;
}
function event(row) {
  return { event_id: 'evt:' + config().epoch + ':' + row.seq, sequence: row.seq, domain: row.domain, kind: row.kind,
    object_id: row.object_id, resource_id: row.resource_id, revision_before: row.revision_before, revision_after: row.revision_after,
    occurred_at: row.occurred_at, actor_id: row.actor_id, client_identity: row.client_id, epistemic_state: 'known',
    actor_epistemic_state: row.actor_id ? 'known' : 'unknown', provenance: 'Atlas SQLite transactional outbox' };
}
function changes(user, args, request, version) {
  const limit = integer(args.limit, 25, 1, 100, 'limit'), max = budget(args);
  let state = args.cursor === undefined ? null : decode(args.cursor, 'changes', user);
  const domains = list(args.domains, DOMAINS, state?.domains || [...DOMAINS].sort(), 'domains');
  if (state && hash(state.domains) !== hash(domains)) fail('INVALID_ARGUMENT', 'Conserver les mêmes domaines pendant la pagination.');
  if (!state) return envelope(request, { events: [], has_more: false, initialized_from_present: true, covered_domains: DOMAINS,
    unsupported_domains: ['lab_experiment'], history_before_installation: 'unknown' }, version,
  { next_cursor: cursor({ type: 'changes', after: version, upper: null, domains }, user), truncated: false });
  if (!Number.isSafeInteger(state.after) || state.after < 0 || state.after > version || (state.upper !== null && (!Number.isSafeInteger(state.upper) || state.upper > version || state.upper < state.after))) fail('STALE_CURSOR', 'La position du curseur est absente du journal.');
  const upper = state.upper ?? version;
  let after = state.after,lastDelivered=after;
  const data = { events: [], has_more: false, covered_domains: DOMAINS, unsupported_domains: ['lab_experiment'] };
  const make = more => envelope(request, { ...data, has_more: more }, upper, { next_cursor: cursor({ type: 'changes', after, upper: more ? upper : null, domains }, user), truncated: more });
  // Bounded scan even for many invisible rows. Empty intermediate pages may have has_more=true.
  const rows = db.prepare('SELECT * FROM metis_research_events WHERE seq>? AND seq<=? ORDER BY seq LIMIT 1000').all(after, upper);
  for (const row of rows) {
    if (!domains.includes(row.domain) || !visibleResource(row.resource_id, user, row.visibility)) { after = row.seq; continue; }
    if (data.events.length >= limit) return make(true);
    const previous = after;
    data.events.push(event(row)); after = row.seq;
    const candidate=make(after<upper);
    if (size(candidate) > max) {
      if (data.events.length===1) assertBudget(candidate,args);
      data.events.pop(); after = previous;
      return make(true);
    }
    lastDelivered=after;
  }
  const result=make(after<upper);if(size(result)>max&&data.events.length&&lastDelivered<upper){after=lastDelivered;return make(true);}return result;
}
function corpus(user) {
  const appScope=require('./metis-app-permissions').hasResourceScope();
  const projects=require('./metisprojects').enabled()?require('./metisprojects').corpusSql(user)+require('./metisdevelopment').corpusSql(user):'';
  const readable = (access?.user === user ? access.writer : M().peutEcrire(user)) ? '1' : "d.statut='publie'";
  const work=process.env.METIS_COLLAB_ENABLED==='1'?` UNION ALL SELECT w.id,'work_item',json_extract(w.data,'$.title'),json_extract(w.data,'$.goal'),' ',w.revision,'work',json_extract(w.data,'$.state'),CAST(w.owner_account AS TEXT),w.updated_at,NULL,w.visibility FROM metis_work_items w WHERE ${require('./metiscollaboration').workAclSql('w',user)}`:'';
  const science=require('./metisscience').enabled()?` UNION ALL SELECT s.id,s.kind,json_extract(s.data,'$.title'),coalesce(json_extract(s.data,'$.description'),json_extract(s.data,'$.statement'),json_extract(s.data,'$.rationale'),json_extract(s.data,'$.method'),json_extract(s.data,'$.passage'),''),s.data,s.revision,s.kind,coalesce(json_extract(s.data,'$.status'),json_extract(s.data,'$.validity'),''),CAST(s.owner_account AS TEXT),s.updated_at,json_extract(s.data,'$.url'),s.visibility FROM metis_science_objects s WHERE ${require('./metisscience').aclSql('s',user)}`:'';
  const continuity=require('./metiscontinuity').enabled()?` UNION ALL SELECT c.id,c.kind,json_extract(c.data,'$.title'),coalesce(json_extract(c.data,'$.goal'),json_extract(c.data,'$.body'),''),c.data,c.revision,c.kind,coalesce(json_extract(c.data,'$.status'),''),CAST(c.owner_account AS TEXT),c.updated_at,NULL,c.visibility FROM metis_continuity_objects c WHERE ${require('./metiscontinuity').aclSql('c',user)}`:'';
  // ACL is applied in each branch, before filtering, excerpts, counts or ranking.
  return `WITH ${appScope?'unfiltered_corpus':'corpus'} AS (
    SELECT 'document:'||d.slug id,'document' kind,d.titre title,d.chapo||' '||d.etiquettes description,d.corps body,d.version revision,d.categorie category,d.statut status,d.auteur author,d.maj_le updated_at,'${U().sql('/metis/')}'||d.slug source_url,CASE WHEN d.statut='publie' THEN 'metis_readers' ELSE 'metis_editors' END visibility FROM metis_docs d WHERE ${readable}
    UNION ALL SELECT 'sigle:'||sigle,'fiche',sigle||' — '||sens,detail,corps,version,categorie,nature,auteur,maj_le,'${U().sql('/metis/glossaire/')}'||sigle,'metis_readers' FROM metis_glossaire
    UNION ALL SELECT 'expert:'||id,'expert',nom,'',donnees,revision,pool,statut,auteur,maj_le,'${U().sql('/metis/experts/')}'||id,'metis_readers' FROM metis_experts
    UNION ALL SELECT 'benchmark:'||id,'benchmark',nom,description,'',NULL,competence,sens,auteur,maj_le,url,'metis_readers' FROM metis_benchmarks
    UNION ALL SELECT 'pool:'||id,'pool',nom,role,description,NULL,type,'',auteur,maj_le,NULL,'metis_readers' FROM metis_pools
    UNION ALL SELECT 'competence:'||id,'competence',nom,description,'',NULL,domaine,'',auteur,maj_le,NULL,'metis_readers' FROM metis_competences
    UNION ALL SELECT 'architecture:'||a.id,'architecture',a.id,json_extract(a.metadata,'$.canonical_subject'),'',a.version,json_extract(a.metadata,'$.architectural_type'),json_extract(a.metadata,'$.lifecycle'),a.auteur,a.le,NULL,'metis_readers' FROM metis_architecture a WHERE substr(a.id,1,9)!='document:' OR EXISTS(SELECT 1 FROM metis_docs d WHERE 'document:'||d.slug=a.id AND ${readable})
    UNION ALL SELECT 'note:'||n.id,'note',d.titre,n.section,n.texte,NULL,d.categorie,CAST(n.resolue AS TEXT),n.auteur,n.le,'${U().sql('/metis/')}'||d.slug||'#notes',CASE WHEN d.statut='publie' THEN 'metis_readers' ELSE 'metis_editors' END FROM metis_notes n JOIN metis_docs d ON d.id=n.doc WHERE ${readable}
    UNION ALL SELECT 'measure:'||id,'metric',metrique,detail,CAST(valeur AS TEXT),NULL,competence,benchmark,auteur,le,NULL,'metis_readers' FROM metis_expert_mesures
    ${work}
    ${science}
    ${continuity}
    ${projects}
  ) ${appScope?', corpus AS (SELECT * FROM unfiltered_corpus WHERE atlas_readable_ref(id,'+Number(user)+')=1)':''} `;
}
function search(user, args, request, version) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 240) fail('INVALID_ARGUMENT', 'query: texte non vide, 240 caractères maximum.');
  const limit = integer(args.limit, 20, 1, 100, 'limit'), max = budget(args);
  const kinds = list(args.kinds, KINDS, [...KINDS].sort(), 'kinds');
  if (args.include_excerpts !== undefined && typeof args.include_excerpts !== 'boolean') fail('INVALID_ARGUMENT', 'include_excerpts: booléen.');
  const filters = args.filters ?? {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.entries(filters).some(([k,v]) => !['id', 'category', 'status', 'author'].includes(k) || typeof v !== 'string' || v.length > 240)) fail('INVALID_ARGUMENT', 'filters: id/category/status/author exacts seulement.');
  const signature = hash({ query: args.query, kinds, filters, excerpts: args.include_excerpts !== false });
  const state = args.cursor === undefined ? null : decode(args.cursor, 'search', user);
  if (state && (state.signature !== signature || state.high !== version)) fail('STALE_CURSOR', 'Le corpus ou la requête a changé ; recommencer la recherche.', true);
  const params = [state?.after || '', ...kinds, ...Object.values(filters), args.query, args.query, args.query];
  const where = `id>? AND kind IN (${kinds.map(() => '?').join(',') || "NULL"})` + Object.keys(filters).map(k => ` AND ${k}=?`).join('') + " AND (instr(atlas_fold(title),atlas_fold(?))>0 OR instr(atlas_fold(COALESCE(description,'')),atlas_fold(?))>0 OR instr(atlas_fold(body),atlas_fold(?))>0)";
  const rows = db.prepare(corpus(user) + `SELECT id,kind,title,revision,category,status,author,updated_at,source_url,visibility,
    substr(COALESCE(description,'')||' '||body, max(1,instr(atlas_fold(COALESCE(description,'')||' '||body),atlas_fold(?))-80),320) snippet
    FROM corpus WHERE ${where} ORDER BY id COLLATE BINARY LIMIT ?`).all(args.query, ...params, limit + 1);
  const covered=coveredKinds();
  const data = { results: [], has_more: false, ranking: 'literal; stable object ID order', covered_kinds: covered,
    unsupported_kinds: ['section','experiment',...KINDS.filter(kind=>!covered.includes(kind))], revision_note: 'null means no native object revision; snapshot_version pins this view' };
  let after = state?.after || '';
  const make = more => envelope(request, { ...data, has_more: more }, version, { next_cursor: more ? cursor({ type: 'search', high: version, signature, after }, user) : null, truncated: more });
  for (const [index,row] of rows.slice(0,limit).entries()) {
    if (args.include_excerpts === false) delete row.snippet;
    Object.assign(row, { epistemic_state: row.revision === null ? 'unknown' : 'known', provenance: 'Atlas canonical resource', content_trust: 'untrusted_data' });
    const previous = after; data.results.push(row); after = row.id;
    const candidate=make(index+1<rows.length);if (size(candidate) > max) { if(data.results.length===1)assertBudget(candidate,args);data.results.pop(); after = previous; return make(true); }
  }
  return make(rows.length > limit);
}
function overview(user, args, request, version) {
  const max = budget(args);
  if (args.scope !== undefined && !['research','architecture','all'].includes(args.scope)) fail('INVALID_ARGUMENT', 'scope: research|architecture|all.');
  const include = list(args.include, ['changes','work','audit','decisions','health'], ['changes','work','audit','decisions','health'], 'include');
  let since = null;
  if (args.since !== undefined) { if (typeof args.since !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.since) || !Number.isFinite(Date.parse(args.since))) fail('INVALID_ARGUMENT', 'since: date ISO-8601 avec fuseau.'); since = new Date(args.since).toISOString(); }
  const counts = db.prepare(corpus(user) + 'SELECT kind,COUNT(*) count FROM corpus GROUP BY kind ORDER BY kind').all();
  const data = { scope: args.scope || 'all', documented_state: { resource_counts: counts, epistemic_state: 'known', provenance: 'Atlas canonical tables' },
    runtime_state: { epistemic_state: 'unknown', measured: null, detail: 'Les déclarations documentaires ne prouvent pas une implémentation runtime.' },
    available_capabilities: [...NAMES].filter(enabled).concat(process.env.METIS_COLLAB_ENABLED==='1'?[...require('./metiscollaboration').NAMES]:[],require('./metisscience').enabled()?[...require('./metisscience').NAMES]:[],require('./metiscontinuity').enabled()?[...require('./metiscontinuity').NAMES]:[],require('./metisprojects').enabled()?[...require('./metisdevelopment').NAMES]:[]),
    // Ce champ ne couvre que le registre de recherche ; sans le dire, un client qui voyait
    // ~170 outils dans tools/list concluait que le reste était masqué ou cassé (vécu le 20/10).
    available_capabilities_scope: 'Familles recherche, collaboration, sciences, reprise et projets. Documents, experts, architecture et pages web sont toujours actifs : le catalogue complet est tools/list.',
    tool_catalogue: (() => { try { return { total: require('../host').get('mcp').outils(M().peutEcrire(user)).length, source: 'tools/list sans les outils Metis Lab' }; } catch { return { total: null, source: 'tools/list' }; } })(),
    detail_tools: ['changes_since','search_everything','audit_registre','query_architecture','graphe_architecture','canonicalite'],
    content_trust: 'untrusted_data', feed_cursor: cursor({ type: 'changes', after: version, upper: null, domains: [...DOMAINS].sort() }, user) };
  if (include.includes('changes')) {
    const rows = db.prepare('SELECT * FROM metis_research_events WHERE seq<=? ORDER BY seq DESC LIMIT 1000').all(version);
    data.changes = rows.filter(r => (!since || r.occurred_at >= since) && visibleResource(r.resource_id,user,r.visibility) && (args.scope !== 'architecture' || ['architecture','expert','benchmark','fiche'].includes(r.domain))).slice(0,8).map(event);
    data.changes_window = { inspected_at_most: 1000, truncated: rows.length === 1000, history_before_installation: 'unknown' };
  }
  if (include.includes('audit')) { const audit = A().audit(user,{limit:1}); data.audit = { entries:audit.entries,counts:audit.counts,epistemic_state:'known',detail:'Signalements documentaires ; pas un nombre de bugs prouvés.',provenance:'audit_registre',details_tool:'audit_registre' }; }
  if (include.includes('work')) data.work = process.env.METIS_COLLAB_ENABLED==='1'?require('./metiscollaboration').workOverview(user):{ epistemic_state:'unknown',available:false,detail:'Lot WorkItems désactivé.' };
  if (include.includes('decisions')) data.decisions = require('./metisscience').enabled()?require('./metisscience').overview(user):{ epistemic_state:'unknown',available:false,detail:'Registre de décisions désactivé.' };
  if (include.includes('health')) data.health = { atlas_storage:'available',lab:{epistemic_state:'unknown',detail:'Consulter capabilities/health avec consentement metis_lab.'},semantic_index:{required:false,available:false} };
  const signature=hash({scope:args.scope||'all',include,since}),policy=require('./metis-access-fence').generation();
  const state=args.cursor?decode(args.cursor,'overview',user):null;
  if(state&&(state.high!==version||state.policy!==policy||state.signature!==signature))fail('STALE_CURSOR','La vue ou ses droits ont changé ; recommencer.',false);
  const sections=[],base={...data};for(const key of include){const value=data[key];delete base[key];
    if(Array.isArray(value)&&value.length)value.forEach(entry=>sections.push({key,array:true,value:entry}));
    else if(value?.recent?.length){const summary={...value,recent:[]};value.recent.forEach(entry=>sections.push({key,summary,value:entry}));}
    else sections.push({key,value});
  }
  if(state&&(!Number.isSafeInteger(state.after)||state.after<0||state.after>sections.length))fail('STALE_CURSOR','Position de vue incompatible.');
  let position=state?.after??0;const page={...base};
  const make=more=>envelope(request,{...page,has_more:more},version,{next_cursor:more?cursor({type:'overview',high:version,policy,signature,after:position},user):null,truncated:more});
  // Sections retain their existing shape; a signed continuation retrieves omitted sections.
  for(;position<sections.length;){const {key,value,array,summary}=sections[position],previous=page[key];
    page[key]=array?[...(previous||[]),value]:summary?{...summary,recent:[...(previous?.recent||[]),value]}:value;position++;
    const candidate=make(position<sections.length);if(size(candidate)>max){if(previous===undefined)delete page[key];else page[key]=previous;position--;
      if(position===(state?.after??0))assertBudget(candidate,args,12000,'Une section indivisible dépasse le budget ; augmenter max_tokens/max_bytes ou réduire include.');
      return make(true);
    }
  }
  return assertBudget(make(false),args);
}
function resource(user,id) {
  if(require('./metisscience').enabled())require('./metisscience').init();
  if(require('./metiscontinuity').enabled())require('./metiscontinuity').init();
  const row=db.prepare(corpus(user)+'SELECT * FROM corpus WHERE id=?').get(id) || null;
  if(row) row.journal_revision=db.prepare('SELECT MAX(seq) revision FROM metis_research_events WHERE resource_id=?')
    .get(id.startsWith('architecture:') ? id.slice(13) : id).revision;
  return row;
}
function pin(row) {
  return {object_id:row.id,revision:row.revision,journal_revision:row.journal_revision,content_sha256:hash(row),visibility:row.visibility,source_url:row.source_url,
    epistemic_state:row.revision === null ? 'unknown' : 'known',provenance:'Atlas canonical resource'};
}
function validatePack(user,args,request,version) {
  const pack = decode(args.pack_id,'pack',user);
  const expired = pack.expires <= Date.now();
  const stale = [];
  for (const ref of pack.refs) {
    require('./metis-access-fence').assertReadable(user,ref.object_id);
    const current=resource(user,ref.object_id);
    if (!current || hash(current)!==ref.content_sha256) stale.push({object_id:current ? ref.object_id : null,reason:current ? 'revision_or_content_changed' : 'absent_or_inaccessible'});
  }
  return envelope(request,{valid:!expired&&!stale.length,epistemic_state:expired||stale.length?'stale':'known',expired,stale_refs:stale,
    detail:'Un pack dérivé expire ou devient périmé si une source épinglée change. Aucun corps n’est stocké dans le pack_id.'},version);
}
function contextPack(user,args,request,version) {
  if (typeof args.goal !== 'string' || !args.goal.trim() || args.goal.length>1000) fail('INVALID_ARGUMENT','goal: texte non vide, 1000 caractères maximum.');
  if (!['researcher','architect','implementer','reviewer'].includes(args.role)) fail('INVALID_ARGUMENT','role: researcher|architect|implementer|reviewer.');
  const tokens=integer(args.budget_tokens,4000,1024,15000,'budget_tokens'),max=Math.min(budget(args),tokens);
  if(args.exclude_private!==undefined&&typeof args.exclude_private!=='boolean')fail('INVALID_ARGUMENT','exclude_private: booléen.');
  if(args.delta_only!==undefined&&typeof args.delta_only!=='boolean')fail('INVALID_ARGUMENT','delta_only: booléen.');
  if(args.delta_only===true&&!args.previous_pack_id)fail('INVALID_ARGUMENT','delta_only exige previous_pack_id et les preuves primaires déjà conservées par le client.');
  const mandatory=args.must_include_ids||[];
  if(!Array.isArray(mandatory)||mandatory.length>12||mandatory.some(id=>typeof id!=='string'||id.length>240)||new Set(mandatory).size!==mandatory.length)fail('INVALID_ARGUMENT','must_include_ids: au plus 12 IDs uniques.');
  const signature=hash({goal:args.goal,role:args.role,mandatory,exclude_private:args.exclude_private!==false,previous_pack_id:args.previous_pack_id??null,...(args.delta_only===true?{delta_only:true}:{})}),policy=require('./metis-access-fence').generation();
  const state=args.cursor?decode(args.cursor,'context',user):null;
  if(state&&(state.high!==version||state.policy!==policy||state.signature!==signature))fail('STALE_CURSOR','Le contexte ou ses droits ont changé ; recommencer.');
  const prior=state?decode(state.pack_id,'pack',user):null;
  if(prior?.expires<=Date.now())fail('STALE_CURSOR','Le contexte a expiré ; recommencer.');
  const selected=new Map(),gaps=[];
  for(const id of mandatory){const row=resource(user,id);if(!row||(args.exclude_private!==false&&row.visibility!=='metis_readers'))fail('NOT_FOUND','Une ressource requise est absente ou inaccessible.');selected.set(id,{row,why:'explicitly_required'});}
  for(const id of ['document:agc-10-minimum-sufficient-architecture-freeze-7-octobre-2026','document:plan-11-auto-amelioration-research','document:plan-13-omega13-microkernel','document:plan-00-vue-ensemble']) {
    const row=resource(user,id);if(!row||(args.exclude_private!==false&&row.visibility!=='metis_readers'))gaps.push({epistemic_state:'unknown',detail:'Référence canonique absente de la sélection autorisée.'});else if(!selected.has(id)&&selected.size<12)selected.set(id,{row,why:'canonical_architecture_and_research_reference'});
  }
  const terms=[...new Set(args.goal.normalize('NFKC').toLocaleLowerCase('fr').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=4))].slice(0,6);
  for(const term of terms){const found=search(user,{query:term,limit:6,include_excerpts:false},request,version).data.results;for(const result of found){if(selected.size>=12)break;if(!selected.has(result.id)){const row=resource(user,result.id);if(row&&(args.exclude_private===false||row.visibility==='metis_readers'))selected.set(row.id,{row,why:'literal_goal_term:'+term});}}}
  const refs=[],excerpts=[];
  const data={pack_id:null,subject_id:'atlas:'+Number(user),created_at:prior?.created_at||new Date().toISOString(),policy_generation:policy,goal:args.goal,role:args.role,manifest:refs,excerpts,selection_method:'canonical references plus literal goal terms; no generated factual summary',known_gaps:gaps,
    open_questions:[{epistemic_state:'unknown',question:'Les déclarations documentaires correspondent-elles à des preuves runtime ?'}],conflicts:{epistemic_state:'unknown',detail:'Pas de détection automatique de contradictions textuelles.'},
    budget:{requested_tokens:tokens,accounting:'UTF-8 byte ceiling equal to token budget; model tokenizer unmeasured',max_bytes:max},content_trust:'untrusted_data',expires_at:prior?.expires_at||new Date(Date.now()+3600e3).toISOString()};
  let previousRefs=new Map();
  if(args.previous_pack_id){const previous=validatePack(user,{pack_id:args.previous_pack_id},request,version);data.changes_since_previous_pack=previous.data;
    if(args.delta_only===true){if(previous.data.expired)fail('STALE_CURSOR','Le contexte de base a expiré ; reconstruire un pack complet.');
      previousRefs=new Map(decode(args.previous_pack_id,'pack',user).refs.map(ref=>[ref.object_id,ref.content_sha256]));
      data.delta={base_pack_id:args.previous_pack_id,client_must_retain_primary_evidence:true,method:'omit excerpts only when the complete canonical resource hash is unchanged; all current ACLs rechecked',summary_is_primary_evidence:false};}}
  const expires=Date.parse(data.expires_at);
  const packId=state?.pack_id||'pack:'+crypto.randomUUID(),offset=state?.after??0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>selected.size)fail('STALE_CURSOR','Position de contexte incompatible.');
  const make=()=>{const more=offset+refs.length<selected.size;return envelope(request,{...data,pack_id:packId,summary_dependencies:refs.map(r=>r.object_id),content_digest:hash(excerpts),content_digest_scope:'current_page_excerpts',has_more:more},version,{truncated:more,next_cursor:more?cursor({type:'context',pack_id:packId,after:offset+refs.length,high:version,policy,signature},user):null});};
  const append=({row,why})=>{refs.push({...pin(row),acl_generation:data.policy_generation,why_included:why});
    excerpts.push({source_id:row.id,revision:row.revision,title:row.title,excerpt:'',excerpt_truncated:true,content_trust:'untrusted_data'});};
  // Reserve every mandatory reference before allocating excerpt bytes. A long body
  // must not exclude a later mandatory source when its version/hash still fit.
  const required=state?[]:mandatory;for(const id of required)append(selected.get(id));
  assertBudget(make(),args,12000,'Le manifeste obligatoire dépasse le budget ; ajuster budget_tokens/max_tokens/max_bytes.',max);
  const fill=(row,index)=>{if(args.delta_only===true&&previousRefs.get(row.id)===hash(row)){excerpts[index].excerpt_omitted_because_unchanged=true;return;}
    const full=row.description+'\n'+row.body,points=Array.from(full.slice(0,802));
    if(points.length&&/^[\uD800-\uDBFF]$/.test(points.at(-1)))points.pop();
    const record=excerpts[index],set=count=>{record.excerpt=points.slice(0,count).join('');record.excerpt_truncated=record.excerpt.length<full.length;};let low=0,high=Math.min(points.length,800);
    while(low<high){const middle=Math.ceil((low+high)/2);set(middle);if(size(make())<=max)low=middle;else high=middle-1;}set(low);
  };
  for(let index=0;index<required.length;index++)fill(selected.get(required[index]).row,index);
  for(const entry of [...selected.values()].slice(offset)){
    if(required.includes(entry.row.id))continue;append(entry);
    const candidate=make();if(size(candidate)>max){if(refs.length===1)assertBudget(candidate,args,12000,'Une référence indivisible dépasse le budget.',max);excerpts.pop();refs.pop();break;}fill(entry.row,excerpts.length-1);
  }
  const out=make();assertBudget(out,args,12000,'Le manifeste ou le curseur dépasse le budget.',max);
  if(out.data.has_more&&!refs.length)assertBudget({...out,data:{...out.data,manifest:[pin([...selected.values()][offset].row)]}},args,12000,'Une référence indivisible dépasse le budget.',max);
  if(state)return out;
  db.prepare('DELETE FROM metis_context_manifests WHERE account=? AND expires<?').run(Number(user),Date.now());
  if(db.prepare('SELECT count(*) n FROM metis_context_manifests WHERE account=?').get(Number(user)).n>=100)fail('INVALID_ARGUMENT','Quota de contextes actifs atteint.');
  const allRefs=[...selected.values()].map(({row})=>({...pin(row),acl_generation:policy}));
  db.prepare('INSERT INTO metis_context_manifests VALUES(?,?,?,?)').run(packId,Number(user),expires,JSON.stringify({type:'pack',subject_id:data.subject_id,created_at:data.created_at,expires_at:data.expires_at,expires,refs:allRefs,source_revisions:allRefs.map(r=>({source_id:r.object_id,revision:r.revision})),policy_generation:policy,summary_dependencies:allRefs.map(r=>r.object_id),content_digest:out.data.content_digest}));return out;
}
const interpretations={
  missing_owner:['info','Absence de déclaration ; le responsable réel peut exister.','needs_review'],
  untyped:['info','Classification inconnue ; aucun type ne peut être choisi automatiquement.','needs_review'],
  orphan:['info','Absence de liens enregistrés ; aucune preuve d’inutilité.','needs_review'],
  runtime_not_implemented:['review','Une déclaration proposed/designed peut être normale ; aucun défaut runtime prouvé.','defer'],
  competing_authorities:['review','Plusieurs autorités déclarées sur un même sujet ; arbitrage humain requis.','needs_review'],
  dangling_reference:['review','Cible absente ou inaccessible ; vérifier provenance et ACL.','needs_review'],
};
function findings(user) {
  const nodes=A().snapshot(user),all=A().auditData(nodes,A().edgesFor(nodes));
  const counts={};for(const f of all)counts[f.code]=(counts[f.code]||0)+1;
  const raw={total:all.length,counts};
  // Existing audit may refer to a hidden target. Suppress any inaccessible typed ID before returning evidence.
  const safe=f=>({...f,ids:f.ids.filter(id=>visibleResource(id,user)),detail:f.detail.replace(/document:[^\s,;]+/g,id=>visibleResource(id,user)?id:'[inaccessible]')});
  return {raw,items:all.map(safe).map(f=>({...f,finding_id:'finding:'+hash(f),epistemic_state:'known',provenance:'audit_registre'}))};
}
function triage(user,args,request,version) {
  const limit=integer(args.limit,25,1,100,'limit'),max=budget(args),all=findings(user);
  const codes=args.codes||null;
  if(codes&&(!Array.isArray(codes)||codes.length>30||codes.some(c=>typeof c!=='string')))fail('INVALID_ARGUMENT','codes: liste de codes.');
  if(args.baseline_revision&&args.baseline_revision!==snapshot(version))fail('REVISION_CONFLICT','Le snapshot de référence a changé.');
  if(args.scope!==undefined&&(typeof args.scope!=='string'||args.scope.length>240))fail('INVALID_ARGUMENT','scope: préfixe ID typé.');
  const signature=hash({codes,scope:args.scope||null});const state=args.cursor?decode(args.cursor,'triage',user):null;
  if(state&&(state.high!==version||state.signature!==signature))fail('STALE_CURSOR','Audit changé ; recommencer.',true);
  const candidates=all.items.filter(f=>(!codes||codes.includes(f.code))&&(!args.scope||f.ids.some(id=>id.startsWith(args.scope)))).sort((a,b)=>a.finding_id.localeCompare(b.finding_id));
  const items=[],data={raw_count:all.raw.total,raw_counts:all.raw.counts,filtered_count:candidates.length,findings:items,grouping:'code; no speculative deduplication',writes:false};let after=state?.after||'';
  const make=more=>envelope(request,{...data,has_more:more},version,{next_cursor:more?cursor({type:'triage',high:version,signature,after},user):null,truncated:more});
  const remaining=candidates.filter(f=>f.finding_id>after);
  for(const f of remaining.slice(0,limit)){const [severity,reason,treatment]=interpretations[f.code]||['review','Déclaration à comparer aux preuves avant de conclure.','needs_review'];const previous=after;items.push({...f,severity,severity_reason:reason,proposed_treatment:treatment,evidence_refs:f.ids,confidence:'documentary_signal_only'});after=f.finding_id;if(size(make(true))>max){items.pop();after=previous;if(!items.length)fail('TRUNCATED','Finding au-delà du budget.',true);return make(true);}}
  return make(remaining.length>limit);
}
function impact(user,args,request,version) {
  if(!Array.isArray(args.object_ids)||!args.object_ids.length||args.object_ids.length>12||args.object_ids.some(id=>typeof id!=='string'||id.length>240))fail('INVALID_ARGUMENT','object_ids: 1 à 12 IDs typés.');
  const depth=integer(args.max_depth,3,1,6,'max_depth'),max=budget(args);
  if(args.proposed_change!==undefined&&(typeof args.proposed_change!=='string'||args.proposed_change.length>1000))fail('INVALID_ARGUMENT','proposed_change: texte de 1000 caractères maximum.');
  const nodes=A().snapshot(user),ids=new Set(nodes.map(n=>n.id));
  if(args.object_ids.some(id=>!ids.has(id)))fail('NOT_FOUND','Objet absent ou inaccessible.');
  let edges=A().edgesFor(nodes);
  if(args.edge_types!==undefined&&(!Array.isArray(args.edge_types)||args.edge_types.some(v=>typeof v!=='string')))fail('INVALID_ARGUMENT','edge_types: liste textuelle.');
  edges=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&(!args.edge_types||args.edge_types.includes(e.type)));
  const results=[],queue=args.object_ids.map(id=>({id,path:[],root:id})),visited=new Set(args.object_ids);let truncated=false;
  const data={roots:args.object_ids,impacts:results,advisory:true,proposed_change:args.proposed_change??null,change_semantics:'unassessed; paths identify possible impacts only',coverage:{epistemic_state:'unknown',detail:'Relations enregistrées uniquement ; une arête absente ne prouve pas l’indépendance. Profondeur et budget bornés.'}};
  const make=()=>envelope(request,data,version,{truncated});
  for(let pos=0;pos<queue.length;pos++){const current=queue[pos];if(current.path.length>=depth)continue;for(const e of edges){const id=e.from===current.id?e.to:e.to===current.id?e.from:null;if(!id||visited.has(id))continue;const path=[...current.path,{from:e.from,to:e.to,type:e.type,traversal_from:current.id}];const n=nodes.find(n=>n.id===id);results.push({object_id:id,kind:n.kind,path,root:current.root,authority:n.authority,benchmark_ids:n.benchmark_ids.filter(id=>ids.has(id)),epistemic_state:'known',provenance:'graphe_architecture'});if(results.length>100||size(make())>max){results.pop();truncated=true;return make();}visited.add(id);queue.push({id,path,root:current.root});}}
  return make();
}
function repairs(user,args,request,version) {
  if(args.dry_run!==true)fail('INVALID_ARGUMENT','propose_repairs exige dry_run:true ; aucune mutation ni commit.');
  const maxChanges=integer(args.max_changes,10,1,25,'max_changes');
  if(args.scope!==undefined&&(typeof args.scope!=='string'||args.scope.length>240))fail('INVALID_ARGUMENT','scope: préfixe ID typé.');
  if(args.finding_ids!==undefined&&(!Array.isArray(args.finding_ids)||args.finding_ids.length>25||args.finding_ids.some(id=>typeof id!=='string')))fail('INVALID_ARGUMENT','finding_ids: au plus 25 IDs.');
  const selected=findings(user).items.filter(f=>(!args.finding_ids||args.finding_ids.includes(f.finding_id))&&(!args.scope||f.ids.some(id=>id.startsWith(args.scope)))).slice(0,maxChanges);
  return envelope(request,{dry_run:true,writes:false,patches:[],needs_review:selected.map(f=>({finding_id:f.finding_id,object_ids:f.ids,precondition:{snapshot_version:snapshot(version)},confidence:'insufficient_evidence',reason:(interpretations[f.code]||[])[1]||'Le registre seul ne permet pas de choisir une correction.',alternatives:['Vérifier les preuves et déclarations avec le responsable','Différer avec justification explicite']})),
    detail:'Aucune réparation suffisamment justifiée pour une application automatique. Utiliser les dry-runs existants après validation explicite.'},version);
}
function rate(user,name) {
  const key = user + ':' + name, now = Date.now(), previous = rates.get(key);
  if (!previous || now-previous.start>=60000) { if (rates.size>=1000) rates.delete(rates.keys().next().value); rates.set(key,{start:now,count:1}); return; }
  if (++previous.count>120) fail('RATE_LIMITED','Quota par compte et outil atteint.',true,{retry_after_seconds:Math.ceil((60000-(now-previous.start))/1000)});
}
function call(name,args,user) {
  const request = crypto.randomUUID();
  try {
    if (!M().peutLire(user)) fail('PERMISSION_DENIED','Accès Métis requis.');
    if (!NAMES.has(name) || !enabled(name)) fail('DEPENDENCY_UNAVAILABLE','Lot désactivé.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_ARGUMENT','Arguments: objet JSON.');
    const allowed = { changes_since:['cursor','domains','limit','max_bytes','max_tokens'],search_everything:['query','kinds','filters','limit','cursor','include_excerpts','max_bytes','max_tokens'],metis_overview:['scope','since','max_tokens','max_bytes','include','cursor'],context_pack:['goal','role','budget_tokens','must_include_ids','exclude_private','previous_pack_id','delta_only','max_bytes','max_tokens','cursor'],validate_context_pack:['pack_id','max_bytes','max_tokens'],audit_triage:['codes','scope','baseline_revision','limit','cursor','max_bytes','max_tokens'],impact_analysis:['object_ids','proposed_change','max_depth','edge_types','max_bytes','max_tokens'],propose_repairs:['finding_ids','scope','max_changes','dry_run','max_bytes','max_tokens'] }[name];
    if (Object.keys(args).some(k=>!allowed.includes(k))) fail('INVALID_ARGUMENT','Paramètre inconnu.');
    rate(user,name); init();if(process.env.METIS_COLLAB_ENABLED==='1')require('./metiscollaboration').init();if(require('./metisscience').enabled())require('./metisscience').init();if(require('./metiscontinuity').enabled())require('./metiscontinuity').init();
    db.exec('SAVEPOINT metis_research_read');
    const previousAccess = access;
    try {
      const version=high();
      access={user,role:M().roleDe(user),writer:M().peutEcrire(user),documents:new Map(db.prepare('SELECT slug,statut FROM metis_docs').all().map(d=>[d.slug,d.statut]))};
      const result=({changes_since:changes,search_everything:search,metis_overview:overview,context_pack:contextPack,validate_context_pack:validatePack,audit_triage:triage,impact_analysis:impact,propose_repairs:repairs}[name])(user,args,request,version);
      assertBudget(result,args);
      db.exec('RELEASE metis_research_read'); return result;
    } catch(e) { db.exec('ROLLBACK TO metis_research_read; RELEASE metis_research_read'); throw e; }
    finally { access=previousAccess; }
  } catch(e) {
    const known=e instanceof ContractError;
    return {ok:false,error:{code:known ? e.code : 'DEPENDENCY_UNAVAILABLE',message:known ? e.message : 'Dépendance Atlas indisponible.',retryable:known ? e.retryable : true,...(known&&e.details?{details:e.details}:{})},request_id:request,schema_version:'1'};
  }
}
module.exports = { call:(name,args,user)=>require('./metis-observability').observe(user,name,()=>require('./metis-access-fence').withScope(user,()=>call(name,args,user))), NAMES, DOMAINS, KINDS, ContractError, enabled, init, resource, pin, hash, high, snapshot, cursor, decode, envelope, budget, assertBudget, integer, rate,coveredKinds };
