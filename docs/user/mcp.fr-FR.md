# Connecter un client IA

MCP permet aux clients autorisés de découvrir des publications, rechercher des passages, lire du contenu structuré et effectuer des écritures d’annotations ou de résumés explicitement permises. Le module fournit 16 outils via Streamable HTTP authentifié avec uniquement des réponses SSE, sans ancien point d’accès HTTP+SSE séparé.

## Activer l’accès

1. Ouvrez **Paramètres de Zotero → Knowledge MCP → Connexion MCP**.
2. Activez MCP local et appliquez. Adresse par défaut : `http://127.0.0.1:23126/mcp/knowledge` ; utilisez celle de vos paramètres.
3. Créez un jeton nommé, sélectionnez explicitement les bibliothèques et accordez les droits requis. Recherche/lecture et écritures d’annotations/résumés sont distinctes.
4. Copiez immédiatement le secret. Il ne s’affiche qu’une fois et ne peut pas être récupéré.
5. Configurez le serveur MCP distant/HTTP du client avec l’adresse et le jeton Bearer. Gardez Zotero ouvert et l’ordinateur éveillé.

Durées : 30, 90, 180 ou 365 jours. Modifier nom, bibliothèques ou droits conserve le secret et l’expiration. Révoquez les jetons inutiles ; la révocation concerne les requêtes suivantes, même sur une connexion existante.

## Exemple Codex

Définissez `ZOTERO_KNOWLEDGE_MCP_TOKEN` dans l’environnement de lancement du client, puis exécutez :

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

Les paramètres fournissent l’adresse et la commande à copier. Adaptez l’URL si le port change. Suivez la documentation du client pour les variables d’environnement ; ne publiez jamais le jeton dans une capture, un dépôt ou un rapport.

## Limites de connexion

Le serveur accepte seulement la boucle locale sur le même ordinateur, lorsque Zotero fonctionne. HTTPS public, accès distant par compte et relais/cloud ne sont pas disponibles. Un client cloud ne peut pas joindre directement votre boucle locale. Un client autorisé peut recevoir les données permises et les transmettre à son propre modèle.

Les schémas et la compatibilité sont détaillés dans la [référence MCP développeur](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md).
