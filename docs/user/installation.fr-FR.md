# Installation et mise à niveau

[Notes et toutes les versions](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Aucun installateur précompilé n’est actuellement publié. Les instructions ci-dessous s’appliquent lorsqu’un fichier XPI et sa somme de contrôle sont disponibles sur la page des versions. Les contributeurs peuvent compiler le code selon le guide de développement.

## Prérequis

- Zotero **10.0.x**. Windows a fait l’objet de vérifications natives ; une validation équivalente sous macOS et Linux reste à effectuer.
- Un PDF disponible localement pour traiter son contenu.
- Un service d’analyse compatible avec ses identifiants ; la recherche sémantique nécessite aussi un service d’embeddings compatible.

## Installer

1. Ouvrez la [préversion](https://github.com/lianghx123/zoteroknowledgemcp/releases). Tant que le dépôt est privé, connectez-vous avec un compte autorisé.
2. Téléchargez **zotero-knowledge-mcp.xpi**. Les archives ZIP et tar du code source ne sont pas des modules installables.
3. Dans Zotero, ouvrez **Outils → Modules complémentaires**, puis le menu engrenage et **Installer un module depuis un fichier…**. Sélectionnez le XPI.
4. Redémarrez si Zotero le demande, puis ouvrez **Paramètres de Zotero → Knowledge MCP**.
5. Suivez le guide du [premier document](quick-start.md). L’analyse, les modèles et MCP local sont désactivés par défaut.

## Vérifier le téléchargement

Téléchargez `SHA256SUMS` depuis la même version et comparez son empreinte XPI à la sortie suivante :

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

Sous macOS : `shasum -a 256 zotero-knowledge-mcp.xpi` ; sous Linux : `sha256sum zotero-knowledge-mcp.xpi`.

## Mettre à niveau sans perdre de données

1. Fermez Zotero et sauvegardez son répertoire de données complet, dont `knowledgemcp/`, dans un emplacement externe.
2. Lisez les notes de la version cible, puis installez son XPI comme ci-dessus.
3. Conservez la sauvegarde jusqu’à vérification des bibliothèques et documents traités.

Les mises à niveau de la préversion du dépôt privé restent manuelles. Le canal automatique est prêt, mais ne proposera que des versions stables vérifiées lorsque le dépôt et les fichiers seront accessibles publiquement. Les préversions s’installent toujours manuellement. Le réglage de mise à jour de Zotero contrôle l’installation des versions stables proposées. Sans version stable publiée, le flux reste vide. Installer un ancien XPI ne rétrograde pas la base. Une ancienne version peut refuser un schéma plus récent : la restauration exige une sauvegarde externe compatible.

La désactivation et la désinstallation conservent les données. Consultez [Données et confidentialité](privacy.md) avant de réinitialiser ou changer le répertoire de données Zotero.
