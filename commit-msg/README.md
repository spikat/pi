# commit-msg

Extension pi qui ajoute la commande :

```text
/gen-commit-msg
```

Elle lit les changements git staged (`git diff --cached`) et demande à l'assistant de générer un message de commit en anglais. Une fois le résultat généré, elle propose de le copier dans le presse-papier.

Contraintes demandées à l'assistant :

- maximum 5 lignes ;
- la première ligne résume l'ensemble des changements ;
- sortie limitée au message de commit, sans markdown ni explication.

## Utilisation

Test ponctuel :

```bash
pi -e ./commit-msg
```

Installation projet avec auto-discovery :

```bash
mkdir -p .pi/extensions
cp -R commit-msg .pi/extensions/
pi
```

Puis lancer :

```text
/gen-commit-msg
```
