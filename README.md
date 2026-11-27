# Métis

**Métis chez soi** : un serveur de recherche et de collaboration pour assistants IA, à installer sur
sa propre machine (PC, Mac, Linux, Raspberry Pi), que l'on soit un particulier ou une entreprise.
Documents versionnés, graphiques et schémas dessinés par le serveur, glossaire, carnet de tâches,
projets, collaboration entre agents… et un serveur MCP pour que Claude, ChatGPT ou un modèle local
s'en servent.

Les données restent **chez vous**. Plus tard, `plagnito.com` pourra servir de passerelle pour
consulter votre Métis à distance : il ne fera que relayer, l'appareil qui héberge Métis restera chez
vous.

> ⚠️ **État : version autonome 0.8.0, pas encore publiée sur npm.** Serveur, comptes, jetons,
> serveur MCP, interface web (publications, glossaire, graphiques, recherche, carnet, projets,
> accès) et **issues GitHub** fonctionnent ; le Security Center dans l'interface arrive ensuite. En attendant la publication npm,
> installez depuis une [Release GitHub](https://github.com/Plagnito/metis/releases).

## Démarrer

```sh
npm install -g https://github.com/Plagnito/metis/releases/download/v0.8.0/plagnito-metis-0.8.0.tgz
metis serve
```

Au démarrage, Métis affiche un **lien pour ouvrir l'interface** dans le navigateur (usage unique,
15 minutes). Au premier lancement, il crée aussi le compte propriétaire et affiche **un jeton d'accès,
montré une seule fois**, avec la commande pour y brancher Claude Code :

```sh
claude mcp add --transport http metis http://127.0.0.1:4747/mcp --header "Authorization: Bearer metis_…"
```

Les clients qui ne lancent que des serveurs MCP en stdio (Claude Desktop, Codex…) utilisent le
pont `metis mcp`, avec le jeton dans la variable `METIS_JETON`.

| Commande | Rôle |
|---|---|
| `metis serve` | Démarre le serveur sur `http://127.0.0.1:4747` (`--port`, `--hote`, `--donnees`, `--url-publique`, `--pseudo`). |
| `metis lien` | Lien de connexion à l'interface, à usage unique (15 min). `--pseudo NOM` pour un membre. Un lien est aussi affiché à chaque démarrage. |
| `metis compte --pseudo NOM` | Crée un compte membre ; le propriétaire lui donne l'accès (lecteur ou éditeur) dans l'interface. |
| `metis jeton --client NOM` | Crée un jeton pour un agent (`claude-code`, `codex`, `equipe-ci`…). Chaque client peut recevoir ses propres limites. |
| `metis agent --client NOM --github PRESET` | Limites GitHub d'un agent : `lecture` (défaut), `contributeur`, `mainteneur` ; `--depots a/b,c/d` pour n'ouvrir que certains dépôts. |
| `metis jetons` / `metis revoquer ID` | Liste les jetons, en révoque un : il ne passe plus dès l'appel suivant. |
| `metis mcp` | Pont MCP stdio vers le serveur (`--url`, `--jeton` ou `METIS_JETON`). |

## Issues GitHub

Un projet Métis peut **suivre un dépôt GitHub** (page *Issues GitHub* ou outil `github_suivre_depot`).
La synchronisation fait de chaque issue ouverte une **tâche du projet** : vos agents la reprennent
avec les sessions, critères, preuves et la reprise de travail des projets ; fermée sur GitHub, la
tâche se clôt aussi.

Les agents peuvent agir sur GitHub — commenter, lier la pull request qui corrige, fermer, rouvrir,
étiqueter, assigner, créer une issue — **chacun dans les limites que vous lui fixez** :

| Préréglage | L'agent peut |
|---|---|
| `lecture` (par défaut) | lire les issues et leurs commentaires |
| `contributeur` | lire, commenter, lier une PR |
| `mainteneur` | tout |

Les limites se règlent par agent (le client de son jeton), dans l'interface ou avec `metis agent` ;
aucun outil MCP ne peut les modifier. Toute écriture sur GitHub est inscrite dans un journal
immuable. Le jeton GitHub se donne par `METIS_GITHUB_TOKEN` (droits « Issues » sur les seuls
dépôts concernés) ; sans lui, seuls les dépôts publics se lisent et rien n'est écrit.

Les données vivent dans `~/.metis` (ou `METIS_DONNEES`) : une base SQLite, rien d'autre. Le serveur
n'écoute que sur cette machine par défaut, et un second serveur sur la même base est refusé.

## Feuille de route

1. **Extraction** (faite) — les modules ont quitté Atlas, qui est devenu un hôte parmi d'autres.
2. **Serveur autonome** (en cours) — `metis serve`, base locale, comptes et jetons, `/mcp` (fait) ;
   interface web complète ; **issues GitHub** en tâches de projet, que les agents peuvent traiter
   dans les limites que vous fixez pour chacun ; Security Center dans l'interface ; publication npm.
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
