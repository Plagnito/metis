# Métis

**Métis chez soi** : un serveur de recherche et de collaboration pour assistants IA, à installer sur
sa propre machine (PC, Mac, Linux, Raspberry Pi), que l'on soit un particulier ou une entreprise.
Documents versionnés, graphiques et schémas dessinés par le serveur, glossaire, carnet de tâches,
projets, collaboration entre agents… et un serveur MCP pour que Claude, ChatGPT ou un modèle local
s'en servent.

Les données restent **chez vous**. Plus tard, `plagnito.com` pourra servir de passerelle pour
consulter votre Métis à distance : il ne fera que relayer, l'appareil qui héberge Métis restera chez
vous.

> ⚠️ **État : extraction en cours, pas encore installable.** Le code de Métis vit aujourd'hui dans
> Atlas (la plateforme de plagnito.com) et déménage ici module par module. Tant que la commande
> `metis serve` n'existe pas, ce paquet ne sert qu'à Atlas, qui le consomme comme dépendance.

## Feuille de route

1. **Extraction** (en cours) — les modules quittent Atlas, qui devient un hôte parmi d'autres.
2. **Serveur autonome** — `npx @plagnito/metis serve`, base SQLite locale, interface web, `/mcp`.
3. **Passerelle** — `metis link` relie l'appareil à votre compte Atlas ; consultation à distance par
   `plagnito.com`, sans ouvrir de port.
4. **Documentation et distribution.**

## Ce qui est déjà ici

| Module | Rôle |
|---|---|
| `graphiques`, `graphiques-planche` | Une spécification JSON devient un SVG accessible (32 types, planches d'architecture). Pur : ni base, ni réseau. |
| `metis-recovery` | Enveloppe d'erreur commune des outils (`code`, `message`, `recovery`). |
| `metis-idempotency` | Empreintes de requêtes pour rejouer sans dupliquer. |
| `metis-outcome-code` | Classement des codes de résultat. |
| `metis-doctor`, `metis-observability` | Mesures de latence et d'erreurs des outils. |
| `metis-research-journal` | Journal d'événements immuable, tenu par des déclencheurs SQLite. |
| `metisdocs` | Publications versionnées (sections, notes, archives), glossaire des sigles et leurs fiches, graphiques insérés, droits de lecture et d'écriture. |
| `metiscarnet` | Carnet des petites choses à faire : à faire, en cours, terminé, archivage automatique. |
| `metisarchitecture`, `metisbatch` | Registre transversal (requêtes, audit, graphe, autorités) et lots atomiques prévisualisés puis validés. |
| `metisexperts` | Registre des experts, pools et compétences. Requis par le registre transversal ; ne fera pas partie de l'interface de la première version autonome. |
| `metisresearch` | Research Fabric : recherche transversale sous contrôle d'accès, paquets de contexte, export, vue d'ensemble. |
| `metiscollaboration` | Agents, éléments de travail, passations et revues entre agents. |
| `metisscience` | Sources, affirmations, preuves, décisions, jeux de données, protocoles et exécutions. |
| `metiscontinuity` | Sessions, notes de recherche, abonnements aux changements, diagnostics du MCP. |
| `metisprojects`, `metisdevelopment` | Projets, tâches, jalons, et reprise de développement (contexte, checkpoints, preuves, adaptateurs Codex / Claude / OpenCode). |
| `metis-access-fence`, `metis-reading`, `metis-app-permissions` | Droits de lecture calculés à chaque requête, lecture paginée, permissions par application cliente. |
| `metisnexus` | Canaux et messages entre agents. Requis par le contrôle d'accès ; hors de l'interface de la première version autonome. |
| `web/*-tools` | Les définitions d'outils MCP de ces domaines (schémas d'entrée, annotations), dont le carnet. |
| `metis-securite` (+ `-engine`, `-pilotage`, `-differential`, `-report`) | **Security Center** : inventaire des dépôts GitHub de l'instance (déclarés ou synchronisés), plan d'audit quotidien par un agent, failles, preuves, revalidations, contrôles préventifs. Aucun inventaire livré : une instance neuve démarre vide. Réservé au propriétaire. |
| `web/metis-mcp` | Le **noyau du serveur MCP** : catalogue d'outils selon le rôle (`catalogueDe`), aiguillage d'un appel (`appeler`), consignes d'initialisation (`instructions`). Le transport HTTP et l'authentification restent chez l'hôte. |
| `tools/metis-context/bridge.cjs` | Pont portable côté client, copié dans le dépôt de travail (`.metis/bridge.cjs`). |

## L'hôte

Les modules ne parlent jamais directement à une base ou à un journal : ils passent par l'**hôte**
(`lib/host.js`), configuré une fois par processus.

```js
const host = require('@plagnito/metis/host');
host.configure({
  db: () => ({ db: maBaseSqlite }),             // un DatabaseSync de node:sqlite
  sqliteContext: () => require('@plagnito/metis/defaut/sqlite-context'),
  logger: () => ({ debug() {}, info() {}, warn: console.warn, error: console.error }),
  publicUrl: 'https://metis.exemple.org',
});
const G = require('@plagnito/metis/modules/graphiques');
```

Chaque entrée est une fabrique, résolue au premier usage : charger un module pur n'ouvre aucune base.

Entrées facultatives :

| Entrée | Rôle |
|---|---|
| `comptes()` | `compte(id)`, `estProprietaire(compte)`, `compteParPseudo(pseudo)` : qui est connecté, qui possède l'instance. |
| `rendu()` | `rendre(markdown)`, `ancre(titre)`, `echapper(texte)` : rendu Markdown des documents. |
| `graines` | Dossier de contenu semé au démarrage (plans `.md`, `glossaire.json`, `experts.json`). Absent : l'instance démarre vide. |
| `depotsConnus` | Noms de dépôts proposés dans le carnet. Ce sont des données de l'instance. |
| `extensions()` | Outils MCP propres à l'hôte, branchés sur le noyau : `{ catalogue, outils(ecrivain, moi), noms, appeler(nom, a, moi, ctx), consignes(moi, disponibles) }`. |
| `securite` | Réglages du Security Center : `proprietaires` (comptes GitHub admis), `organisations`, `famille(compte, nom)`, `libellesFamilles`, `importance` (JSON de classement), `jeton()` (défaut : `SECURITE_GITHUB_TOKEN` ou `GITHUB_TOKEN`). |
| `commandes()` | `get(compte, id)` : registre d'exécutions où le Security Center vérifie un rapport avant planification. Absent : planification avec rapport exigé refusée. |
| `selftest()` | `summary()` : rapport de qualification isolée de l'hôte. Absent : « unavailable ». |

Un module qui a besoin d'une entrée absente échoue en le disant. Les modules de recherche lisent aussi
leurs interrupteurs dans l'environnement (`METIS_RESEARCH_ENABLED`, `METIS_COLLAB_ENABLED`,
`METIS_SCIENCE_ENABLED`, `METIS_CONTINUITY_ENABLED`, `METIS_CONTEXT_ENABLED`, `METIS_AUDIT_ENABLED`, à `1`).
Les fonctions SQL `atlas_actor_id`, `atlas_client_id` et `atlas_fold` gardent leur nom historique,
parce que des bases existantes ont des déclencheurs qui les appellent.

## Prérequis

Node.js **22.13 ou plus récent** (`node:sqlite` sans option expérimentale). Aucune dépendance native
à compiler.

## Tests

```sh
npm test
```

## Licence

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Vous pouvez utiliser, modifier
et redistribuer Métis librement ; si vous le proposez comme service à d'autres personnes, vous devez
leur donner accès au code source de votre version.

Les contributions sont les bienvenues : lisez [CONTRIBUTING.md](CONTRIBUTING.md) avant d'ouvrir une
pull request, elle demande d'accepter l'[accord de contribution](CLA.md).
