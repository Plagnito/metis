'use strict';

// Projections of the existing audit history, source manifests and declared proof.
// No scheduler, model, repository executor, merge or notification transport.
const crypto = require('node:crypto');
const { db } = require('../core/db');
const I = require('../core/sqlite-context');
const canonical = require('./metis-idempotency');
const redact = require('./metis-nexus-redaction').createRedactor(()=>[require('./metis-securite').jetonGithub(),process.env.METIS_SECURITY_WEBHOOK_SECRET]);
const CONTRATS = require('./metis-securite-contrats.json');
const S = () => require('./metis-securite');
const E = () => require('./metis-securite-engine');
const SHA = /^[a-f0-9]{40}$/;
let ready = false, reading = false;
const fail = (code, message, status = 400) => { throw new (S().ErreurSecurite)(code, message, status); };
const now = () => S().dateCouranteISO();
const parse = (x, fallback = {}) => { try { return JSON.parse(x); } catch { return fallback; } };
function object(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) fail('INVALID_ARGUMENT', 'Objet invalide ou champ inconnu.');
}
function text(x, max = 500) {
  if (typeof x !== 'string' || !x.trim() || x.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(x)) fail('INVALID_ARGUMENT', 'Texte non vide et borné requis.');
  return x.trim();
}
function integer(x, min = 0, max = 1e9) {
  if (!Number.isSafeInteger(x) || x < min || x > max) fail('INVALID_ARGUMENT', 'Entier hors limites.');
  return x;
}
function guard(account) {
  if (!require('./metisdocs').estMaster(account)) fail('PERMISSION_DENIED', 'Réservé au propriétaire de l’instance.', 403);
}
function init() {
  if (ready) return;
  S().init();
  db.exec(`CREATE TABLE IF NOT EXISTS securite_reprise_decisions (
    origine_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,etat TEXT NOT NULL,audit_id INTEGER,
    jusquau TEXT,note TEXT NOT NULL,maj_le TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS securite_pr_decisions (
    faille_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,source TEXT NOT NULL DEFAULT '{}',
    decision TEXT NOT NULL DEFAULT '{}',maj_le TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS securite_prevention_sources (
    id TEXT PRIMARY KEY,depot TEXT NOT NULL,base_sha TEXT NOT NULL,head_sha TEXT NOT NULL,
    contenu TEXT NOT NULL,sha256 TEXT NOT NULL,cree_le TEXT NOT NULL,
    UNIQUE(depot,base_sha,head_sha));
    CREATE INDEX IF NOT EXISTS securite_prevention_sources_depot ON securite_prevention_sources(depot,cree_le DESC,id DESC);
    CREATE TRIGGER IF NOT EXISTS securite_prevention_sources_no_update BEFORE UPDATE ON securite_prevention_sources
      BEGIN SELECT RAISE(ABORT,'Immutable prevention source'); END;
    CREATE TRIGGER IF NOT EXISTS securite_prevention_sources_no_delete BEFORE DELETE ON securite_prevention_sources
      BEGIN SELECT RAISE(ABORT,'Immutable prevention source'); END;
    CREATE TABLE IF NOT EXISTS securite_prevention_controles (
    depot TEXT NOT NULL,head_sha TEXT NOT NULL,controle_id TEXT NOT NULL,revision INTEGER NOT NULL,
    contenu TEXT NOT NULL,maj_le TEXT NOT NULL,PRIMARY KEY(depot,head_sha,controle_id));
    CREATE TABLE IF NOT EXISTS securite_pilotage_keys (
    compte INTEGER NOT NULL,operation TEXT NOT NULL,cle TEXT NOT NULL,empreinte TEXT NOT NULL,resultat TEXT NOT NULL,
    PRIMARY KEY(compte,operation,cle));
    CREATE TABLE IF NOT EXISTS securite_pilotage_historique (
    id INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT NOT NULL,cible TEXT NOT NULL,revision INTEGER NOT NULL,
    contenu TEXT NOT NULL,cree_le TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS securite_pilotage_historique_no_update BEFORE UPDATE ON securite_pilotage_historique
      BEGIN SELECT RAISE(ABORT,'Immutable prevention history'); END;
    CREATE TRIGGER IF NOT EXISTS securite_pilotage_historique_no_delete BEFORE DELETE ON securite_pilotage_historique
      BEGIN SELECT RAISE(ABORT,'Immutable prevention history'); END;`);
  ready = true;
}
function history(operation,cible,revision,contenu) {
  db.prepare('INSERT INTO securite_pilotage_historique(operation,cible,revision,contenu,cree_le) VALUES(?,?,?,?,?)').run(operation,cible,revision,JSON.stringify(contenu),now());
}
function mutate(account, operation, args, fn) {
  guard(account); init();
  const key = text(args.idempotency_key, 120), fingerprint = canonical.fingerprint(args);
  const inside = () => {
    E().assertNotStopped();
    const old = db.prepare('SELECT * FROM securite_pilotage_keys WHERE compte=? AND operation=? AND cle=?').get(account, operation, key);
    if (old) {
      if (old.empreinte !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Clé déjà employée pour une autre intention.', 409);
      return { ...parse(old.resultat), rejoue: true };
    }
    const result = fn();
    if (db.prepare('SELECT COUNT(*) n FROM securite_pilotage_keys').get().n >= 100000) fail('QUOTA_EXCEEDED', 'Registre de commandes plein ; conservation requise.', 409);
    db.prepare('INSERT INTO securite_pilotage_keys VALUES(?,?,?,?,?)').run(account, operation, key, fingerprint, JSON.stringify(result));
    return result;
  };
  if (E().enabled()) return E().admit(inside);
  db.exec('BEGIN IMMEDIATE');
  try { const out = inside(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function roots() {
  return db.prepare("SELECT id,jour,heure,depot,angle,etat,debut_le,resultat,reprise_de FROM securite_creneaux WHERE reprise_de IS NULL AND etat IN ('reporte','echec') ORDER BY jour,heure,id").all();
}
function reprises({ includeClosed = false } = {}) {
  init();
  const today = S().paris().jour;
  const members=new Map(),decisions=new Map(db.prepare('SELECT * FROM securite_reprise_decisions').all().map(x=>[x.origine_id,x]));
  const depots=new Map(db.prepare('SELECT * FROM securite_depots').all().map(x=>[x.nom_complet,x])),completedByDepot=new Map();
  for(const c of db.prepare('SELECT id,jour,heure,depot,etat,debut_le,reprise_de FROM securite_creneaux WHERE reprise_de IS NOT NULL ORDER BY jour DESC,heure DESC,id DESC').all()){
    const l=members.get(c.reprise_de)||[];l.push(c);members.set(c.reprise_de,l);
  }
  for(const c of db.prepare("SELECT id,depot,jour,angle,fin_le FROM securite_creneaux WHERE reprise_de IS NULL AND etat='termine' ORDER BY fin_le DESC,id DESC").all()){
    const l=completedByDepot.get(c.depot)||[];l.push(c);completedByDepot.set(c.depot,l);
  }
  return roots().map(c => {
    const children = members.get(c.id)||[];
    const completed = children.find(x => x.etat === 'termine');
    const active = children.find(x => ['prevu', 'en_cours'].includes(x.etat));
    const decision = decisions.get(c.id);
    const depot = depots.get(c.depot);
    const excluded = !depot || depot.archive || S().importanceDe(depot).niveau === 'mort';
    const state = completed ? 'couverte' : excluded ? 'hors_perimetre' : active ? 'planifiee' :
      decision?.etat === 'differee' && decision.jusquau <= today ? 'ouverte' : decision?.etat || 'ouverte';
    const possible = (completedByDepot.get(c.depot)||[]).filter(x=>x.jour>=c.jour&&x.id!==c.id).slice(0,5).map(({id,angle,fin_le})=>({id,angle,fin_le}));
    const latest = children[0] || c;
    return { origine_id: c.id, jour: c.jour, heure: c.heure, depot: c.depot, angle: c.angle, etat: state,
      revision: decision?.revision || 0, reprise_planifiee: active && { id: active.id, jour: active.jour, heure: active.heure },
      audit_couverture: completed?.id || decision?.audit_id || null, deja_commence: !!latest.debut_le,
      dernier_creneau: latest.id, couverture_possible_a_verifier: possible,
      importance: depot ? S().importanceDe(depot).niveau : null, note: decision?.note || null, jusquau: decision?.jusquau || null };
  }).filter(c => includeClosed || !['couverte','annulee','hors_perimetre'].includes(c.etat));
}
function validateReprise(originId, target) {
  if (originId == null) return null;
  integer(originId, 1);
  const c = db.prepare('SELECT * FROM securite_creneaux WHERE id=?').get(originId);
  if (!c || c.reprise_de || !['reporte','echec'].includes(c.etat) || c.jour >= target.jour) fail('FAILED_PRECONDITION', 'Reprise : origine reportée/échouée d’un jour antérieur requise.', 409);
  if (c.depot !== target.depot || c.angle !== target.angle) fail('FAILED_PRECONDITION', 'La reprise conserve le dépôt et l’angle de son origine.', 409);
  if (!target.raison) fail('INVALID_ARGUMENT', 'La reprise exige une raison et la réévaluation du HEAD/couverture.');
  const current = reprises({ includeClosed: true }).find(x => x.origine_id === originId);
  if (!current || current.etat !== 'ouverte') fail('FAILED_PRECONDITION', 'Reprise déjà couverte, planifiée, différée ou exclue.', 409);
  return originId;
}
function qualifyReprise(account, args) {
  object(args, ['origine_id','expected_revision','etat','audit_id','jusquau','note','idempotency_key']);
  integer(args.origine_id,1); integer(args.expected_revision);
  if (!['ouverte','couverte','differee','annulee'].includes(args.etat)) fail('INVALID_ARGUMENT','État de reprise invalide.');
  const note = text(args.note, 1000);
  return mutate(account, 'reprise', args, () => {
    const root = roots().find(x => x.id === args.origine_id);
    if (!root) fail('NOT_FOUND','Origine de reprise introuvable.',404);
    const current = db.prepare('SELECT * FROM securite_reprise_decisions WHERE origine_id=?').get(root.id);
    if ((current?.revision || 0) !== args.expected_revision) fail('REVISION_CONFLICT','Révision de reprise périmée.',409);
    if (reprises({includeClosed:true}).find(x=>x.origine_id===root.id)?.etat === 'planifiee') fail('FAILED_PRECONDITION','Une reprise est déjà planifiée/en cours.',409);
    let audit = null, until = null;
    if (args.etat === 'couverte') {
      integer(args.audit_id,1);
      audit = db.prepare("SELECT * FROM securite_creneaux WHERE id=? AND etat='termine'").get(args.audit_id);
      if (!audit || audit.depot !== root.depot || audit.jour < root.jour) fail('FAILED_PRECONDITION','Audit de couverture terminé sur le même dépôt requis.',409);
    } else if (args.audit_id != null) fail('INVALID_ARGUMENT','audit_id est réservé à une couverture.');
    if (args.etat === 'differee') {
      const date = new Date(args.jusquau+'T12:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.jusquau || '') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==args.jusquau || args.jusquau <= S().paris().jour) fail('INVALID_ARGUMENT','Date de report future valide requise.');
      until = args.jusquau;
    } else if (args.jusquau != null) fail('INVALID_ARGUMENT','jusquau est réservé au report.');
    const revision = args.expected_revision+1;
    db.prepare(`INSERT INTO securite_reprise_decisions VALUES(?,?,?,?,?,?,?) ON CONFLICT(origine_id) DO UPDATE SET
      revision=excluded.revision,etat=excluded.etat,audit_id=excluded.audit_id,jusquau=excluded.jusquau,note=excluded.note,maj_le=excluded.maj_le`)
      .run(root.id,revision,args.etat,audit?.id || null,until,redact(note),now());
    history('reprise',String(root.id),revision,redact({etat:args.etat,audit_id:audit?.id||null,jusquau:until,note}));
    S().consigner({...S().agentCourant(),action:'Reprise qualifiée',cible:String(root.id),resultat:args.etat+' : '+redact(note)});
    return {ok:true,origine_id:root.id,revision,etat:args.etat};
  });
}
function alerts(reprisesInput) {
  init();
  const ici = S().paris(), t = Date.parse(now()), out = [];
  const add = (id, gravite, message, action, ref) => out.push({id,gravite,message,action,ref:ref || null});
  const plan = db.prepare('SELECT * FROM securite_plans WHERE jour=?').get(ici.jour);
  if (!plan && ici.heure*60+ici.minute >= 90) add('plan_absent','haute','Aucun plan d’audit enregistré pour '+ici.jour+'.','Préparer le bilan manqué puis un plan d’heures futures.',ici.jour);
  const due = db.prepare("SELECT * FROM securite_creneaux WHERE jour=? AND heure<=? AND etat IN ('prevu','reporte','en_cours') ORDER BY heure").all(ici.jour,ici.heure);
  const operation = db.prepare("SELECT MAX(le) le FROM securite_operations WHERE le<=? AND agent='auditeur' AND action IN ('Audit démarré','Audit terminé','Plan de la journée établi','Avancement de l’audit')").get(now()).le;
  let rpc = null;
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metis_mcp_calls'").get()) rpc=db.prepare("SELECT MAX(le) le FROM metis_mcp_calls WHERE le<=? AND failed=0 AND tool IN ('securite_planifier_journee','securite_demarrer_audit','securite_journaliser_audit','securite_terminer_audit')").get(now()).le;
  const last = [rpc,operation].filter(Boolean).sort().at(-1) || null;
  if(due.length && ici.heure*60+ici.minute >= due[0].heure*60+90 && (!last || t-Date.parse(last)>90*60000))
    add('auditeur_sans_activite','haute','Travail échu sans appel ni jalon d’audit récent.','Vérifier tâche externe, accès et dernier résultat ; cause externe non déduite.',last);
  for(const c of due.filter(x=>x.etat==='en_cours'&&t-Date.parse(x.derniere_activite||x.debut_le)>30*60000))
    add('audit_muet_'+c.id,'moyenne','Audit '+c.id+' sans jalon depuis plus de 30 minutes.','Vérifier le checkpoint ; ne pas relancer automatiquement.',String(c.id));
  const pending = (reprisesInput||reprises()).filter(x=>x.etat==='ouverte'&&x.jour<ici.jour);
  if(pending.length) add('reprises_en_attente','moyenne',pending.length+' axe(s) de jours précédents attendent une reprise.','Réévaluer HEAD/couverture et lier les nouveaux créneaux à leur origine.',String(pending.length));
  const old = db.prepare("SELECT id FROM securite_failles WHERE statut IN ('nouvelle','confirmee','pr_ouverte','corrigee') AND gravite IN ('haute','critique') AND maj_le<?").all(new Date(t-86400e3).toISOString());
  if(old.length) add('risques_hauts_stagnants','haute',old.length+' risque(s) haut/critique sans mise à jour depuis 24 h.','Actualiser le blocage, la CI et la décision attendue.',old.map(x=>x.id).join(','));
  return {verifie_le:now(),alertes:out.map(a=>{
    const empreinte=crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0,24);
    const signal=db.prepare("SELECT MAX(o.le) le FROM securite_operations o JOIN securite_passages p ON p.id=o.passage_id WHERE o.alerte_ref=? AND p.etat='termine' AND p.resultat='fait'").get(empreinte).le;
    return {...a,empreinte,signalement_prepare_le:signal||null,livraison_visible_attestee:false};
  }),derniere_activite_auditeur:last,
    limite:'Appels et jalons reçus seulement ; pause, quota et refus de plateforme ne sont pas distingués automatiquement.'};
}
function observePr(f, pr) {
  init();
  E().assertNotStopped();
  db.exec('SAVEPOINT security_pr_observation');
  try {
  const source = {observe_le:now(),url:f.pr_url,head_sha:SHA.test(pr.head?.sha || '')?pr.head.sha:null,
    base_sha:SHA.test(pr.base?.sha || '')?pr.base.sha:null,branche:typeof pr.head?.ref==='string'?pr.head.ref.slice(0,160):null,
    brouillon:pr.draft===true,etat:pr.merged_at?'fusionnee':pr.state,mergeable:typeof pr.mergeable==='boolean'?pr.mergeable:null,
    fusion_sha:SHA.test(pr.merge_commit_sha || '')?pr.merge_commit_sha:null,
    provenance:'API GitHub ; CI, tests, protections, revue et déploiement restent à vérifier'};
  const old = db.prepare('SELECT * FROM securite_pr_decisions WHERE faille_id=?').get(f.id);
  const prev = parse(old?.source);
  const changed = prev.head_sha!==source.head_sha || prev.base_sha!==source.base_sha || prev.url!==source.url;
  const decision = changed?{}:parse(old?.decision);
  db.prepare(`INSERT INTO securite_pr_decisions VALUES(?,?,?,?,?) ON CONFLICT(faille_id) DO UPDATE SET
    revision=excluded.revision,source=excluded.source,decision=excluded.decision,maj_le=excluded.maj_le`)
    .run(f.id,(old?.revision||0)+1,JSON.stringify(source),JSON.stringify(decision),now());
  history('observation_pr',f.id,(old?.revision||0)+1,source);
  db.exec('RELEASE security_pr_observation');
  } catch(e) { db.exec('ROLLBACK TO security_pr_observation; RELEASE security_pr_observation');throw e; }
}
function decisions() {
  init();
  return db.prepare("SELECT * FROM securite_failles WHERE statut IN ('nouvelle','confirmee','pr_ouverte','corrigee') ORDER BY CASE gravite WHEN 'critique' THEN 0 WHEN 'haute' THEN 1 ELSE 2 END,trouvee_le").all().map(f=>{
    const row=db.prepare('SELECT * FROM securite_pr_decisions WHERE faille_id=?').get(f.id),source=parse(row?.source),decision=parse(row?.decision);
    const stale=!source.observe_le || Date.parse(now())-Date.parse(source.observe_le)>86400e3;
    const blocages=[];
    if(!f.pr_url)blocages.push('PR absente');
    if(stale)blocages.push('État GitHub absent/périmé');
    if(!source.head_sha||!source.base_sha)blocages.push('HEAD/base non vérifiés');
    if(source.brouillon)blocages.push('PR en brouillon');
    if(source.mergeable===false)blocages.push('Conflit de fusion');
    if(!decision.note)blocages.push('Tests, CI, revue et décision à documenter');
    const sameUrl=source.url===f.pr_url;
    return {faille_id:f.id,depot:f.depot,titre:f.titre,gravite:f.gravite,statut:f.statut,pr_url:f.pr_url,revision:row?.revision||0,
      source:sameUrl?source:{},decision:sameUrl?decision:{},etat:!sameUrl||stale?'a_actualiser':f.statut==='corrigee'?'a_revalider':source.brouillon?'non_prete':decision.etat||'a_documenter',blocages,
      autorisation_fusion:false,interpretation:'Décision déclarée et faits GitHub ; aucun gate complet ou déploiement attesté par ce tableau.'};
  });
}
function recordDecision(account,args) {
  object(args,['faille_id','expected_revision','head_sha','base_sha','etat','note','action_suivante','preuves','ci','idempotency_key']);
  const id=text(args.faille_id,12),note=text(args.note,1000),action=text(args.action_suivante,500);
  integer(args.expected_revision);
  if(!['non_prete','revue_manuelle','preuves_manquantes','prete_a_revoir'].includes(args.etat)||!SHA.test(args.head_sha||'')||!SHA.test(args.base_sha||''))fail('INVALID_ARGUMENT','État ou commits invalides.');
  const refs=proofRefs(args.preuves);
  const ci=args.ci==null?null:text(args.ci,300);
  return mutate(account,'decision_pr',args,()=>{
    const f=db.prepare('SELECT * FROM securite_failles WHERE id=?').get(id),row=db.prepare('SELECT * FROM securite_pr_decisions WHERE faille_id=?').get(id),source=parse(row?.source);
    if(!f||!f.pr_url)fail('NOT_FOUND','Faille avec PR requise.',404);
    if((row?.revision||0)!==args.expected_revision)fail('REVISION_CONFLICT','Révision de décision périmée.',409);
    if(source.url!==f.pr_url||source.head_sha!==args.head_sha||source.base_sha!==args.base_sha||Date.parse(now())-Date.parse(source.observe_le)>86400e3)fail('FAILED_PRECONDITION','Actualiser la PR ; base et HEAD doivent être observés récemment.',409);
    const decision=redact({etat:args.etat,note,action_suivante:action,preuves:refs,ci,head_sha:args.head_sha,base_sha:args.base_sha,le:now(),nature:'déclaration_agent'});
    db.prepare('UPDATE securite_pr_decisions SET revision=revision+1,decision=?,maj_le=? WHERE faille_id=?').run(JSON.stringify(decision),now(),id);
    history('decision_pr',id,args.expected_revision+1,decision);
    S().consigner({...S().agentCourant(),action:'Décision PR documentée',cible:id,resultat:args.etat+' : '+decision.action_suivante});
    return {ok:true,faille_id:id,revision:args.expected_revision+1,decision};
  });
}
function proofRefs(refs) {
  if(!Array.isArray(refs)||!refs.length||refs.length>10)fail('INVALID_ARGUMENT','De 1 à 10 références de preuve requises.');
  return refs.map(x=>text(x,240));
}
function recordControl(account,args) {
  object(args,['depot','head_sha','controle_id','expected_revision','resultat','commande','preuves','limites','idempotency_key']);
  const depot=S().resoudreDepot(args.depot).nom_complet,contract=CONTRATS.find(x=>x.id===args.controle_id);
  integer(args.expected_revision);
  if(!contract||!SHA.test(args.head_sha||'')||!['reussi','echoue','bloque','non_applicable'].includes(args.resultat))fail('INVALID_ARGUMENT','Contrat, commit ou résultat invalide.');
  const commande=text(args.commande,500),refs=proofRefs(args.preuves),limites=text(args.limites,1000);
  return mutate(account,'controle',args,()=>{
    const old=db.prepare('SELECT * FROM securite_prevention_controles WHERE depot=? AND head_sha=? AND controle_id=?').get(depot,args.head_sha,contract.id);
    if((old?.revision||0)!==args.expected_revision)fail('REVISION_CONFLICT','Révision de contrôle périmée.',409);
    const value=redact({resultat:args.resultat,commande,preuves:refs,limites,nature:'résultat déclaré, preuves à relire ; ne revalide pas une faille',le:now()});
    db.prepare(`INSERT INTO securite_prevention_controles VALUES(?,?,?,?,?,?) ON CONFLICT(depot,head_sha,controle_id) DO UPDATE SET
      revision=excluded.revision,contenu=excluded.contenu,maj_le=excluded.maj_le`).run(depot,args.head_sha,contract.id,args.expected_revision+1,JSON.stringify(value),now());
    history('controle',depot+'@'+args.head_sha+':'+contract.id,args.expected_revision+1,value);
    S().consigner({...S().agentCourant(),action:'Contrôle préventif consigné',cible:depot+' · '+contract.id,resultat:args.resultat});
    return {ok:true,depot,head_sha:args.head_sha,controle_id:contract.id,revision:args.expected_revision+1,...value};
  });
}
function prevention() {
  init();
  const depots=S().etatDepots().filter(d=>d.importance.niveau==='actif');
  return depots.map(d=>{
    const source=db.prepare('SELECT id,head_sha,base_sha,cree_le FROM securite_prevention_sources WHERE depot=? ORDER BY cree_le DESC,id DESC LIMIT 1').get(d.nom_complet);
    const controls=source?db.prepare('SELECT controle_id,revision,contenu FROM securite_prevention_controles WHERE depot=? AND head_sha=?').all(d.nom_complet,source.head_sha).map(r=>({controle_id:r.controle_id,revision:r.revision,...parse(r.contenu)})):[];
    return {depot:d.nom_complet,source:source||null,controles_declares:controls,contrats_total:CONTRATS.length,
      a_examiner:!d.dernier_audit || !!(d.pousse_le&&d.pousse_le>d.dernier_audit),prochaine_action:source?'Vérifier les contrats sur les véritables routes/CI de ce commit.':'Lire le HEAD réel et préparer les contrôles sur deux commits exacts.'};
  });
}
async function prepareControls(account,args,{current,fetchImpl=fetch}={}) {
  object(args,['depot','base_sha','head_sha']);guard(account);init();
  const observed=I.identity(),depot=S().resoudreDepot(args.depot);
  if(depot.archive||S().importanceDe(depot).niveau==='mort')fail('FAILED_PRECONDITION','Dépôt hors périmètre.',409);
  if(!SHA.test(args.head_sha||'')||!SHA.test(args.base_sha||''))fail('INVALID_ARGUMENT','Deux commits exacts requis.');
  if(typeof current!=='function'||!current()||!observed?.client)fail('PERMISSION_DENIED','Transport courant vérifiable requis.',403);
  const check=()=>{
    guard(account);E().assertNotStopped();
    if(!current())fail('PERMISSION_DENIED','Transport révoqué pendant la lecture.',403);
    const live=S().resoudreDepot(depot.nom_complet);
    if(live.archive||S().importanceDe(live).niveau==='mort')fail('FAILED_PRECONDITION','Dépôt exclu pendant la lecture.',409);
  };
  check();
  const old=db.prepare('SELECT * FROM securite_prevention_sources WHERE depot=? AND base_sha=? AND head_sha=?').get(depot.nom_complet,args.base_sha,args.head_sha);
  if(old)return {ok:true,source_id:old.id,rejoue:true,manifest:redact(parse(old.contenu))};
  if(reading)fail('BUSY','Une lecture préventive est déjà en cours.',409);
  reading=true;
  try{
    const token=require('./metis-securite').jetonGithub();
    const manifest=redact(await require('./metis-securite-differential').collect({depot:depot.nom_complet,base_sha:args.base_sha,head_sha:args.head_sha},{fetchImpl,token,check}));
    check();
    const paths=manifest.changes.map(x=>x.path||'').join('\n');
    manifest.controles_suggeres=CONTRATS.filter(c=>c.id==='isolation'||c.id==='revocation'&&/auth|session|token|oauth|login/i.test(paths)||c.id==='flux'&&/upload|download|file|torrent|mail/i.test(paths)||c.id==='reseau'&&/fetch|proxy|url|network|http/i.test(paths)||c.id==='messages'&&/ws|socket|ipc|message/i.test(paths)||c.id==='asynchrone'&&/desktop|electron|updat|voice|audio|async/i.test(paths)).map(c=>c.id);
    manifest.interpretation+=' Suggested contracts are heuristic; their absence is not a passed test. Git blob hashes were verified before secret redaction.';
    const contenu=JSON.stringify(manifest),sha256=crypto.createHash('sha256').update(contenu).digest('hex'),id='prevention:'+sha256.slice(0,32);
    return I.withIdentity(account,observed.client,()=>{
      const save=()=>{
        check();
        db.prepare('INSERT OR IGNORE INTO securite_prevention_sources VALUES(?,?,?,?,?,?,?)').run(id,depot.nom_complet,args.base_sha,args.head_sha,contenu,sha256,now());
        const winner=db.prepare('SELECT * FROM securite_prevention_sources WHERE depot=? AND base_sha=? AND head_sha=?').get(depot.nom_complet,args.base_sha,args.head_sha);
        S().consigner({...S().agentCourant(),action:'Contrôles préparés sur changements',cible:depot.nom_complet,resultat:winner.id+' · '+args.head_sha});
        return {ok:true,source_id:winner.id,manifest:parse(winner.contenu)};
      };
      if(E().enabled())return E().admit(save);
      db.exec('BEGIN IMMEDIATE');
      try{const result=save();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
    });
  }finally{reading=false;}
}
function snapshot() {
  init();
  const r=reprises();
  return redact({reprises:r,sante:alerts(r),decisions:decisions(),prevention:prevention(),contrats:CONTRATS});
}
function read(account,args={}) { return redact(readRaw(account,args)); }
function readRaw(account,args={}) {
  guard(account);object(args,['section','limit','offset','inclure_closes','source_id']);S().marquerSilences();init();
  const section=args.section||'resume',limit=args.limit==null?30:integer(args.limit,1,100),offset=args.offset==null?0:integer(args.offset,0,100000);
  if(!['resume','reprises','decisions','prevention','contrats','historique','sources'].includes(section))fail('INVALID_ARGUMENT','Section de pilotage inconnue.');
  if(args.source_id!=null&&(section!=='sources'||!/^prevention:[a-f0-9]{32}$/.test(args.source_id)))fail('INVALID_ARGUMENT','Référence de source invalide.');
  if(args.inclure_closes!=null&&(section!=='reprises'||typeof args.inclure_closes!=='boolean'))fail('INVALID_ARGUMENT','inclure_closes est réservé à la liste des reprises.');
  if(section==='sources'){
    if(args.source_id){const r=db.prepare('SELECT * FROM securite_prevention_sources WHERE id=?').get(args.source_id);if(!r)fail('NOT_FOUND','Source introuvable.',404);return {ok:true,source_id:r.id,sha256:r.sha256,manifest:redact(parse(r.contenu))};}
    const total=db.prepare('SELECT COUNT(*) n FROM securite_prevention_sources').get().n;
    const items=db.prepare('SELECT id,depot,base_sha,head_sha,sha256,cree_le FROM securite_prevention_sources ORDER BY cree_le DESC,id DESC LIMIT ? OFFSET ?').all(limit,offset);
    return {ok:true,section,total,items,suite:offset+items.length<total,next_offset:offset+items.length};
  }
  if(section==='historique'){
    const total=db.prepare('SELECT COUNT(*) n FROM securite_pilotage_historique').get().n;
    const items=db.prepare('SELECT * FROM securite_pilotage_historique ORDER BY id DESC LIMIT ? OFFSET ?').all(limit,offset).map(x=>({...x,contenu:parse(x.contenu)}));
    while(Buffer.byteLength(JSON.stringify(items))>30000&&items.length)items.pop();
    return {ok:true,section,total,items,suite:offset+items.length<total,next_offset:offset+items.length};
  }
  const e=snapshot();
  if(section==='reprises'&&args.inclure_closes)e.reprises=reprises({includeClosed:true});
  if(section!=='resume'){
    const out={ok:true,section,total:e[section].length,items:e[section].slice(offset,offset+limit)};
    while(Buffer.byteLength(JSON.stringify(out))>31000&&out.items.length)out.items.pop();
    if(!out.items.length&&offset<out.total)fail('TRUNCATED','Un élément dépasse le budget ; consulter sa source.',409);
    return {...out,suite:offset+out.items.length<out.total,next_offset:offset+out.items.length};
  }
  return {ok:true,...summary(e)};
}
function summary(e=snapshot()) {
  return {sante:e.sante,reprises:{total:e.reprises.length,a_planifier:e.reprises.filter(x=>x.etat==='ouverte').length,items:e.reprises.slice(0,5).map(({couverture_possible_a_verifier,...x})=>({...x,note:x.note?.slice(0,300)||null}))},
    decisions:{total:e.decisions.length,hautes:e.decisions.filter(x=>['haute','critique'].includes(x.gravite)).length,a_actualiser:e.decisions.filter(x=>x.etat==='a_actualiser').length},
    prevention:{actifs:e.prevention.length,sources_preparees:e.prevention.filter(x=>x.source).length,controles_declares:e.prevention.reduce((n,x)=>n+x.controles_declares.length,0),a_examiner:e.prevention.filter(x=>x.a_examiner||!x.source||x.controles_declares.length<CONTRATS.length).length},
    outil_details:'securite_pilotage',limite:'Aucune permission de fusion/déploiement ; résultats de tests déclarés distincts des sources GitHub.'};
}
module.exports={init,reprises,validateReprise,qualifyReprise,alerts,observePr,decisions,recordDecision,recordControl,prepareControls,prevention,snapshot,summary,read,CONTRATS};
