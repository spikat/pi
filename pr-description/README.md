# pr-description

Extension pi qui ajoute la commande :

```text
/gen-pr-desc
```

Elle regarde les commits de la branche courante par rapport à la branche de base détectée (`origin/HEAD`, `origin/main`, `origin/master`, `main`, puis `master`) et demande à l'assistant de générer une description de PR en markdown **en anglais**.

Template utilisé :

```markdown
### What does this PR do?

### Motivation

### Describe how you validated your changes

### Additional Notes
```

Une fois la description générée, l'extension propose de copier le markdown dans le presse-papier.

## Utilisation

Test ponctuel :

```bash
pi -e ./pr-description
```

Installation projet avec auto-discovery :

```bash
mkdir -p .pi/extensions
cp -R pr-description .pi/extensions/
pi
```

Puis lancer :

```text
/gen-pr-desc
```
