---
name: structured-literature-development
description: Design or implement structured document content, parsing, embedding indexes, and literature retrieval for this Zotero plugin. Use when changing content models or processing/search behavior, rather than plugin lifecycle or MCP transport alone.
---

# Structured Literature Development

## Establish Scope and Contracts

Read `AGENTS.md`, the [implementation overview](../../../docs/development/implementation-overview.md), [delivery status](../../../docs/development/project-status.md), and the relevant implementation. Use the [development guide](../../../docs/development/getting-started.md) for setup; the root `README.md` introduces user workflows. Parsing, storage, indexing, retrieval and MCP bounded reads are implemented locally; inspect the affected code and verification evidence before extending their contracts.

For the requested feature, identify its inputs, outputs, content ownership, and failure behavior before introducing modules. Confirm unresolved choices that materially affect the design, such as parser location, storage runtime, or embedding provider. Do not silently introduce a backend, database, helper process, or external service.

Define only the contracts the feature needs. Useful identities include the Zotero library and item, the specific attachment, the processed content version, section nodes, and content blocks. A paper can have multiple attachments; attaching all derived content only to the parent item loses that distinction.

## Preserve Structure and Provenance

- Keep the original document and Zotero bibliographic metadata authoritative. Store plugin-owned derived content independently.
- Preserve section hierarchy, block reading order, and available page/source coordinates. Mark missing locations explicitly rather than fabricating them.
- Keep Markdown as a readable representation alongside structural identifiers needed for targeted reads and retrieval.
- Treat extracted content as untrusted input when rendering it in Zotero. Keep user annotations separate from generated text when reprocessing could overwrite content.
- Distinguish an unavailable attachment, extraction failure, partial content, pending embeddings, and indexing failure in relevant result or task contracts.

## Maintain Index Correctness

Use content fingerprints and parser/configuration versions to decide whether extraction must rerun. Metadata-only edits should not automatically repeat document parsing.

Record the embedding model/profile, dimensions, and preprocessing definition. Query embeddings must match the indexed vector space; equal dimensions alone do not establish compatibility. Prevent old processing results from replacing content for a changed or removed attachment.

Return search evidence with source identities and available locations. Distinguish metadata matches from text evidence and expose relevant partial-index or provider failures instead of silently presenting them as no results.

## Verify and Document

Use synthetic fixtures to verify the changed invariants: ordering, source mapping, bounded reads, attachment replacement, or embedding compatibility. Test the relevant failure behavior without requiring a live provider for routine tests.

Run the existing type checks and test suite for code changes. Document new configuration, data contracts, and implemented capabilities; leave unrelated architecture decisions open.
