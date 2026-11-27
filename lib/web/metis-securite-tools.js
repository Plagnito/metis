'use strict';

// =============================================================================
//  Outils MCP du Security Center (01/11/2026) — réservés au propriétaire de l'instance.
//  La routine d'agent : minuit → securite_etat puis securite_planifier_journee ;
//  chaque heure → securite_demarrer_audit, securite_journaliser_audit,
//  securite_terminer_audit. Le suivi : failles, audits, corrections, tendances.
//  Le gestionnaire (autre tâche, chaque heure à :35) : securite_demarrer_gestion,
//  les opérations de triage, securite_terminer_gestion. Deux journaux distincts.
//  Page : <instance>/metis/securite
// =============================================================================

const S = require('../modules/metis-securite');
const engine = require('./metis-securite-engine-tools');
const pilotage = require('./metis-securite-pilotage-tools');

const LECTURE = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ECRITURE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
const TXT = (d, max) => ({ type: 'string', description: d, ...(max ? { maxLength: max } : {}) });
const ENT = (d, min, max) => ({ type: 'integer', description: d, minimum: min, maximum: max });
const ENUM = (d, l) => ({ type: 'string', description: d, enum: l });
const OBJ = (props, requis = []) => ({ type: 'object', additionalProperties: false, properties: props, required: requis });
const COMPTES = () => { const p = require('../host').securite().proprietaires || []; return p.length ? p.join(' ou ') : 'compte GitHub déclaré'; };
const DEPOT = TXT('Dépôt : « nom » ou « Compte/nom » (' + COMPTES() + ').', 140);
const CRENEAU = ENT('Identifiant du créneau rendu par prochaine_action ou securite_demarrer_audit. Le conserver jusqu’à la clôture ; sans ID, les étapes suivent l’audit actif.', 1, 1e9);
const PREUVES = {
  type: 'array', maxItems: 10, description: 'Preuves vérifiables : extrait de code, commande, test, job Metis Lab, lien, observation.',
  items: OBJ({ type: ENUM('Nature de la preuve.', S.TYPES_PREUVE), contenu: TXT('La preuve elle-même (extrait, commande et sortie, résultat de test…).', 2000), ref: TXT('Référence : fichier:ligne, job_…, URL.', 240) }, ['type', 'contenu']),
};
const FAILLE = OBJ({
  titre: TXT('Ce qui ne va pas, en une phrase (6 à 160 caractères).', 160),
  gravite: ENUM('Gravité DÉCLARÉE.', S.GRAVITES),
  cwe: TXT('Catégorie CWE, ex. CWE-639.', 20),
  emplacement: TXT('fichier:ligne.', 240),
  description: TXT('Scénario d’exploitation et correctif proposé.', 4000),
  empreinte: TXT('Facultatif : identifiant stable pour reconnaître la même faille d’un audit à l’autre (sinon calculé depuis dépôt, titre, fichier).', 64),
  pr_url: TXT('PR GitHub du correctif, si elle existe déjà.', 300),
  preuves: PREUVES,
}, ['titre', 'gravite']);

const DEFS = [
  ['securite_etat', 'État du Security Center', 'Résumé borné du plan, prochaine_action avec créneau exact, audit actif, parc, failles et candidats. À lire au début du passage ; détails et preuves via les outils de lecture.',
    OBJ({ jour: TXT('AAAA-MM-JJ (défaut : aujourd’hui, heure de Paris).', 10) }), LECTURE],
  ['securite_inventaire', 'Inventaire des dépôts', 'Les dépôts de l’inventaire (' + COMPTES() + ') avec famille, visibilité, importance (actif, faible, mort), dernier audit, failles ouvertes et angles déjà couverts.',
    OBJ({ famille: ENUM('Filtre de famille.', Object.keys(S.LIBELLE_FAMILLE)), importance: ENUM('Filtre d’importance.', S.IMPORTANCES), jamais_audite: { type: 'boolean', description: 'Seulement les dépôts jamais audités.' }, recherche: TXT('Sous-chaîne du nom.', 80), limit: ENT('Taille de page.', 1, 100), offset: ENT('Décalage.', 0, 100000) }), LECTURE],
  ['securite_synchroniser_depots', 'Synchroniser l’inventaire', 'Relit la liste des dépôts sur GitHub. Sans jeton valide, la vue est PARTIELLE (dépôts publics) et le résultat le dit.',
    OBJ({}), ECRITURE],
  ['securite_declarer_depots', 'Déclarer des dépôts', 'Ajoute à l’inventaire des dépôts que la synchronisation ne voit pas (ex. privés sans jeton).',
    OBJ({ depots: { type: 'array', minItems: 1, maxItems: 50, items: OBJ({ nom_complet: TXT('<compte>/<dépôt> (' + COMPTES() + ').', 140), public: { type: 'boolean' }, langage: TXT('Langage principal.', 40) }, ['nom_complet']) } }, ['depots']), ECRITURE],
  ['securite_classer_depots', 'Classer des dépôts', 'Règle l’importance d’un dépôt pour économiser les audits : « actif » (audité normalement), « faible » (peu important : au plus un audit par mois, deux par jour), « mort » (plus utilisé : jamais audité, hors indicateurs), ou « auto » (retour au classement de base). Une raison est exigée pour faible et mort.',
    OBJ({ depots: { type: 'array', minItems: 1, maxItems: 100, items: OBJ({ depot: DEPOT, importance: ENUM('Niveau.', S.IMPORTANCES.concat('auto')), raison: TXT('Pourquoi ce niveau (usage, dernière modification…).', 300) }, ['depot', 'importance']) } }, ['depots']), ECRITURE],
  ['securite_planifier_journee', 'Planifier la journée', 'À minuit : au plus resume.creneaux_utiles créneaux (heures 1 à 23) — pas forcément 23 —, UN dépôt par créneau, un dépôt peut revenir plusieurs fois. Dépôt « mort » refusé ; dépôt « faible » limité. Replanifier ne touche que les créneaux futurs pas encore commencés.',
    OBJ({ jour: TXT('Aujourd’hui ou demain (AAAA-MM-JJ, heure de Paris). Défaut : aujourd’hui.', 10), priorites: TXT('Pourquoi ce plan : priorités retenues, en quelques phrases.', 1200),
      rapport_ref: OBJ({ id: TXT('Exécution Command Center du rapport, terminée avec checkpoint approuvé.', 80), revision: ENT('Révision exacte de l’exécution.', 1, 1e9) }, ['id', 'revision']),
      creneaux: { type: 'array', minItems: 1, maxItems: 23, items: OBJ({ heure: ENT('Heure de Paris.', 1, 23), depot: DEPOT, angle: TXT('Angle d’audit (ex. « Authentification et sessions »).', 120), raison: TXT('Pourquoi ce dépôt à cette heure ; réévaluer HEAD et couverture pour une reprise.', 300),reprise_de:ENT('Origine reportée/échouée d’un jour antérieur, obtenue par securite_pilotage ; même dépôt/angle.',1,1e9) }, ['heure', 'depot', 'angle']) } }, ['priorites', 'creneaux']), ECRITURE],
  ['securite_demarrer_audit', 'Démarrer un audit', 'Sans ID/heure : reprend l’audit actif, sinon le plus ancien créneau échu du jour jamais démarré, même reporté ; aucun créneau futur choisi automatiquement. Les cibles explicites restent ciblées. Aucun audit commencé puis interrompu relancé. Conserver le creneau_id jusqu’à la clôture. Rien à faire seulement si aucun travail admissible.',
    OBJ({ creneau_id: CRENEAU, heure: ENT('Heure du créneau (défaut : heure en cours).', 1, 23) }), ECRITURE],
  ['securite_journaliser_audit', 'Journaliser l’avancement', 'Ajoute une ligne au journal de l’audit en cours (affiché en direct) et peut changer d’étape. Sans signe de vie pendant 70 min, l’audit est marqué reporté.',
    OBJ({ creneau_id: CRENEAU, heure: ENT('Heure du créneau (défaut : heure en cours).', 1, 23), message: TXT('Ce qui vient d’être fait ou constaté.', 300), etape: ENUM('Étape en cours.', S.ETAPES), fichiers_lus: ENT('Nombre de fichiers lus jusqu’ici.', 0, 100000), job_ref: TXT('Job Metis Lab en cours (tests).', 80) }, ['message']), ECRITURE],
  ['securite_terminer_audit', 'Terminer un audit', 'Clôt l’audit : resultat « rien », « failles » (avec la liste) ou « echec » (l’audit n’a pas pu aboutir — c’est un échec, pas un succès).',
    OBJ({ creneau_id: CRENEAU, heure: ENT('Heure du créneau (défaut : heure en cours).', 1, 23), resultat: ENUM('Issue de l’audit.', ['rien', 'failles', 'echec']), resume: TXT('Ce qui a été examiné et conclu (10 à 2000 caractères).', 2000), failles: { type: 'array', maxItems: 20, items: FAILLE }, fichiers_lus: ENT('Fichiers lus.', 0, 100000) }, ['resultat', 'resume']), ECRITURE],
  ['securite_declarer_faille', 'Déclarer une faille', 'Déclare une faille hors d’un audit planifié. Une faille déjà ouverte (même empreinte) n’est pas dupliquée ; une faille corrigée qui réapparaît devient une récidive liée.',
    OBJ({ depot: DEPOT, faille: FAILLE }, ['depot', 'faille']), ECRITURE],
  ['securite_maj_faille', 'Mettre à jour une faille', 'Change statut, gravité ou PR, ajoute des preuves ou une note. faux_positif et acceptee exigent une note. « revalidee » passe par securite_revalider_faille.',
    OBJ({ id: TXT('Identifiant F-XXXXXX.', 12), statut: ENUM('Nouveau statut.', S.STATUTS.filter((s) => s !== 'revalidee')), gravite: ENUM('Gravité corrigée.', S.GRAVITES), pr_url: TXT('PR GitHub du correctif.', 300), note: TXT('Pourquoi.', 500), preuves: PREUVES }, ['id']), ECRITURE],
  ['securite_revalider_faille', 'Revalider une correction', 'Après fusion de la PR (statut corrigee) : un audit ultérieur constate la disparition (resultat « corrigee » → revalidee) ou la présence (resultat « presente » → faille rouverte). Preuves obligatoires.',
    OBJ({ id: TXT('Identifiant F-XXXXXX.', 12), resultat: ENUM('Constat.', ['corrigee', 'presente']), preuves: PREUVES, creneau_id: ENT('Audit qui a revalidé.', 1, 1e9), note: TXT('Commentaire.', 500) }, ['id', 'resultat', 'preuves']), ECRITURE],
  ['securite_lister_failles', 'Lister les failles', 'Failles filtrées par dépôt, gravité, statut, CWE ou seulement ouvertes, des plus récentes aux plus anciennes.',
    OBJ({ depot: DEPOT, gravite: ENUM('Gravité.', S.GRAVITES), statut: ENUM('Statut.', S.STATUTS), cwe: TXT('CWE-…', 20), ouvertes: { type: 'boolean', description: 'Seulement nouvelle, confirmee, pr_ouverte.' }, limit: ENT('Taille de page.', 1, 100), offset: ENT('Décalage.', 0, 100000) }), LECTURE],
  ['securite_lire_faille', 'Lire une faille', 'Une faille avec ses preuves, son historique complet, son audit d’origine et ses récidives éventuelles.',
    OBJ({ id: TXT('Identifiant F-XXXXXX.', 12) }, ['id']), LECTURE],
  ['securite_lister_audits', 'Lister les audits', 'Audits (créneaux) filtrés par jour, dépôt ou état — y compris reportés et échoués.',
    OBJ({ jour: TXT('AAAA-MM-JJ.', 10), depot: DEPOT, etat: ENUM('État.', S.ETATS), limit: ENT('Taille de page.', 1, 100), offset: ENT('Décalage.', 0, 100000) }), LECTURE],
  ['securite_lire_audit', 'Lire un audit', 'Un audit avec son avancement réel : étape, journal horodaté, durée, fichiers lus, job, résumé et failles déclarées.',
    OBJ({ creneau_id: ENT('Identifiant du créneau.', 1, 1e9) }, ['creneau_id']), LECTURE],
  ['securite_suivi_corrections', 'Suivre les corrections', 'Le chemin de chaque faille : sans PR, PR ouverte, à revalider (PR fusionnée), revalidée. actualiser:true lit l’état des PR sur GitHub et passe en corrigee celles qui sont fusionnées.',
    OBJ({ actualiser: { type: 'boolean', description: 'Interroger GitHub sur l’état des PR.' }, depot: DEPOT }), ECRITURE],
  ['securite_demarrer_gestion', 'Démarrer un passage du gestionnaire', 'Tâche horaire du GESTIONNAIRE (chaque heure à :' + S.GESTION_MINUTE + ', distincte des audits) : ouvre un passage et rend ce qu’il y a à traiter — failles à trier, PR ouvertes, corrections à revalider, failles sans PR, récidives. Les opérations de triage faites ensuite sont consignées à son journal. Si rien_a_traiter, clore aussitôt par securite_terminer_gestion (resultat « rien »).',
    OBJ({}), ECRITURE],
  ['securite_journaliser_gestion', 'Journaliser une opération du gestionnaire', 'Ajoute au journal du gestionnaire une opération qui n’est pas un appel d’outil (ex. « PR relue, en attente d’un humain »), avec son résultat ou son erreur.',
    OBJ({ passage_id: ENT('Passage (défaut : le passage en cours).', 1, 1e9), action: TXT('Ce qui a été fait.', 120), cible: TXT('Faille, dépôt ou PR concernés.', 200), resultat: TXT('Résultat.', 300), erreur: TXT('Erreur rencontrée, le cas échéant.', 300),alerte_ref:TXT('Empreinte active du pilotage ; marque un signalement préparé, pas sa livraison visible.',24) }, ['action']), ECRITURE],
  ['securite_terminer_gestion', 'Terminer un passage du gestionnaire', 'Clôt le passage : resultat « rien » (rien à traiter), « fait » ou « echec » (erreur obligatoire). Un passage sans activité pendant ' + S.GESTION_SILENCE_MIN + ' min est marqué interrompu, jamais réussi.',
    OBJ({ passage_id: ENT('Passage (défaut : le passage en cours).', 1, 1e9), resultat: ENUM('Issue du passage.', S.RESULTATS_GESTION), resume: TXT('Ce qui a été traité (10 à 2000 caractères).', 2000), erreur: TXT('Ce qui a empêché le passage (obligatoire si echec).', 300) }, ['resultat', 'resume']), ECRITURE],
  ['securite_journal', 'Journal d’activité d’un agent', 'Le journal de l’auditeur (plans, démarrages, fins, reports, appels refusés) ou du gestionnaire (passages et opérations de triage) : heure, action, cible, résultat et erreur éventuelle.',
    OBJ({ agent: ENUM('Agent.', S.AGENTS), limit: ENT('Nombre de lignes (défaut 50).', 1, 200) }, ['agent']), LECTURE],
  ['securite_tendances', 'Analyser les tendances', 'Faiblesses récurrentes par CWE, récidives, failles rouvertes après revalidation, dépôts les plus touchés, dépôts négligés (jamais audités ou modifiés depuis leur dernier audit), rythme par semaine.',
    OBJ({ jours: ENT('Période en jours (défaut 90).', 7, 365) }), LECTURE],
];
const NOMS = new Set([...DEFS.map((d) => d[0]),...engine.names,...pilotage.names]);

function estMaster(moi) { try { return require('../modules/metisdocs').estMaster(moi); } catch { return false; } }

function tools(moi) {
  if (!estMaster(moi)) return [];
  return [...DEFS.map(([name, title, description, inputSchema, annotations]) => ({ name, title, description, inputSchema, annotations })),...engine.tools(),...pilotage.tools()];
}

function enveloppe(out) {
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, ...(out.ok ? {} : { isError: true }) };
}
function erreur(e) {
  if (e instanceof S.ErreurSecurite) return enveloppe({ ok: false, error: { code: e.code, message: e.message, retryable: false } });
  try { require('../core/logger').error('metis', 'Security Center : ' + (e.stack || e.message)); } catch { /* */ }
  return enveloppe({ ok: false, error: { code: 'INTERNAL', message: 'Erreur interne du Security Center : ' + e.message, retryable: true } });
}

const TABLE = {
  ...engine.table,
  ...pilotage.table,
  securite_etat: (a, m) => S.etatPourRoutine(m, a),
  securite_inventaire: (a, m) => S.inventaire(m, a),
  securite_synchroniser_depots: async (a) => { if (Object.keys(a).length) throw new S.ErreurSecurite('INVALID_ARGUMENT', 'securite_synchroniser_depots ne prend aucun argument.'); return { ok: true, ...(await S.synchroniserDepots()) }; },
  securite_declarer_depots: (a, m) => S.declarerDepots(m, a),
  securite_classer_depots: (a, m) => S.classerDepots(m, a),
  securite_planifier_journee: (a, m) => S.planifierJournee(m, a),
  securite_demarrer_audit: (a, m) => S.demarrerAudit(m, a),
  securite_journaliser_audit: (a, m) => S.journaliserAudit(m, a),
  securite_terminer_audit: (a, m) => S.terminerAudit(m, a),
  securite_declarer_faille: (a, m) => S.declarerFaille(m, a),
  securite_maj_faille: (a, m) => S.mettreAJourFaille(m, a),
  securite_revalider_faille: (a, m) => S.revaliderFaille(m, a),
  securite_lister_failles: (a, m) => S.listerFailles(m, a),
  securite_lire_faille: (a, m) => S.lireFaille(m, a),
  securite_lister_audits: (a, m) => S.listerAudits(m, a),
  securite_lire_audit: (a, m) => S.lireAudit(m, a),
  securite_suivi_corrections: (a, m) => S.suiviCorrections(m, a),
  securite_tendances: (a, m) => S.tendances(m, a),
  securite_demarrer_gestion: (a, m) => S.demarrerGestion(m, a),
  securite_journaliser_gestion: (a, m) => S.journaliserGestion(m, a),
  securite_terminer_gestion: (a, m) => S.terminerGestion(m, a),
  securite_journal: (a, m) => S.journalAgents(m, a),
};

/** Rend une réponse MCP (ou une promesse de réponse), ou null si l'outil n'est pas d'ici. */
function call(nom, args, moi, context = {}) {
  if (!NOMS.has(nom)) return null;
  if (!estMaster(moi)) return enveloppe({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'Le Security Center est réservé au propriétaire de l’instance.', retryable: false } });
  // Un appel refusé d'un agent entre aussi dans son journal (« éventuelle erreur »).
  const echec = (e) => { S.consignerErreur(nom, e); return erreur(e); };
  try {
    const r = TABLE[nom](args || {}, moi, context);
    return r && typeof r.then === 'function' ? r.then(enveloppe, echec) : enveloppe(r);
  } catch (e) { return echec(e); }
}

module.exports = { tools, call, NOMS };
