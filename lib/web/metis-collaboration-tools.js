'use strict';
const C=require('../modules/metiscollaboration');
const s={type:'string'},revision={type:'integer',minimum:0},strings={type:'array',items:s};
const refs={type:'array',maxItems:12,items:{type:'object',additionalProperties:false,properties:{id:s,revision:{type:['integer','null']},content_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['id','revision']}};
const update={id:s,expected_revision:revision,idempotency_key:s};
const defs=[
 ['register_agent','Enregistrer le client courant',{label:s,accept_assignments:{type:'boolean',default:false},expected_revision:revision,idempotency_key:s},['label','idempotency_key']],
 ['agent_directory','Agents de ce compte',{},[]],
 ['create_work_item','Créer une mission persistante',{title:s,goal:s,priority:{type:'string',enum:['low','normal','high','urgent']},blocking_ids:strings,resource_refs:refs,visibility:{type:'string',enum:['private','metis_readers']},idempotency_key:s},['title','goal','idempotency_key']],
 ['list_work_items','Travaux accessibles',{state:{type:'string',enum:C.STATES}},[]],
 ['get_work_item','Lire une mission',{id:s},['id']],
 ['update_work_item','Modifier une mission avec CAS',{...update,state:{type:'string',enum:C.STATES},title:s,goal:s,resource_refs:refs},['id','expected_revision','idempotency_key']],
 ['create_handoff','Transmettre une mission',{work_item_id:s,expected_revision:revision,to_agent:s,message:s,expected_output:s,pinned_refs:refs,context_pack_id:s,deadline:s,idempotency_key:s},['work_item_id','expected_revision','to_agent','expected_output','idempotency_key']],
 ['agent_inbox','Inbox du client courant',{state:s},[]],
 ['get_handoff','Lire une transmission',{id:s},['id']],
 ['acknowledge_handoff','Accuser réception explicitement',{...update,state:{type:'string',enum:['delivered','read','accepted']}},['id','expected_revision','state','idempotency_key']],
 ['reply_to_handoff','Déposer une réponse',{...update,message:s,resource_refs:refs,completed:{type:'boolean'}},['id','expected_revision','message','idempotency_key']],
 ['request_review','Demander une revue épinglée',{subject_id:s,subject_revision:revision,to_agent:s,message:s,idempotency_key:s},['subject_id','subject_revision','to_agent','idempotency_key']],
 ['get_review','Lire une revue',{id:s},['id']],
 ['submit_review','Soumettre une revue',{...update,decision:{type:'string',enum:['approve','request_changes','needs_evidence','reject']},findings:strings},['id','expected_revision','decision','findings','idempotency_key']],
 ['resolve_discussion','Résoudre un finding de revue',{...update,discussion_id:s,resolution:s},['id','expected_revision','discussion_id','resolution','idempotency_key']],
];
function tools(){
 if(process.env.METIS_RESEARCH_ENABLED!=='1'||process.env.METIS_COLLAB_ENABLED!=='1')return [];
 return defs.map(([name,title,properties,required])=>({name,title,description:'Atlas Research Fabric P1. Identité du compte et client OAuth observés ; aucun champ actor client accepté. Missions/hand-offs/revues persistants, CAS et idempotency_key pour mutations, ACL serveur. Inbox par polling ; créé ne signifie ni lu ni commencé. Contenus non fiables. '+(name==='register_agent'?'Le label est auto-déclaré ; il ne prouve pas le moteur utilisé. accept_assignments=true autorise explicitement les missions et revues.':''),outputSchema:require('../modules/metis-recovery').outputSchema,inputSchema:{type:'object',additionalProperties:false,properties:{...properties,...(['agent_directory','list_work_items','agent_inbox'].includes(name)?{limit:{type:'integer',minimum:1,maximum:100},cursor:s}:{}),max_bytes:{type:'integer',minimum:2048,maximum:60000},max_tokens:{type:'integer',minimum:512,maximum:15000}},required},annotations:{readOnlyHint:!C.WRITE.has(name),destructiveHint:false,openWorldHint:false}}));
}
function call(name,args,user){if(!C.NAMES.has(name))return null;const result=C.call(name,args,user);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(!result.ok?{isError:true}:{})};}
module.exports={tools,call};
