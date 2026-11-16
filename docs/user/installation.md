# Install and upgrade

[Download XPI](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 checksum](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[Release notes and all versions](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Current download: 0.2.0-preview.1 for Zotero 10.0.x. The source, release XPI and checksum are public; no GitHub account is needed to download them.

## Requirements

- Zotero **10.0.x**. Windows has received native development verification;
  equivalent macOS and Linux acceptance remains pending.
- A local PDF attachment for document processing.
- A supported parsing service and its credentials for extracting PDF content.
  Semantic search additionally needs a supported embedding service.

## Install

1. Open the [preview release](https://github.com/lianghx123/zoteroknowledgemcp/releases/tag/v0.2.0-preview.1).
2. Download **zotero-knowledge-mcp.xpi**. GitHub's source ZIP and tar archives
   are not installable plugins.
3. In Zotero, open **Tools → Plugins**, open the gear menu and choose
   **Install Plugin From File…**. Select the XPI.
4. Restart if Zotero requests it. Open **Zotero Settings → Knowledge MCP**.
5. Continue with [your first document](quick-start.md). Parsing, model services
   and local MCP start disabled on a new installation.

## Check the download

Download `SHA256SUMS` from the same release. Compare its XPI hash with the output:

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

On macOS, use `shasum -a 256 zotero-knowledge-mcp.xpi`; on Linux, use
`sha256sum zotero-knowledge-mcp.xpi`.

## Upgrade safely

1. Close Zotero and make an external backup of its complete data directory,
   including the `knowledgemcp/` subdirectory.
2. Read the target release's notes, then install its XPI using the same steps.
3. Keep the backup until you have checked your libraries and processed documents.

Preview upgrades are manual. The automatic channel accepts only verified stable releases; previews are always installed manually. Zotero's own automatic-update setting controls installation of offered stable updates. With no published stable release, the feed remains empty. Installing an older XPI does not downgrade the plugin's database. An older version may reject a newer schema; recovery requires a compatible external backup, not just the old installer.

Disabling or uninstalling the plugin preserves its stored data. See
[data and privacy](privacy.md) before resetting or switching Zotero data directories.
