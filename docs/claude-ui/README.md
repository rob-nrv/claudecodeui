# Interface façon Claude desktop — état après le lot 2

État au 18/10/2026 sur `main` @ `b4c43461`, modifications non commitées. Rien n'a été poussé ni déployé,
aucun service NAS/Jarvis n'a été touché.

Preuves (captures, superpositions, cartes de différences, mesures, scripts) : dossier local
`claude-ui-evidence` à côté du dépôt, volontairement hors Git (il contient des captures de conversations
personnelles). Le patch du lot 1 y est sauvegardé (`patches/`).

## 1. Références et comparaisons, écran par écran

Référence principale : **l'application Claude desktop 2.42304 observée le 18/10/2026** (capture de la zone
cliente Windows par `PrintWindow`, 2560×1392 @1x, sans recadrage, sans clic ni modification de l'application).
La capture du 14/10 (1207×1387) est un recadrage manuel (≈7 px coupés à gauche, 1 px en haut) d'une version
légèrement antérieure : elle reste utilisée pour la typographie.

| Écran / état | Référence disponible | Comparaison effectuée | Écarts restants |
| --- | --- | --- | --- |
| Conversation, bureau, sombre, fenêtre large | **L** (18/10, 2560×1392) | Superposition + `pixelmatch` par zone ; rectangles DOM | Barre latérale 4,2 % (glyphes, icônes d'état ☁ non reproduites) ; en-tête 2,5 % ; zone composer 1,6 % ; carte Environment 5,9 % ; colonne de conversation 16,6 % (contenu différent : la référence est un autre passage de la conversation, avec sélection de texte et miniatures) |
| Conversation, bureau, sombre, fenêtre étroite | **A** (14/10, 1207×1387, recadrée) | Superposition (7,2 %) ; **coupures de ligne : 24/24 identiques** à largeur de colonne égale | Version antérieure de Claude (puces ○, sélection #343434) : la barre latérale suit L, pas A ; panneau ±10 px selon le modèle de marge |
| Conversation, bureau, **clair** | aucune | aucune | Couleurs claires **provisoires** |
| **Mobile** (conversation, tiroir) | aucune | Capture 412×915 seulement | Non validé |
| Nouvelle session (« New ») | aucune desktop (X1 = extension VS Code) | Capture seulement | Contenu d'accueil CloudCLI conservé |
| Menus ouverts (titre, compte, modèle, mode, « + », ⋮) | aucune | aucune | Style dérivé des surfaces mesurées, non vérifié |
| Outils repliés / en erreur / diff | L (+2 −1, phrases), C1 (erreur rouge `#ff2c56`) | Mesures de couleurs et de géométrie | Miniatures d'images lues non reproduites |
| Outil déplié, liste d'outils | C2 (juillet, ancienne version) | Visuelle seulement | Non validé sur la version actuelle |
| Question (AskUserQuestion) | C3–C11 (juillet–août, ancienne version) | Mesures de structure et couleurs | Couleurs adaptées au thème actuel, non vérifiées |
| Demande de permission | X2/X3 = **extension VS Code**, pas l'application desktop | Structure et libellés repris | Référence desktop manquante |
| File d'attente, bandeau de limite d'usage | C2 (file), L (bandeau) | Mesures | Bouton « Get more usage » remplacé par « Usage details » (pas d'offre Anthropic à proposer) |
| Volet de vue à droite (diff, terminal…) | B (31/07, ancienne version) | Visuelle | Non validé sur la version actuelle |

### Références manquantes (liste courte)

1. **Mobile** : capture Claude (application téléphone) — liste des conversations, conversation remplie, composer, un menu.
2. **Thème clair** : la même vue Code qu'en L, en clair, fenêtre maximisée.
3. **Nouvelle session** : écran après « New » dans la vue Code.
4. **Menus** : titre ⌄, compte (pied), modèle « Opus 5.5 High », mode « Auto », « + », ⋮ de l'en-tête.
5. **Permission** dans l'application desktop (pas l'extension VS Code).
6. **Volet** terminal / diff / fichiers ouvert à droite, version actuelle.

Pour les captures les plus simples : fenêtre maximisée, puis `Win + Maj + S` → « Fenêtre ». Ou bien j'utilise
la méthode passive déjà employée pour L (zone cliente seule, aucun clic) si tu ouvres l'écran voulu et me le dis.

## 2. REA (morluto/rea 6.7.0)

Installé **localement** dans un dossier temporaire (`npm i rea-agents@6.7.0 --ignore-scripts`, aucun script
d'installation déclaré par le paquet), **sans `rea setup`** : aucune configuration d'agent modifiée
(`rea doctor` le confirme : aucune intégration enregistrée).

| Méthode REA | Statut | Constat |
| --- | --- | --- |
| `inspect-electron-fuses` (lecture statique des fusibles, sans lancer l'application) | **Utilisée** sur `Claude.exe` 2.42304 | `RunAsNode` et `EnableNodeCliInspectArguments` désactivés, intégrité de l'`asar` imposée, chargement `app.asar` seul. REA précise que cela ne dit pas si un port de débogage Chromium est accepté. |
| `observe-native-ui` / `capture-native-ui-scenario` (capture + arbre d'accessibilité d'une fenêtre) | **Essayée** | Limitation technique : « Native macOS utilities require macOS ». Indisponible sous Windows. |
| `list-electron-targets` / `inspect-electron-page` (CDP sur l'application Electron) | Non utilisée | Exigerait de **relancer** Claude desktop avec un port de débogage, ce qui interrompt l'application ouverte. Possible uniquement avec ton accord, à un moment où elle n'est pas utilisée ; rien ne garantit que le port soit accepté. |
| `list-browser-targets` / `inspect-web-page` / `capture-web-screenshot` / `compare-web-screenshots` / `observe-web-session` (observation passive d'une page dans ton navigateur) | Prête, non exécutée | Demande un Chrome lancé par toi avec un profil dédié et `--remote-debugging-port` sur la boucle locale, connecté à claude.ai. Donnerait la **structure DOM réelle, l'arbre d'accessibilité et des captures à tailles exactes** (dont le clair et une vue mobile émulée) de l'interface web, très proche de l'application. Le port expose ce navigateur aux processus locaux : profil dédié, fermé après usage. |
| `analyze-javascript-application` / `recover-javascript-sources` / `export-web-scripts` (reconstruction statique du code) | Non utilisée | Contrainte documentée par les conditions d'utilisation d'Anthropic (interdiction de rétro-ingénierie du logiciel). L'interface de la vue Code est en outre servie par claude.ai, pas par l'`asar` local. |
| Captures réseau (HAR, SAZ, pcap) | Non utilisée | Contiendraient des jetons de session ; exclu par ta consigne. |

En complément (hors REA), lecture passive de l'arbre UI Automation de Windows : seule la charpente native est
exposée, car Chromium ne publie pas l'arbre de la page sans technologie d'assistance active. Je n'ai pas modifié
ce réglage système.

## 3. Modèle de mise en page mesuré

- Barre latérale **287 px** : rangée fenêtre (icônes centrées en x = 25,5 / 57,5 / 89,5 / 119,5 ; sélecteur
  Chat/Code x = 210–279) ; recherche x = 10–274, y = 44–69 ; entrées de 26,67 px (New, Running, Customize, More) ;
  groupes de 28 px (libellé 12,5 px à x = 19, « + » centré à x = 264,5) ; sessions de 28 px au pas de 30
  (fond `#232323` pour la session ouverte, titre 13,25 px à x = 18, point gris à droite) ; pied de 40 px.
- Conversation : boîte = min(768, zone − 279 − 66), **centrée sur toute la zone** si elle tient, sinon calée
  à 33 px du panneau ; colonne = boîte − 13 px à gauche / 10 px à droite ; texte des réponses coupé 30 px
  avant le bord ; bulles ≤ 83 %. Vérifié : composer 1034–1801 × 1304–1347 (réf. 1035–1802 × 1304–1347).
- Panneau droit : cartes de 278 px à 13 px du bord droit, 17 px sous l'en-tête, 10 px d'écart ; affiché
  quand la zone de conversation fait ≥ 820 px (requête de conteneur) et selon le bouton de l'en-tête.
- Typographie : Manrope 14/20, interlettrage 0,085 px (meilleure forme parmi 20 polices libres ; la police
  de Claude est propriétaire et n'a pas été extraite). À largeur égale, **toutes les coupures de la référence
  A sont reproduites** (24/24). Les formes de lettres restent différentes.

## 4. Correspondance interface Claude → CloudCLI → backend

| Élément Claude | Composant | Backend | État |
| --- | --- | --- | --- |
| Chat / Code | `SidebarHeader` | modes de liste existants (conversations / projets) | fonctionnel |
| Search, New, Customize, More | `SidebarHeader` | recherche, nouvelle session, Réglages, archives / projet / rafraîchir | fonctionnels |
| Artifacts (4ᵉ entrée) | remplacée par **Running** | sessions en cours (activité WebSocket) | fonctionnel ; Artifacts n'existe pas dans CloudCLI |
| Groupes + sessions | `SidebarProjectItem`, `SidebarSessionItem` | `/api/projects`, sessions, renommage, archivage, transfert | fonctionnels |
| ☁ en fin de ligne | — | — | **non reproduit** : sens non vérifiable |
| Pied « Nom · Offre ⌄ » | `SidebarFooter` | `/api/claude-profiles` (défaut), `live-usage` | réutilise le changement de compte existant |
| Titre ⌄ | `MainContentTitle` | projet, compte de la session, lignée | fonctionnel |
| Actions d'en-tête (panneau, terminal, diff, navigateur, dossier, ⋮) | `MainContentTabSwitcher` | `/shell`, `/api/git/*`, browser-use, `/api/files`, tâches, plugins | fonctionnelles, ouvertes dans un volet à droite (`MainViewPaneHeader`) |
| Lignes d'outils + diff +N −N | `ToolGroupContainer`, `describeToolGroup` | messages d'outils (calcul de diff ligne à ligne) | fonctionnel |
| Point « … » flottant | `ChatInterface` | défilement + activité | fonctionnel |
| Bandeau « Approaching … usage limit » | `UsageLimitBanner` | `GET /api/claude-profiles/:id/live-usage` | n'apparaît que sur un relevé réel (≥ 75 %) |
| Composer (+, ⏎ / ◉, micro), Auto, modèle, anneau | `ChatComposer`, menus | `chat.send`, arrêt, file, steer, voix, modes, modèles, `tokenBudget` | fonctionnels |
| Environment (machine, Save, dossier, Remote) | `ChatSidePanel` | `/api/runtime-nodes`, choix par projet, `/api/remote-access/status` | fonctionnels ; l'interrupteur montre l'état réel et ouvre les réglages (la passerelle se configure par `.env`) |
| Context | `ChatSidePanel` | `tokenBudget.used/total` | sans répartition par catégorie (non fournie) |
| Connectors | `ChatSidePanel` | `/api/providers/claude/mcp/servers` | affiche les serveurs **configurés** (l'état « connecté » n'est pas connu) |
| Outputs | `ChatSidePanel` | outils Write/Edit de la session | fonctionnel |
| Background tasks | — | — | non reproduit : pas de donnée côté CloudCLI |
| Question / permission / file d'attente | `AskUserQuestionPanel`, `PermissionRequestsBanner`, `QueuedMessageCard` | décisions existantes (autoriser, mémoriser, refuser avec message) | fonctionnels |

## 5. Test authentifié en isolation

Instance isolée : `HOME`, `USERPROFILE` et `DATABASE_PATH` dans le scratchpad, ports 3101 / 5273.
La base principale `~/.cloudcli/auth.db` n'est jamais ouverte (empreinte relevée avant et après, inchangée).

Mécanisme existant réutilisé : deux profils **« Compte 1 »** (défaut) et **« Compte 2 »** créés par l'API des
profils ; chacun a son propre `CLAUDE_CONFIG_DIR` dans le HOME isolé. La connexion crée de nouveaux
identifiants dans ces dossiers : **rien n'est copié** depuis tes profils réels.

Geste exact (une fois par compte) :
1. Ouvrir `http://localhost:5273` avec le compte de test de l'instance isolée (identifiants dans le dossier
   de preuves local, `ISOLATED-TEST.txt`, jamais dans le dépôt).
2. Barre latérale → **Customize** → **Agents** → **Claude** → **Account** → section *Claude Accounts*.
3. Sur **Compte 1**, bouton **Login** : un terminal intégré lance `claude /login` dans le dossier du profil ;
   suivre l'authentification dans le navigateur avec ton **premier** compte Claude.
4. Recommencer sur **Compte 2** avec ton **second** compte (fenêtre privée ou déconnexion de claude.ai entre
   les deux, pour choisir l'autre compte).

Vérification ensuite (script prêt, `tools/auth-e2e.mjs` dans le dossier de preuves) : profils « connectés »,
message réel sur Compte 1 avec réponse, puis **poursuite de la même conversation sur Compte 2** par le
transfert existant (« Continue in a new run… »), réponse et lignée vérifiées. Il n'affiche ni identifiant
ni jeton. Lancé aujourd'hui, il s'arrête correctement : « Compte 1 is not signed in ».

## 6. Bilan

**Vérifié** : géométrie de l'écran de conversation sombre (barre latérale, en-tête, composer, panneau) sur
l'application actuelle, à 1 px près ; coupures de ligne 24/24 ; parcours d'envoi réel jusqu'au CLI
(lot 1) ; tests client 234/234 (dont nouveaux tests : résumés d'outils, diff, noms de modèles, composer,
permissions) ; `tsc` sans erreur.

**Pas encore au pixel près** : formes de lettres (police libre) ; icônes (Lucide ou SVG simples, pas les
icônes de Claude) ; éléments sans donnée (☁, répartition du contexte, tâches de fond, miniatures) ; tous
les écrans du §1 sans référence.

**À faire** : références du §1 ; test authentifié (§5) ; lot GitHub / NAS (`BACKLOG.md`).

## 7. Fichiers

Thème : `src/index.css`, `tailwind.config.js`, `index.html`. Coque : `AppContent`, `MainContent`
(volet de vue), `MainContentHeader`, `MainContentTitle`, `MainContentTabSwitcher` (actions d'en-tête),
`MainViewPaneHeader`, `main-content/utils/viewLabels.ts`. Barre latérale : `SidebarHeader`, `SidebarContent`,
`SidebarProjectList`, `SidebarProjectItem`, `SidebarProjectSessions`, `SidebarSessionItem`, `SidebarFooter`,
`useSidebarController`. Conversation : `ChatInterface`, `ChatMessagesPane`, `MessageComponent`, `Markdown`,
`ToolGroupContainer`, `ActivityIndicator`, `ChatComposer`, `ComposerModelMenu`, `ComposerPermissionMenu`,
`ComposerMenuPrimitives`, `TokenUsageSummary` (anneau), `ChatSidePanel`, `UsageLimitBanner`,
`QueuedMessageCard`, `PermissionRequestsBanner`, `AskUserQuestionPanel`. Utilitaires : `toolGrouping.ts`,
`modelDisplayName.ts`, `runtimeNodes.ts`, `useClaudeProfiles.ts`, `useUiPreferences.ts`,
`QuickSettingsPanelView.tsx`. Textes : `en/chat.json`, `fr/chat.json`.
Non touchés : `ShellMinimalView.tsx` (modification locale préexistante), `stash@{0}`, fichiers non suivis.

## 8. Journal NAS / Jarvis

Aucune opération dans ce lot.
