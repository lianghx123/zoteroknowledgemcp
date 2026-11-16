# parsers

PaddleOCR and MinerU are peer `DocumentParser` implementations. Each parser owns every provider-specific step: submission, upload, remote status, result download, container validation, normalization, image handling and a final `ParsedDocument`. The queue never interprets a provider response or selects a normalizer by a provider-specific branch.

| Module | Responsibility |
| --- | --- |
| `contracts.ts` | Parser context, bounded staging capability, durable submission/checkpoint callbacks and the normalized result contract |
| `catalog.ts`, `definition.ts` | Defaults, model restrictions, option validation, localization keys, adapter identity and current normalizer version |
| `registry.ts` | Match the submitted identity to a parser and reject unsupported providers/normalizers |
| `paddleocr/` | Multipart jobs, JSONL/envelope decoding, current/legacy transforms and page-scoped artifact handling |
| `mineru/` | Signed upload allocation/PUT, batch polling, bounded ZIP decoding, typed content normalization and local assets |
| `transport.ts`, `assets.ts`, `content.ts`, `content-quality.ts` | Shared Gecko transport, image signatures and text/quality utilities |
| `running-margins.ts` | Conservative page-edge repetition detection shared by both current parsers before paragraph merging/section creation |
| `image-references.ts` | Exact Markdown/HTML image source rewriting without changing prose, alt text or URL substrings |
| `heading-numbering.ts`, `heading-hierarchy.ts`, `apply-heading-hierarchy.ts` | Matching-only prefix normalization, per-document/per-explicit-scope numbering grammar inference and conservative canonical heading/parent decisions shared by current parsers |

`process(context)` yields `undefined` when another queue turn is required, or returns `{ document, producerVersion?, resultSchema? }` after all content and local assets are ready. The context supplies an attachment snapshot, immutable parser identity, live credentials, limits, cancellation, hashes, generated artifact staging, progress and durable checkpoint operations. `submit()` reserves remote capacity and persists intent before invoking a provider. It accepts at most one submission per claim, retries only local acknowledgement, and fences uncertain outcomes. Providers use private JSON checkpoints without teaching the queue their protocol.

Every parser converges on the shared publication transaction: attachment/generation identity, physical pages, ordered typed blocks, source geometry, section hierarchy, quality/review metadata and local assets. `sectionHierarchy` requests either general heading ancestry or the legacy two-level behavior; the repository has no provider-specific dispatch. Publication checks the attachment again and protects newer content, edits, cancellation and missing membership.

`document.normalizerVersion` is required and identifies the algorithm that produced the output. The worker validates it against that parser's supported versions; publication stores it on the content generation. It may differ from the immutable accepted task/profile/run normalizer when an older remote result is processed by a corrected transformer. Do not overwrite the accepted identity to record an output-version change. Legacy PaddleOCR v1 still uses its original transformer. Other accepted older versions use the current transformer and explicitly record its current output version.

Current parser normalizers project their own page/block formats and actual page dimensions into `detectRunningMargins` before deriving canonical content. Independent short headers in the top 15%, footers in the bottom 10%, and narrow left/right margin candidates require stable daily/alternating repetition. Global coverage is 60% with at least three occurrences and two adjacent cadence steps. Five uninterrupted occurrences also establish a localized running margin and identify disconnected same-text candidates on the same edge/cadence/parity when their geometry agrees. Only anchored download/dated-copyright notice families tolerate changed trailing text, and only inside a narrow side margin; substantive `aside_text` is retained. Removed derived text never changes raw provider pages, source IDs or coordinates. Suppression produces page/block/cadence warnings. The queue does not interpret those provider page formats or repeat the cleanup after paragraph merging. See [the cleanup rules and corpus verification](../../docs/development/parsing.md#repeated-running-margins).

Current PaddleOCR transformation/provider object guards share `content.ts` with MinerU; the transformer re-exports the guard for existing callers. Legacy PaddleOCR v1 normalization remains frozen in its own transformer.

To add another parser:

1. Create a peer directory with a definition, complete `DocumentParser` implementation and provider-specific transformation/transport as needed. Use Gecko-compatible code, bounded reads, explicit source positions and managed local assets.
2. Register its definition in `catalog.ts` and implementation in `registry.ts`. Add its Fluent label/help to every supported locale. Settings, profile validation and parser identity use that definition automatically.
3. Keep credentials out of task identities and artifacts. Resolve accepted work against its original profile/endpoint; never silently redirect it to the active provider or repeat uncertain paid submissions.
4. Add synthetic protocol/normalization/failure fixtures and verify structured publication. `test/parser-registry.test.mjs` demonstrates a third parser completing the same pipeline without worker or repository changes. Perform isolated native verification before claiming runtime support.

Retrying a confirmed result that failed download or publication resumes its existing remote identity when the attachment/source/content versions still match. Source changes or newer generations reject that recovery. Remote parser failures, cancelled jobs and deliberate reparses retain their separate admission semantics.

`transport.ts` obtains HTTP primitives from the process-lived Gecko runtime; model
requests through the shared transport remain usable without a main window.
