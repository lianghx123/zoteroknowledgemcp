# Install and upgrade

[Release notes and all versions](https://github.com/lianghx123/zoteroknowledgemcp/releases)

No prebuilt installer is currently published. The instructions below apply when an XPI and its checksum become available on the release page. Contributors can build the source using the development guide.

## Requirements

- Zotero **10.0.x**. Windows has received native development verification;
  equivalent macOS and Linux acceptance remains pending.
- A local PDF attachment for document processing.
- A supported parsing service and its credentials for extracting PDF content.
  Semantic search additionally needs a supported embedding service.

## Install

1. Open the [preview release](https://github.com/lianghx123/zoteroknowledgemcp/releases).
   While the repository is private, sign in with an account that has access.
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

Current private-repository preview upgrades are manual. The prepared automatic
channel accepts only verified stable releases after the repository and its
installers become publicly accessible. Previews are always installed manually.
Zotero's own automatic-update setting controls installation of offered stable
updates. With no published stable release, the feed remains empty.
Installing an older XPI does not downgrade the plugin's
database. An older version may reject a newer schema; recovery requires a
compatible external backup, not just the old installer.

Disabling or uninstalling the plugin preserves its stored data. See
[data and privacy](privacy.md) before resetting or switching Zotero data directories.
