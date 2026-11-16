# integrations

Native/runtime and provider adapters; external contracts still require verification.

`zotero/knowledge-items.ts` projects bibliographic metadata and attachment identities. `zotero/parsing-port.ts` separately resolves eligible local PDF bytes through native attachment APIs, hashes data and stores plugin-owned artifacts. Complete PaddleOCR and MinerU workflows live in the peer `src/parsers/paddleocr/` and `src/parsers/mineru/` directories; `src/parsers/transport.ts` supplies their shared Gecko HTTP boundary. `zotero/model-credentials.ts` stores model credentials through Gecko Login Manager; `src/providers/models.ts` defines embedding/rerank adapters with a Bailian implementation, called through `src/services/model-gateway.ts`. Account/relay adapters remain planned.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
