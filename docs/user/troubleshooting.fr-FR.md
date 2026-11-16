# Dépannage

## Version ou téléchargement inaccessible

Le XPI publié et `SHA256SUMS` sont téléchargeables publiquement sans connexion. Téléchargez le XPI, pas une archive du code source. En cas d’échec d’installation, vérifiez la version de Zotero et `SHA256SUMS`.

## Aucune tâche ou PDF manquant

Vérifiez que l’analyse est activée et enregistrée, et que le PDF est disponible localement. Le module ne télécharge pas les fichiers absents. Pour un élément déjà ajouté, utilisez **Analyser les pièces jointes**. Les éléments non PDF peuvent conserver seulement les métadonnées.

## Tâche en attente ou en échec

Examinez la phase d’extraction et les détails. L’attente chez le fournisseur diffère du travail local ; une progression inconnue n’indique pas la fin. Vérifiez fournisseur, adresse, identifiants, quota, réseau et limites. Réessayez la phase échouée au lieu de répéter l’ajout.

Une tâche acceptée conserve l’identité du service initial. Après changement de service, gardez sa configuration adresse/clé compatible pour la reprendre. Désactiver l’analyse n’annule pas une requête en cours.

## Texte disponible, recherche sémantique absente

Vérifiez activation, enregistrement et application des modèles ainsi que le test d’embeddings. Examinez la phase sémantique des tâches d’importation et les avis de récupération. Modèle et dimensions doivent correspondre à l’espace vectoriel.

**Vectoriser les documents existants** crée les embeddings manquants et peut consommer du quota. **Réparer l’index de recherche** reconstruit à partir des vecteurs existants sans nouveaux embeddings.

## Markdown vide ou ancien

Attendez la publication, fermez et rouvrez le bon PDF, puis cliquez sur **M**. Les contenus existants n’adoptent pas silencieusement de nouvelles règles d’analyse : un retraitement explicite est nécessaire. Conservez les modifications non enregistrées avant toute fermeture ou reprise.

## Enregistrement des paramètres refusé

Lisez les messages de validation. Une autre fenêtre ou un éditeur externe peut avoir modifié la configuration. Conservez les saisies, rechargez le formulaire puis réessayez. Un test de connexion réussi n’enregistre pas les paramètres.

## Échec de connexion MCP

- Vérifiez l’état de fonctionnement et l’adresse réelle.
- Gardez Zotero ouvert et l’ordinateur éveillé.
- Client et Zotero doivent partager l’ordinateur ; le client doit accepter Streamable HTTP authentifié.
- Vérifiez jeton Bearer, expiration, bibliothèques et droits.
- Si le port est occupé, appliquez un port local libre et mettez le client à jour.

## Défilement PDF lent pendant l’automatisation

Les clients Windows UI Automation peuvent activer l’accessibilité Zotero et perturber le défilement. Cela a été observé avec l’assistant computer-use de Codex en tests isolés. Fermez la session et l’assistant appartenant à cette tâche, redémarrez Zotero isolé puis comparez. Ce phénomène ne prouve pas un défaut commun à toutes les installations.

Si le problème persiste, suivez [Assistance](support.md) avec un exemple minimal et des informations expurgées.
