# Traiter votre premier document

Commencez par une publication dont le PDF est déjà disponible localement dans Zotero. Le traitement envoie ce PDF au service d’analyse configuré ; vérifiez ses conditions avant d’utiliser un document confidentiel.

## 1. Configurer l’analyse

Ouvrez **Paramètres de Zotero → Knowledge MCP → Analyse des documents**. Choisissez **PaddleOCR (PaddleOCR VL-1.6)** ou **MinerU (VLM)**, saisissez les identifiants correspondants, activez l’analyse et enregistrez. Les adresses sont détaillées dans [Configurer les services](configuration.md).

## 2. Ajouter la publication

Dans une vue bibliographique native de Zotero, faites un clic droit sur la publication et choisissez **Ajouter à la base de connaissances**, puis la bibliothèque ou le dossier cible. Le module importe les métadonnées et met les PDF éligibles en file. Répéter l’ajout au même emplacement ne crée pas de ressource en double.

Un élément sans PDF peut conserver ses métadonnées, mais celles-ci seules ne produisent pas de texte extrait.

## 3. Suivre le traitement

Ouvrez **Tâches d’importation**. Le flux comprend :

1. Ajouter à la base de connaissances.
2. Extraire le contenu du document.
3. Préparer la recherche sémantique, si elle est activée.

L’extraction comprend préparation, téléversement, attente du fournisseur, analyse, téléchargement et enregistrement local. Le pourcentage de pages annoncé ne décrit que l’extraction. Consultez les erreurs et les commandes d’annulation ou de nouvelle tentative. Réessayer la phase vectorielle ne renvoie pas le PDF.

## 4. Lire le résultat

Ouvrez le PDF dans le lecteur natif Zotero et cliquez sur **M**. Si le lecteur était déjà ouvert avant la fin du traitement, fermez-le puis rouvrez-le. Utilisez le sommaire, la recherche et les aperçus de citations ; voir [Lecture et modification](reader.md).

## 5. Rechercher ou connecter un client

Le texte publié est interrogeable sans service d’embeddings. Pour la recherche sémantique, configurez et activez les modèles, puis attendez l’indexation. Utilisez la [recherche](search.md) ou [connectez un client IA local](mcp.md).
