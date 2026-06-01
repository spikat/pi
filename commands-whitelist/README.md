# commands whitelist

Extension pi qui demande une confirmation avant chaque action de l'assistant, avec persistance des choix whitelistés.

## Comportement

- Pour chaque action, l'extension propose :
  1. `oui, et whitelist pour les prochaines fois` (action exacte, arguments inclus)
  2. `oui, et whitelist globalement cette commande` (même commande, quels que soient ses arguments)
  3. `oui, mais uniquement cette fois`
  4. `entrer un prompt pour l'assistant` (bloque l'action courante et envoie le prompt comme instruction)
  5. `non`
- Les lectures de fichiers sont autorisées sans confirmation, quelle que soit la méthode et le chemin : action `read`, `ls`, `grep`, `rg`, `find`, `head`, `tail`, `wc`, etc.
- Les commandes `bash` reconnues comme lecture seule sont aussi autorisées sans confirmation, par exemple `grep`, `rg`, `git diff`, `git status`, `wc`, `find`, `head`, `tail`, `sed` sans modification (`sed ...` en lecture ou dans un pipe), et les pipelines composés de ces commandes.
- Pour les commandes `bash` composées, la whitelist globale prend en compte toutes les sous-commandes, pas seulement la première : `find ... | xargs grep ... | head ...` devient `bash:find | grep | head`.
- `sed` est autorisé sans confirmation uniquement s'il ne modifie pas de fichier. `sed -i` / `sed --in-place` ou une redirection de sortie demandent confirmation et peuvent être whitelistés.
- Pour les éditions de fichiers (`edit`, `write`), l'option 1 devient :
  `oui, et whitelist les editions de fichier dans ce répertoire`.
  L'option 2 reste disponible et whitelist alors la commande entière (`tool:edit` ou `tool:write`), quel que soit le chemin.
- En mode sans UI, les actions qui nécessitent une confirmation sont bloquées par défaut.

## Commande `/whitelist`

L'extension ajoute une commande interactive :

```text
/whitelist
```

Elle ouvre un menu listant les whitelists courantes :

- `↑` / `↓` : se déplacer
- `d` : supprimer l'entrée sélectionnée
- `e` : éditer l'entrée sélectionnée
- `q` ou `Esc` : quitter

Les raccourcis sont affichés en bas du menu.

## Stockage des whitelists

La liste des whitelists est stockée dans :

```text
<racine du repo git>/.pi/commands-whitelist.json
```

Si le répertoire courant n'est pas dans un repo git, elle est stockée dans :

```text
<répertoire courant>/.pi/commands-whitelist.json
```

Le fichier et le répertoire `.pi/` sont créés automatiquement au premier whitelist.

## Installation / utilisation

Test ponctuel :

```bash
pi -e ./commands-whitelist
```

Installation projet avec auto-discovery :

```bash
mkdir -p .pi/extensions
cp -R commands-whitelist .pi/extensions/
pi
```

Ensuite, `/reload` recharge l'extension si pi est déjà lancé.
