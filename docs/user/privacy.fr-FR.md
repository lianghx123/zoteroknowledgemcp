# Données et confidentialité

Cette page décrit la préversion actuelle. Les fournisseurs et clients IA choisis ont leurs propres conditions, règles de conservation et coûts.

## Données locales

Le module stocke base de connaissances, état des traitements, texte extrait, artefacts et index vectoriels dans `knowledgemcp/`, sous le répertoire de données Zotero. Le schéma SQLite est distinct de celui de Zotero. Les pièces jointes originales restent gérées par Zotero.

La configuration d’analyse conserve actuellement une clé API réutilisable en clair dans `parsing.json`. Protégez répertoire et sauvegardes. Les clés d’embeddings/reclassement utilisent le gestionnaire d’identifiants Gecko ; les paramètres n’en gardent que des références. Les jetons MCP sont stockés sous forme d’empreintes, sans secret récupérable.

## Transferts externes

| Action | Données envoyées au service configuré |
| --- | --- |
| Analyse PDF | Fichier PDF sélectionné |
| Embeddings | Segments de texte extrait sélectionnés |
| Requête sémantique | Texte de la requête à vectoriser |
| Reclassement facultatif | Requête et passages candidats |
| Accès MCP autorisé | Contenus demandés retournés au client |

Recherche textuelle locale et réparation d’index ne nécessitent pas d’embeddings. Le module n’a pas de service propre de synchronisation cloud ou de compte distant. Les clients externes peuvent effectuer d’autres échanges réseau ou avec des modèles.

## Sauvegarder et retirer

Fermez Zotero avant de sauvegarder extérieurement le répertoire complet, dont `knowledgemcp/`. Les instantanés de mise à niveau de base n’incluent pas tous les artefacts et index et ne constituent pas une sauvegarde complète.

Désactivation et désinstallation conservent les données. Réinitialiser le répertoire Zotero ou changer de compte peut supprimer ce répertoire, y compris données du module et instantanés. Gardez les sauvegardes ailleurs. La restauration complète intégrée et la rétrogradation du schéma ne sont pas disponibles.

## Signaler sans divulguer

Avant de partager des journaux, vérifiez texte PDF, titres, chemins locaux, URL et identifiants. Ne joignez ni répertoire Zotero, ni base de connaissances, ni jeton ou clé à un ticket public. Voir [Assistance](support.md).
