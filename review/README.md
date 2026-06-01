# review

Extension pi qui ajoute la commande :

```text
/review
```

Elle lance une code review de la branche actuelle en analysant :

- les commits de la branche courante par rapport à une branche de base détectée (`origin/HEAD`, `origin/main`, `origin/master`, `main`, puis `master`) ;
- les changements staged ;
- les changements non staged.

La review recherche notamment :

- bugs et problèmes de correctness ;
- régressions ou changements de comportement ;
- problèmes de performance ;
- risques sécurité / perte de données ;
- maintenabilité, couverture de tests et autres remarques pertinentes.

Les trouvailles sont demandées triées par criticité (`Critical`, `High`, `Medium`, `Low`, `Nit`) avec une recommandation de fix si possible.

Une fois la review générée, l'extension parcourt les trouvailles une par une :

1. choix `yes` / `no` pour générer un correctif ciblé ;
2. si `yes`, l'assistant génère/applique un fix pour ce problème uniquement ;
3. après le fix, choix `ok` ou `prompt pour itérer` ;
4. quand tu choisis `ok`, l'extension passe à la trouvaille suivante.

Tu gardes donc la décision au cas par cas.

## Utilisation

Test ponctuel :

```bash
pi -e ./review
```

Installation projet avec auto-discovery :

```bash
mkdir -p .pi/extensions
cp -R review .pi/extensions/
pi
```

Puis lancer :

```text
/review
```
