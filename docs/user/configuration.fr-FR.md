# Configurer les services

Ouvrez **Paramètres de Zotero → Knowledge MCP**. Les onglets **Analyse des documents**, **Modèles et recherche** et **Connexion MCP** possèdent leurs propres actions d’enregistrement ou d’application. Changer d’onglet conserve les saisies non enregistrées.

## Analyse des documents

| Service | Adresse | Modèle |
| --- | --- | --- |
| PaddleOCR | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` | `PaddleOCR-VL-1.6` |
| MinerU | `https://mineru.net/api/v4` | `vlm` |

Choisissez un service, saisissez sa clé API ou son jeton, activez l’analyse et enregistrez. Chaque service conserve ses identifiants et options lors d’un changement. Le modèle est fixé par ce choix ; une API OCR quelconque n’est pas automatiquement compatible.

Les adresses externes doivent utiliser HTTPS ; HTTP est limité à la boucle locale. Les URL ne doivent contenir ni mot de passe, ni paramètres de requête, ni fragment. Une tâche acceptée conserve son service et son adresse d’origine ; changer le service courant ne la redirige pas.

La file contrôle les créneaux d’exécution locaux, les tâches distantes suivies, l’interrogation, les délais et les limites des fichiers/résultats. Commencez par les valeurs par défaut. Les temps sont en secondes et les tailles en MB (1 MB = 1 048 576 octets).

## Modèles et recherche

Le fournisseur livré est **Bailian**. Les modèles par défaut sont `qwen3.7-text-embedding` et `qwen3.7-text-rerank`, avec 768 dimensions. Vérifiez que votre compte accepte le modèle, la région, l’adresse et les dimensions choisis.

1. Saisissez l’adresse d’embeddings, le modèle et la clé compatibles.
2. Configurez éventuellement le reclassement. Il peut envoyer les passages au fournisseur ; sa clé peut être distincte ou partagée avec les embeddings.
3. Testez chaque connexion. Les tests utilisent les valeurs saisies sans les enregistrer.
4. Activez les services, choisissez **Enregistrer et appliquer**, puis vérifiez l’état appliqué.
5. Utilisez **Vectoriser les documents existants** pour créer les embeddings manquants si nécessaire.

Laisser vide le champ d’une clé enregistrée la conserve. Connexion réussie, configuration enregistrée et état appliqué sont distincts.

Changer de modèle d’embeddings, d’adresse ou de dimensions change l’espace vectoriel. À l’invite, conservez les anciens vecteurs, effacez-les ou annulez. Les espaces incompatibles ne sont pas mélangés.

**Réparer l’index de recherche** reconstruit localement l’index à partir des vecteurs stockés sans nouvel embedding. **Vectoriser les documents existants** peut appeler le fournisseur et consommer du quota. Voir [Dépannage](troubleshooting.md).

## Connexion MCP

MCP local est facultatif et désactivé par défaut. Activez-le pour un client local, appliquez le port et créez un jeton avec bibliothèques et droits explicites. Suivez le [guide MCP](mcp.md).
