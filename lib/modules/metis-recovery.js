'use strict';
// Static client guidance only: never echo arguments, private IDs or ACL details.
const guidance={
 APP_PERMISSION_DENIED:['check_access','Vérifier les permissions de cette app dans Métis ; ne pas contourner le refus.'],
 APP_PERMISSION_CHANGED:['check_access','Les permissions ont changé ; relire le catalogue et les droits avant de poursuivre.'],
 APP_PERMISSION_UNAVAILABLE:['inspect_availability','Le contrôle des permissions est indisponible ; aucun contournement ni rejeu automatique.'],
 APP_RESPONSE_LIMIT:['adjust_budget_or_selection','Réduire la sélection ou faire modifier le budget par le propriétaire du compte.'],
 INVALID_ARGUMENT:['correct_arguments','Corriger les arguments selon le schéma courant de tools/list.'],
 REVISION_CONFLICT:['read_current_revision','Relire les objets autorisés, comparer les versions et réconcilier avant une nouvelle écriture.'],
 STALE_CURSOR:['restart_view','Recommencer cette sélection sans curseur ; conserver les critères et vérifier les versions.'],
 RATE_LIMITED:['wait','Attendre le délai indiqué avant de réessayer.'],
 TRUNCATED:['adjust_budget_or_selection','Augmenter le budget autorisé ou réduire la sélection, les notes ou la plage de lecture.'],
 PERMISSION_DENIED:['check_access','Vérifier le compte, les droits et le consentement ; ne pas contourner le refus.'],
 PATH_DENIED:['check_access','Le chemin est interdit par la politique ; vérifier les droits sans contourner le confinement.'],
 CONFLICT:['read_current_revision','Relire l’état courant et réconcilier avant toute nouvelle écriture.'],
 LAB_UNAVAILABLE:['inspect_availability','Vérifier la disponibilité et l’état de la requête ; aucun rejeu automatique après une interruption.'],
 INSUFFICIENT_SCOPE:['renew_consent','Renouveler le consentement pour les scopes annoncés par le serveur.'],
 DEPENDENCY_UNAVAILABLE:['inspect_availability','Vérifier les capacités actives et la disponibilité ; une réponse reçue ne prouve pas une panne réseau.'],
 NOT_FOUND:['resolve_authorized_id','Rechercher un identifiant accessible avec les outils autorisés ; absence et refus restent indiscernables.'],
 IDEMPOTENCY_CONFLICT:['reconcile_request','Vérifier la requête initiale : conserver la clé pour son rejeu identique, créer une nouvelle clé pour une autre intention.'],
 FAILED_PRECONDITION:['inspect_current_state','Relire l’état autorisé et vérifier les préconditions avant une nouvelle écriture.'],
 OPERATION_FAILED:['inspect_error','Examiner le refus et les journaux autorisés ; la cause précise reste inconnue.'],
};
function legacyCode(result, message) {
 if (result.conflit) return 'REVISION_CONFLICT';
 if (result.code === 'item_too_large') return 'TRUNCATED';
 if (/^Accès refusé|^Accès .*réservé|^Réservé|^Publier est réservé|^Modifier est réservé|^Archiver est réservé/.test(message)) return 'PERMISSION_DENIED';
 if (/^(?:Document|Expert|Pool|Page de sigle).*introuvable|^Objet absent ou inaccessible|^Révision inconnue|^Aucun compte actif|^Ce compte n’a pas d’accès|^Compétence inconnue|^Aucune relation/.test(message)) return 'NOT_FOUND';
 if (/^Ce document n’est pas archivé|^Master a déjà/.test(message)) return 'FAILED_PRECONDITION';
 if (Array.isArray(result.erreurs) || /^version_attendue|^revision_attendue|^role doit|^Type inconnu|^Entre 1 et 100|^offset dans|^fiches :|^changes :|^dry_run :|^competence \(|^mesures doit/.test(message)) return 'INVALID_ARGUMENT';
 return 'OPERATION_FAILED';
}
function decorate(result){
 if(result?.ok!==false||!result.error||typeof result.error!=='object')return result;
 const [action,instruction]=Object.hasOwn(guidance,result.error.code)?guidance[result.error.code]:['inspect_error','Examiner le code retourné et les capacités courantes avant de poursuivre.'];
 const delay=result.error.code==='RATE_LIMITED'&&Number.isSafeInteger(result.error.details?.retry_after_seconds)?Math.max(1,Math.min(60,result.error.details.retry_after_seconds)):null;
 const permission=['PERMISSION_DENIED','PATH_DENIED','ORIGIN_DENIED','INSUFFICIENT_SCOPE'].includes(result.error.code);
 return {...result,error:{...result.error,...(permission?{retryable:false}:{}),recovery:{...result.error.recovery,
   action:permission?action:result.error.recovery?.action||action,instruction:permission?instruction:result.error.recovery?.instruction||instruction,
   automatic_retry:false,preserve_idempotency_key:true,retry_after_seconds:delay}}};
}
function normalize(result){
 if(result?.ok!==false)return result;
 if(typeof result.error==='string'){
  const message=result.error,code=legacyCode(result,message);
  result={...result,legacy_error:message,error:{code,message,retryable:false}};
 }
 if(!result.error||typeof result.error!=='object')result={...result,error:{code:'OPERATION_FAILED',message:'Opération refusée.',retryable:false}};
 return decorate({...result,request_id:result.request_id||require('node:crypto').randomUUID(),schema_version:result.schema_version||'1'});
}
function toolResult(result){
 if(!result?.structuredContent||result.structuredContent.ok!==false)return result;
 const out=normalize(result.structuredContent);
 return {...result,isError:true,structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};
}
const outputSchema={type:'object',required:['ok','request_id','schema_version'],properties:{ok:{type:'boolean'},request_id:{type:'string'},schema_version:{type:'string',const:'1'},data:{type:'object'},error:{type:'object',required:['code','message','retryable','recovery'],properties:{code:{type:'string'},message:{type:'string'},retryable:{type:'boolean'},recovery:{type:'object'}}}},anyOf:[{required:['data'],properties:{ok:{const:true}}},{required:['error'],properties:{ok:{const:false}}}]};
module.exports={decorate,normalize,toolResult,outputSchema};
