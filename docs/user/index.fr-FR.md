# Zotero Knowledge MCP

Transformez des pièces jointes PDF sélectionnées dans Zotero en une bibliothèque de connaissances consultable localement. Lisez et corrigez le texte extrait à côté du PDF, puis autorisez explicitement un client IA à y accéder via le Model Context Protocol (MCP).

**Version actuelle : 0.2.0-preview.1.** Nécessite Zotero **10.0.x**. Les vérifications natives ont utilisé Windows et Zotero 10.0.6–10.0.8 ; une validation équivalente sous macOS et Linux reste à effectuer. Cette préversion s’installe et se met à niveau manuellement.

[Télécharger le XPI](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[Empreinte SHA-256](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[Notes et toutes les versions](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Téléchargement actuel : 0.2.0-preview.1 pour Zotero 10.0.x. Tant que le dépôt est privé, connectez-vous à GitHub avec un compte autorisé. Le site public de documentation ne rend pas publics les fichiers privés des versions.

## Commencer

1. [Installez le module](installation.md) depuis le fichier XPI publié.
2. [Traitez votre premier document](quick-start.md) avec un service d’analyse pris en charge.
3. [Configurez la recherche sémantique](configuration.md) pour les recherches utilisant un modèle.
4. [Connectez un client IA](mcp.md) pour rechercher et lire depuis des outils externes.

Les utilisateurs n’ont besoin ni de Node.js, npm ou Python, ni d’un serveur séparé. Les services d’analyse et de modèles peuvent nécessiter un compte, des identifiants API et un quota payant.

## Fonctions disponibles

| Tâche | Guide |
| --- | --- |
| Organiser les publications et synchroniser des collections Zotero | [Bibliothèques de connaissances](knowledge-libraries.md) |
| Rechercher des publications et passages par texte ou sémantique | [Recherche](search.md) |
| Lire le Markdown, consulter les citations et enregistrer des corrections | [Lecture et modification](reader.md) |
| Autoriser des clients IA locaux à accéder aux bibliothèques | [Connexion MCP](mcp.md) |
| Comprendre les requêtes externes, identifiants et sauvegardes | [Données et confidentialité](privacy.md) |
| Résoudre les problèmes de configuration et de traitement | [Dépannage](troubleshooting.md) |

## Limites de la préversion

Zotero conserve la gestion de la bibliothèque et des pièces jointes originales. Le module stocke les contenus dérivés localement et utilise les services configurés pour l’analyse, les embeddings et le reclassement facultatif. L’accès MCP distant public, la synchronisation cloud du module, l’import direct de résultats d’analyse arbitraires et la sauvegarde/restauration complète intégrée ne sont pas disponibles. La validation du flux complet sur environ 1 000 publications reste à effectuer.

Auteur : [lianghx123](https://github.com/lianghx123). L’accès au [code et aux versions](https://github.com/lianghx123/zoteroknowledgemcp) peut nécessiter une autorisation tant que le dépôt est privé.
