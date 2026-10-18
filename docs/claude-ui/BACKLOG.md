# Suivi — lots suivants (hors interface)

Constaté dans le code le 18/10/2026. Rien de ceci n'est implémenté.

## GitHub

- **Créer un dépôt GitHub depuis l'interface** : aucun point d'API ; seul le clonage existe
  (`/api/projects/clone-progress`, jetons GitHub stockés).
- **Connecter un remote** (`git remote add`) : aucun point d'API ; les routes push / pull / publish répondent
  « No remote repository configured ».
- Opérations existantes à exposer dans le volet « Changes » : statut, diff, commit, branches, fetch / pull /
  push / publish (`/api/git/*`).

## NAS et machines

- **Créer le dossier d'un projet directement sur un RuntimeNode distant** (NAS) : aujourd'hui le dossier d'un
  nœud est *mappé* et vérifié par le nœud, pas créé.
- **NAS comme RuntimeNode** : le Relay hébergé n'exécute jamais rien (`docs/hosted-relay.md`). Pour exécuter
  des projets, le NAS doit lancer `cloudcli node` et être inscrit. À préparer avec un journal d'opérations exact
  pour le projet Jarvis, dans un lot dédié.
- **Continuité multi-plateforme** : le code se synchronise par Git, les conversations vivent dans le plan de
  contrôle. Une session reste liée à son nœud ; changer de machine passe par un transfert (nouvelle exécution
  avec contexte).

## Interface (en attente de références)

Voir `README.md` §1 : mobile, thème clair, nouvelle session, menus ouverts, permission desktop, volet de vue.
