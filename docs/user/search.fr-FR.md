# Rechercher des publications et des passages

Choisissez un périmètre de connaissances et un mode **Base de connaissances** dans le menu de recherche Zotero. Saisissez une requête non vide et appuyez sur **Entrée**. Changer seulement le mode conserve la liste ; Entrée sur une requête vide enlève le filtre sans appeler de modèle.

| Mode | Source | Prérequis |
| --- | --- | --- |
| Texte | Texte et métadonnées locaux | Texte publié pour les passages |
| Sémantique | Recherche vectorielle par le sens | Embeddings activés et contenu indexé compatible |
| Sémantique améliorée | Recherche sémantique puis reclassement | Embeddings/reclassement configurés et index compatible |
| Fusion | Combinaison texte et sémantique | Canaux disponibles ; l’état sémantique influe sur les résultats |

Dépliez un résultat avec la flèche native pour examiner passages, champs et liens sources. Un bref avis de pertinence précède les résultats moins bien notés, qui restent consultables. Les scores servent au classement, sans garantir les faits ni remplacer la lecture des sources.

**Ma base de connaissances** interroge les bibliothèques actives. Une bibliothèque ou un dossier réduit le périmètre. La corbeille possède son propre périmètre de récupération.

## Rechercher dans le PDF ouvert

Le panneau Markdown possède une recherche documentaire indépendante : texte, sémantique, sémantique améliorée et fusion, appliqués au contenu actuel de cette pièce jointe. Un résultat conduit au bloc source ; fermer la recherche rétablit le sommaire.

La recherche textuelle peut fonctionner avant l’index sémantique. Si les résultats sémantiques manquent, vérifiez les tâches d’importation, les modèles et la récupération. Consultez le [dépannage](troubleshooting.md) avant de retraiter le PDF.
