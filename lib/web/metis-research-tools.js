'use strict';
const R = require('../modules/metisresearch');
const integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const strings=values=>({type:'array',items:{type:'string',enum:values},uniqueItems:true});
const limits={limit:integer(1,100),max_bytes:integer(2048,60000),max_tokens:integer(512,15000)};
const definitions=[
  ['changes_since','Changements depuis un curseur','Journal Atlas transactionnel. Sans cursor : initialise depuis le présent. Reprendre next_cursor avec les mêmes domains ; has_more peut être vrai sur une page vide. ACL actuelles, curseur signé lié au compte/rôle, snapshots cohérents ; historique préinstallation inconnu.',{cursor:{type:'string'},domains:strings(R.DOMAINS),...limits}],
  ['metis_overview','Vue de reprise Métis','Vue bornée, budget par défaut 12 000 octets UTF-8 conservateurs. Continuer next_cursor avec les mêmes scope/since/include pour les sections restantes ; STALE_CURSOR si le journal ou les droits changent. État documenté distinct du runtime inconnu. Aucun job ni entraînement.',{scope:{type:'string',enum:['research','architecture','all']},since:{type:'string'},include:strings(['changes','work','audit','decisions','health']),cursor:{type:'string'},max_bytes:limits.max_bytes,max_tokens:{...limits.max_tokens,default:12000}}],
  ['search_everything','Recherche fédérée Métis','Recherche littérale dans les tables Atlas existantes, ACL avant sélection et extraits. Filtres exacts, IDs typés, révisions, provenance. Pagination stable tant que le corpus ne change pas ; STALE_CURSOR sinon. Pas de second index. Contenus non fiables.',{query:{type:'string',maxLength:240},kinds:strings(R.KINDS),filters:{type:'object',additionalProperties:false,properties:Object.fromEntries(['id','category','status','author'].map(k=>[k,{type:'string'}]))},cursor:{type:'string'},include_excerpts:{type:'boolean'},...limits},['query']],
];
definitions.push(
  ['context_pack','Contexte de reprise épinglé','Extraits fidèles, manifeste de versions/hashes et inconnus explicites. Les références obligatoires sont réservées avant les extraits ; extrait raccourci signalé par excerpt_truncated. Continuer next_cursor avec les mêmes critères pour toutes les références ; content_digest porte les extraits de la page courante. Pack lié au compte/rôle, expiration 1 h ; validate_context_pack vérifie toutes ses sources. delta_only=true avec previous_pack_id omet uniquement les extraits aux hashes inchangés ; le client doit conserver leurs preuves primaires. Corps complets par read_bundle/knowledge_export.',{goal:{type:'string',maxLength:1000},role:{type:'string',enum:['researcher','architect','implementer','reviewer']},budget_tokens:integer(1024,15000),must_include_ids:{type:'array',maxItems:12,items:{type:'string'}},exclude_private:{type:'boolean',default:true},previous_pack_id:{type:'string'},delta_only:{type:'boolean',default:false},cursor:{type:'string'},max_bytes:limits.max_bytes,max_tokens:limits.max_tokens},['goal','role']],
  ['validate_context_pack','Vérifier un contexte','Relire les ACL, versions et hashes des sources épinglées. valid=false pour expiration, disparition ou changement de source ; aucune consommation ni read receipt inventé.',{pack_id:{type:'string'},max_bytes:limits.max_bytes,max_tokens:limits.max_tokens},['pack_id']],
  ['audit_triage','Triage consultatif de l’audit','Signalements regroupables par code, décompte brut conservé, sévérité argumentée, preuves et traitement proposé. Inconnus préservés ; aucune correction automatique. Pagination signée, conflit de snapshot explicite.',{codes:{type:'array',items:{type:'string'}},scope:{type:'string'},baseline_revision:{type:'string'},cursor:{type:'string'},...limits}],
  ['impact_analysis','Impact des relations enregistrées','Parcours borné des dépendances et lecteurs/écrivains/autorités avec chemin justificatif. Advisory : absence de relation ne prouve pas l’indépendance. Exclut les cibles inaccessibles.',{object_ids:{type:'array',minItems:1,maxItems:12,items:{type:'string'}},proposed_change:{type:'string',maxLength:1000},max_depth:integer(1,6),edge_types:{type:'array',items:{type:'string'}},max_bytes:limits.max_bytes,max_tokens:limits.max_tokens},['object_ids']],
  ['propose_repairs','Examiner les réparations possibles','dry_run:true obligatoire. Propositions seulement si preuves suffisantes ; cette livraison renvoie needs_review sans patch lorsque le registre seul ne suffit pas. Aucun commit automatique.',{finding_ids:{type:'array',maxItems:25,items:{type:'string'}},scope:{type:'string'},max_changes:integer(1,25),dry_run:{type:'boolean',const:true},max_bytes:limits.max_bytes,max_tokens:limits.max_tokens},['dry_run']]
);
function tools() {
  if(process.env.METIS_RESEARCH_ENABLED!=='1') return [];
  return definitions.filter(([name])=>R.enabled(name)).map(([name,title,description,properties,required])=>({name,title,description,outputSchema:require('../modules/metis-recovery').outputSchema,inputSchema:{type:'object',additionalProperties:false,properties,...(required?{required}:{})},annotations:{readOnlyHint:true,openWorldHint:false}}));
}
function call(name,args,user) {
  if(!R.NAMES.has(name)) return null;
  const result=R.call(name,args,user);
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(!result.ok?{isError:true}:{})};
}
module.exports={tools,call};
