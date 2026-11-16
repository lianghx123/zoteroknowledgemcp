# Data and privacy

This page describes the current preview's data behavior. Your selected service
providers and AI clients have their own terms, retention rules and costs.

## What stays local

The plugin stores its knowledge database, processing state, extracted content,
artifacts and vector indexes under `knowledgemcp/` in Zotero's data directory.
Its SQLite schema is separate from Zotero's native database. The original
attachments remain managed by Zotero.

Parser configuration currently stores a reusable API key in the local
`parsing.json` file as plaintext. Protect the data directory and its backups.
Embedding/reranking keys use Gecko Login Manager; their settings store credential
references. MCP token records store hashes rather than recoverable token secrets.

## When data leaves the computer

| Action | Data sent to the configured service |
| --- | --- |
| PDF parsing | Selected PDF bytes |
| Embedding content | Selected extracted text segments |
| Semantic query | Query text for embedding |
| Optional reranking | Query and candidate passages |
| Authorized MCP use | Requested knowledge content is returned to the client |

Local text search and index repair do not require embedding requests. The plugin
does not provide plugin-owned cloud synchronization or a remote account service.
External clients can have additional model/network behavior beyond the plugin.

## Back up and remove data

Close Zotero before making an external backup of the complete data directory,
including `knowledgemcp/`. Database upgrade snapshots do not include all document
artifacts and indexes and are not a complete backup.

Disabling or uninstalling the plugin preserves its data. Zotero data-directory
reset/account-switch operations can remove that directory, including plugin
storage and its local snapshots. Keep backups outside that directory. The
plugin does not yet offer integrated complete backup/restore or schema downgrade.

## Share diagnostic information safely

Before sharing logs, review them for PDF content, titles, local paths, service
URLs and credentials. Do not attach a Zotero data directory, knowledge database,
tokens or provider keys to a public issue. See [support](support.md).
