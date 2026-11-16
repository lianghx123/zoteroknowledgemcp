# Zotero Knowledge MCP

Turn selected Zotero PDF attachments into a local, searchable knowledge library.
Read extracted text beside the PDF, correct it when needed, and give an AI client
explicit access through the Model Context Protocol (MCP).

**Current release: 0.2.0-preview.1.** Requires Zotero **10.0.x**. Native acceptance
has used Windows with Zotero 10.0.6–10.0.8; equivalent macOS and Linux acceptance
is pending. This is a preview with manual installation and upgrades.

[Download XPI](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 checksum](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[Release notes and all versions](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Current download: 0.2.0-preview.1 for Zotero 10.0.x. While the repository is private, sign in to GitHub with an account that has repository access. A public documentation site does not make private release assets public.

## Start here

1. [Install the plugin](installation.md) from the release XPI.
2. [Process your first document](quick-start.md) with a supported parsing service.
3. [Configure semantic search](configuration.md) if you want model-backed retrieval.
4. [Connect an AI client](mcp.md) if you want external tools to search and read it.

End users do not need Node.js, npm, Python or a separate background server.
Parser and model providers may require accounts, API credentials and paid quota.

## What you can do

| Task | Guide |
| --- | --- |
| Organize selected papers and synchronize Zotero collections | [Knowledge libraries](knowledge-libraries.md) |
| Find papers and passages with text or semantic search | [Search](search.md) |
| Read Markdown, follow citations and save text corrections | [Read and edit](reader.md) |
| Authorize local AI clients to use your knowledge libraries | [MCP connection](mcp.md) |
| Understand external requests, credentials and backups | [Data and privacy](privacy.md) |
| Diagnose configuration and processing problems | [Troubleshooting](troubleshooting.md) |

## Preview boundaries

Zotero remains responsible for your original library and attachments. The plugin
stores derived content locally and uses configured external services for parsing,
embeddings and optional reranking. Public remote MCP access, plugin cloud sync,
direct import of arbitrary parser output and integrated full backup/restore are
not available. A 1,000-paper full-workflow acceptance is still pending.

Plugin author: [lianghx123](https://github.com/lianghx123).
[Source and releases](https://github.com/lianghx123/zoteroknowledgemcp) may require
repository access until the project becomes public.
