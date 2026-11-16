# Project Delivery Status

Source preview version: **0.2.0-preview.1**. No installer is currently published. Application contract: **2.4.0**.
The package version, application contract, negotiated MCP protocol and database
migrations are independent version concepts. See the [development guide](getting-started.md)
for setup and the [implementation overview](implementation-overview.md) for behavior.

## Delivered Local Scope

| Area | Implemented behavior | Acceptance boundary |
| --- | --- | --- |
| Storage | Independent native SQLite, 16 migrations, 56 typed tables, transactions, ownership, upgrade snapshots and Trash | Complete external backup/restore tooling remains pending; see [database runtime](database-runtime.md). |
| Literature admission | Native items/attachments, multiple memberships, knowledge folders and one-way collection synchronization | Broader source and smart-collection workflows remain outside the accepted preview; see [membership](knowledge-membership-metadata.md) and [synchronization](collection-sync.md). |
| Parsing | PaddleOCR-VL-1.6 and MinerU `vlm`, persistent jobs, retry/cancel/restart recovery and immutable local publication | Direct import of user-generated parsing results is deferred; see [parsing](parsing.md). |
| Retrieval | Profile-bound embeddings, persistent USearch, full-text/vector/fusion search, reranking and scoped evidence | Index benchmarks do not establish 1,000-paper end-to-end acceptance or independent relevance quality; see [retrieval](vector-retrieval.md). |
| Reading/editing | Attachment-specific Markdown, formulas/tables/images, outline, citations, document search, block/type editing, insertion/deletion, undo/redo and transactional save | Unsaved drafts are lost when the reader closes or the plugin restarts; broader reorder/merge/split/review workflows remain pending; see [reader](markdown-reader.md). |
| Local MCP | 16 tools, library-scoped tokens, bounded/continued reading and version-checked annotation/summary writes | Loopback SSE-only Streamable HTTP, disabled initially; see [MCP](mcp.md) and [contract guarantees](mcp-implementation-audit.md#local-contract-240). |
| Localization/lifecycle | Seven complete locale catalogs, native settings, window-independent background work and cleanup | Native API/DOM checks do not establish manual acceptance of every localized screen; see [localization](localization.md) and [lifecycle](plugin-lifecycle.md). |

## Milestone Assessment

The local developer-preview workflow is implemented. Complete local acceptance
still requires broader source/editing coverage, external backup/restore tooling,
and a representative approximately 1,000-paper end-to-end evaluation. A connected
release additionally requires independently accepted HTTPS and account/relay
adapters. Cloud content synchronization is separate future scope.

No aggregate completion percentage is assigned. Implementation, native
correctness, performance and relevance acceptance are different gates. The
[development plan](migration-plan.md) lists the remaining work.

## Verification Scope

Automated checks use Node.js 22.23.1 on Windows and include production packaging,
types, database consistency, localization and Node/VM/JSDOM regressions. The
2026-11-12 validation passed 1,212 tests with no failures, skips or cancellations;
database checks covered 16 migrations and 56 typed tables. This dated result
does not replace checks for a later candidate.

Native development verification has used Windows with Zotero 10.0.6–10.0.8.
It covers storage, reader/edit-save behavior, startup/recovery, scoped HTTP/SSE
and real-client MCP interoperability. These are developer-driven runtime checks,
separate from exhaustive manual UI, provider-quality or cross-platform acceptance.
Detailed raw logs and fixture records are private development artifacts.

The native inline-evidence stress check
`viewport-covered-after-offscreen-collapse` has a known failure in the compared
packages. It remains an open UI acceptance issue; backend retrieval measurements
do not establish a fix. See [retrieval verification limits](retrieval-performance.md#verification-and-limits).

### Markdown Parser Validation

The current dependency is `markdown-it 14.3.3`. The 2026-11-12 verification
included malformed HTML/reference regression inputs, production packaging and
eleven isolated Zotero 10.0.8 renderer checks. The official production dependency
audit reported zero known vulnerabilities at that time; development-tool
advisories remain a separate review. See [parser security](markdown-reader.md#markdown-parser-security)
and [release checks](releases.md#prepare-and-validate).

Any future installer must identify its exact source snapshot. Each release
requires its own exact-package validation and checksum; see [release procedure](releases.md).

## Remaining Acceptance Priorities

1. Evaluate approximately 1,000 representative multilingual papers with independent relevance judgments and agreed latency, memory, recall and responsiveness budgets.
2. Provide external backup/restore tooling and recovery drills covering SQLite, artifacts, indexes and compatible schema/plugin selection.
3. Complete the remaining source, management and editing workflows; keep direct parse-result import explicitly deferred.
4. Complete long-running, cross-platform, OS-level crash and remaining manual UI acceptance.
5. Implement and accept HTTPS and account/relay connectivity separately before advertising remote access.
