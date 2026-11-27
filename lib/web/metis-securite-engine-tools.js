'use strict';
const E=require('../modules/metis-securite-engine');
const txt=(max,description)=>({type:'string',maxLength:max,description});
const integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const id=txt(45,'ID security:… rendu par la file.');
const key=txt(120,'Clé unique de l’intention ; conserver la même lors d’un rejeu.');
const revision=integer(1,1e9),sha={type:'string',pattern:'^[a-f0-9]{40}$'};
const refs={type:'array',maxItems:12,items:txt(240,'Référence de preuve ; jamais un secret.')};
const defs=[
 ['securite_file_etat','Lire la file des audits','Étapes conservées, dépendances et arrêt d’urgence. Une réservation ne lance aucun code ou modèle.','status',{state:{type:'string',enum:E.STATES},limit:integer(1,100),offset:integer(0,100000)},[]],
 ['securite_file_creer','Conserver une étape','Étape sur un dépôt connu et un commit exact, avec au plus 12 dépendances existantes. Refusée si arrêt actif.','create',{depot:txt(140,'Dépôt exact.'),kind:{type:'string',enum:E.KINDS},head_sha:sha,base_sha:sha,goal:txt(1000,'Objectif vérifiable.'),priority:integer(0,100),dependencies:{type:'array',maxItems:12,uniqueItems:true,items:id},idempotency_key:key},['depot','kind','head_sha','goal','idempotency_key']],
 ['securite_file_reserver','Réserver une étape','Une seule réservation globale. Bail expiré : arrêt explicite requis ; aucune reprise aveugle. Ne lance aucun runner.','claim',{id,expected_revision:revision,head_sha:sha,lease_seconds:integer(10,900),idempotency_key:key},['id','expected_revision','head_sha','idempotency_key']],
 ['securite_file_checkpoint','Conserver un point de reprise','Révision, propriétaire de transport, bail et jeton fence doivent rester courants. Prolonge le bail.','checkpoint',{id,expected_revision:revision,fence:integer(1,1e9),summary:txt(1000,'Étape réellement accomplie.'),refs,lease_seconds:integer(10,900),idempotency_key:key},['id','expected_revision','fence','summary','idempotency_key']],
 ['securite_file_transition','Terminer ou suspendre une étape','Succès/échec seulement sous bail courant. Suspension et annulation révoquent la réservation ; reprise explicite depuis paused.','transition',{id,expected_revision:revision,fence:integer(1,1e9),state:{type:'string',enum:['queued','paused','succeeded','failed','cancelled']},summary:txt(1000,'Résultat ou motif ; déclaratif, ne prouve pas l’exécution d’un test.'),idempotency_key:key},['id','expected_revision','state','summary','idempotency_key']],
 ['securite_arret_urgence','Régler l’arrêt d’urgence','Ferme les admissions, révoque les réservations et interrompt les passages des routines existantes. Ne tue aucun processus externe. Réouverture sans reprise automatique.','stop',{expected_revision:revision,stopped:{type:'boolean'},reason:txt(500,'Motif explicite.'),idempotency_key:key},['expected_revision','stopped','reason','idempotency_key']],
 ['securite_journal_unifie','Lire le journal conservé','File, livraisons GitHub et opérations des deux routines depuis activation, avec provenance, chaîne SHA256 et pagination bornée.','journal',{after:integer(0,1e9),limit:integer(1,100)},[]],
 ['securite_verifier_journal','Vérifier la chaîne du journal','Contrôle l’enchaînement conservé ; ne prouve pas la résistance à un administrateur de la base.','verifyJournal',{},[]],
 ['securite_preparer_diff','Préparer une analyse différentielle','Lit les arbres Git de la base et du HEAD exacts, puis au plus huit blobs textuels. Conserve le manifeste sous bail/CAS, sans exécuter le code. Candidats lexicaux de frontières, couverture bornée explicite.','prepareDiff',{id,expected_revision:revision,fence:integer(1,1e9),idempotency_key:key},['id','expected_revision','fence','idempotency_key']],
 ['securite_lire_analyse','Lire une analyse conservée','Manifeste immuable, hashes des sources, delta de deux instantanés exacts, extraits expurgés et limites. Ne prouve ni sécurité ni résultat runtime.','readAnalysis',{id:txt(54,'Identifiant security-analysis:… rendu par securite_preparer_diff.')},['id']],
];
const names=defs.map(([name])=>name);
const table=Object.fromEntries(defs.map(([name,,,method])=>[name,(args,account,context)=>method==='prepareDiff'?require('../modules/metis-securite-differential').prepare(account,args,context).then(data=>({ok:true,data})):({ok:true,data:E[method](account,args)})]));
const tools=()=>E.enabled()?defs.map(([name,title,description,method,properties,required])=>({name,title,description,inputSchema:{type:'object',additionalProperties:false,properties,required},annotations:{readOnlyHint:['status','journal','verifyJournal','readAnalysis'].includes(method),destructiveHint:false,idempotentHint:true,openWorldHint:method==='prepareDiff'}})):[];
module.exports={names,table,tools};
