# Contribuer à Métis

Merci de votre intérêt. Quelques règles, courtes :

1. **Accord de contribution.** Toute pull request doit accepter l'[accord de contribution](CLA.md)
   par la phrase indiquée dans ce fichier. C'est ce qui permet au projet de rester utilisable par
   son mainteneur dans ses propres services.
2. **Tests.** `npm test` doit passer. Une correction arrive avec le test qui l'aurait attrapée.
3. **Aucune dépendance native.** Métis doit s'installer sans compilateur, sur Windows comme sur un
   Raspberry Pi : on s'appuie sur `node:sqlite` et la bibliothèque standard de Node.
4. **Pas d'accès direct à l'extérieur depuis un module.** Base, journal et identité passent par
   l'hôte (`lib/host.js`), jamais par un chemin ou une variable d'environnement propre à une
   application.
5. **Pas de données personnelles ni de secrets** dans le dépôt, les tests ou les exemples.
6. **Langue.** Le code et la documentation du projet sont écrits en français ; une issue en anglais
   est bienvenue.

Pour signaler une faille de sécurité, n'ouvrez pas d'issue publique : utilisez le signalement
privé de GitHub (onglet « Security » du dépôt).
