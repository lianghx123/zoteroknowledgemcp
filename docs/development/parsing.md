# PDF Attachment Parsing

The plugin implements native Zotero PDF upload, durable asynchronous parsing, structured local publication and reader access with **PaddleOCR** and **MinerU**. The default engine remains **PaddleOCR-VL-1.6**. Published generations feed [profile-bound embedding ingestion and persistent vector indexing](vector-retrieval.md), with parse, embedding and local-index stages combined in Import Tasks. Explicit [continuous collection bindings](collection-sync.md) can also admit PDFs. Direct parse-result import remains deferred.

## User-facing progress telemetry

Import Tasks separates extraction phases from durable scheduler/job states. The
existing `processing_jobs.checkpoint_json` records `extractionPhase`,
`phaseStartedAt` and `progressUpdatedAt`. Phases cover local capacity waiting,
preparation, upload, remote queue/preparation, page parsing, result download,
content organization and publication. Parser `reportPhase` callbacks are optional
for consumers without a task UI; the shared worker persists and publishes them.
Provider progress retains optional aggregate completed/total page counts. MinerU
conversion/file-preparation states are distinguished from its pending queue;
PaddleOCR pending/running states retain their service meanings.

These fields supplement the protocol checkpoint (`submit`, `poll`, `download`,
`publish`) without changing resubmission, lease, cancellation or transactional
publication rules. A signed upload allocation is not a completed file upload.
The page count at publication is an extraction result, not database save progress.
Older checkpoints project conservatively from existing run/protocol fields;
unknown remote durations and totals remain unknown. No schema migration is needed.

## Configure and Use

Startup creates `<Zotero data directory>/knowledgemcp/parsing.json` if absent, with parsing disabled and an empty key. Configure everything in **Zotero Settings → Knowledge MCP**, also opened by the task toolbar's settings icon. One parser selector chooses an independent endpoint/key/options configuration; its fixed model is included in the selector label: `MinerU (VLM)` or `PaddleOCR (PaddleOCR VL-1.6)`. There is no separate model field. Queue and limits have their own shared section. There are no profile-selection or add/remove-profile controls. The form masks the key and validates an atomic save; concurrent external file changes require reloading before saving. Existing file configuration and hot reload remain supported. [The configuration fixture](../../test/fixtures/parsing.example.json) documents the default configuration and is checked against the runtime defaults by the parsing tests; its credential fields are empty. The plugin creates its live configuration in the Zotero data directory rather than reading this test fixture.

1. Select PaddleOCR or MinerU. For PaddleOCR, set the full jobs endpoint (default `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`) and API key; its only model is `PaddleOCR-VL-1.6`. For MinerU, retain the standard API base `https://mineru.net/api/v4` and enter the MinerU token; its only model is `vlm`. Switching parsers retains both configurations and shared queue limits. Old configurations gain missing parsers with empty keys in the form.
2. Enable parsing and save in the settings pane. Configuration is checked every two seconds without restarting Zotero. HTTPS is required except for loopback development endpoints. Embedded URL credentials, query strings and fragments are rejected.
3. Add items or a collection to a knowledge location. Metadata admission is followed by parsing admission for each PDF attachment. An item with multiple PDFs produces distinct attachment jobs. Non-PDF items retain metadata without a fabricated parse task.
4. For existing knowledge items, use **Parse attachments** in the item menu or knowledge detail section. A missing local PDF is reported; download or restore it in Zotero before trying again. Manual parsing with no eligible PDF reports that condition explicitly.
5. Open **Import Tasks** to inspect real progress, cancel, retry or parse again. Folder imports group child jobs; groups and progress reconstruct from persisted job payloads after restart. Completed unchanged input is reused unless **Parse again** is selected.
6. Open the native PDF reader and click **M**, or close and reopen it if already open. Published Markdown is read from the knowledge database and managed local images from the artifact directory. The native PDF and its annotations remain intact.

An admission or preparation failure preserves metadata already admitted. Missing/oversized/unreadable files fail preparation visibly rather than inventing a successful task. There is no automatic attachment download. One-time collection import takes direct items; explicit continuous bindings mirror descendants through the separate synchronization service.

## Configuration Semantics

The settings form displays polling and timeout values in seconds (up to three
decimal places) and size limits in MB (1 MB = 1,048,576 bytes). Fractional sizes
are rounded to the nearest byte on save. Existing configuration files keep their
integer millisecond and byte fields; unchanged values round-trip without loss.

| Setting | Meaning |
| --- | --- |
| `version` | Configuration schema version; currently `1`. |
| `enabled` | Allows new execution stages to start. Disabling does not abort an already running request. |
| `activeProfile`, `profiles` | Compatibility storage for parser configurations with `provider`, `api`, `model`, `key` and camelCase `options`. Missing `provider` means PaddleOCR. Models are fixed: `PaddleOCR-VL-1.6` and `vlm`. These names are no longer exposed as a second UI selector. |
| `parserProfiles` | Optional mapping of parser IDs to configuration names. Reading older files derives it from the existing configurations and active selection. The UI preserves original names/keys for accepted task credential lookup. |
| `concurrency` | Local asynchronous execution slots, 1–8; default 2. |
| `remoteConcurrency` | Live tracked submissions, 1–32; default 2. Remote waits release local slots. |
| `pollIntervalMs` | Remote polling interval, 500–60000 ms; default 5000. |
| `requestTimeoutMs` | Per-request timeout, including body reading, 1000–600000 ms; default 60000. |
| `jobTimeoutMs` | Remote waiting deadline, 1000–86400000 ms; default one hour. Explicit retry extends tracking of the same remote job. |
| `maxFileBytes`, `maxResultBytes` | File/result bounds, 1 KiB–256 MiB; defaults 100 MiB. The result bound covers all staged raw/normalized/page/Markdown files and downloaded images in aggregate. |
| `maxFailures` | Retryable failure/crash budget, 1–20; default 3. Existing explicit values are retained. Normal remote polling does not consume it. |

Unsubmitted jobs adopt the selected parser before uploading. Once submission begins, the job retains its provider/API/model/options identity. Credentials are resolved live by original configuration name and matching endpoint, so key rotation does not require reupload. Changing an endpoint cannot redirect an accepted task; its original endpoint/key must remain available to resume. Older arbitrary model values are normalized in memory to the supported model when reading configuration, without changing persisted accepted-job identities. Saving writes the normalized configuration. Hidden legacy named entries remain intact for credential recovery; the UI remembers one configuration per parser.

Invalid or temporarily unreadable edits keep the last valid configuration and show a localized notice. A cold start with invalid configuration stays disabled. Restoring an identical last-valid file clears the notice. The file contains a reusable plaintext API key as requested: keep it private and outside Git. The plugin does not copy keys into jobs, profiles, revisions, artifact downloads or debug messages. This is file configuration, not a protected credential-store implementation.

Preference panes in independent windows/bundles share a host-owned per-path save lock. Each writer checks its observed file snapshot after acquiring the lock, so simultaneous stale forms cannot both overwrite the configuration or compete for its temporary filename. Closing a configuration instance drains its accepted saves and rejects new ones. External editor changes detected before a save still require reloading the form.

The registry and promise chains use the main window's constructors so closing a preference window does not leave dead Gecko objects in the shared save lock. Older dead registries are replaced before saving; stale-file checks still apply. A regression test covers that recovery alongside concurrent writers and shutdown draining.

## Repeated Running Margins

Both current parsers apply the shared detector in `src/parsers/running-margins.ts` before canonical paragraphs are merged or heading sections are constructed. Each parser supplies its physical page numbers, page dimensions, ordered text blocks, labels and available geometry. PaddleOCR removes matches on its deep working copy before cross-page merging; MinerU excludes them before heading-level repair/section publication. Raw provider pages remain unchanged and suppressed block identities remain traceable through `running-margin-removed:<header|footer|left|right>:<source>:cadence-<1|2>` warnings.

Header candidates are the first two nonempty blocks, wholly inside the top 15% of the page; footer candidates are the last two, wholly inside the bottom 10%. These must be independent single-line blocks, short (3–96 normalized Unicode characters), compact (no more than 4% of page height), and consistently positioned. Exact text comparison normalizes Unicode compatibility, whitespace and case; ordinary text does not use fuzzy matching or number masking. The first page is excluded from both evidence and removal.

Left/right candidates can occur anywhere in provider reading order. Their boxes must be wholly inside the outer 10% of page width and no wider than 4%. Short repeated side labels use the same textual safeguards as horizontal lines. Anchored download notices (`Downloaded from https://...`, optionally preceded by numeric issue metadata) and dated copyright notices form separate notice families of at most 2,000 normalized characters. Only these narrow side-margin families tolerate changed URLs, dates, punctuation or OCR differences in their trailing text. Body paragraphs and substantive sidebars are not classified from the mere presence of download/copyright words. `aside_text` supplies candidate evidence rather than authorizing blanket deletion; notes, captions and unknown structural types remain protected. MinerU converts both coordinate axes to actual page units before this detection.

A candidate must occur on at least three distinct pages, cover at least 60% of all eligible nonfirst pages or one physical-page parity, and show at least two adjacent occurrences at the claimed one-page/two-page cadence. Alternatively, five uninterrupted occurrences at that cadence establish a local running margin. This confirmed run also suppresses disconnected same-text candidates before and after it on the same edge and cadence/parity, but only when their geometry agrees with the complete run. A shifted occurrence is retained; duplicate, interior-text and missing-location vetoes still apply. Duplicate same-page occurrences veto the affected cadence/parity. Normalized centers on the relevant axis may vary by at most 2% of page size and block heights (horizontal lines) or widths (side margins) by 1.5%.

Numbered/standard section headings (including Markdown prefixes and full-width numbering), document titles explicitly protected by the adapter, sentences, table/figure labels, notes and sources are retained. A same-text occurrence in the document interior or an uncertain page without geometry vetoes removal; uncertain/missing geometry, sparse occurrences, duplicate same-page matches and inconsistent placement also retain content. Known provider header/footer labels can corroborate mislabeled text/heading occurrences. These are conservative content-correctness rules, not an OCR classifier or a claimed runtime speedup.

New work uses `paddleocr-vl-16` or `mineru-v4-6`; accepted PaddleOCR v1–v15 and MinerU v1–v5 identities remain supported. Existing published content is not silently rewritten at startup. Adopting changed normalization rules requires explicit reprocessing, preserving the preceding generation and source provenance.

### Peer Parser Architecture

`src/parsers/paddleocr/` and `src/parsers/mineru/` each implement the complete `DocumentParser` contract: submission/upload, remote status, download, response/container validation, structured normalization and local image preparation. `src/parsers/registry.ts` matches the immutable task identity to an implementation and its supported normalizers. `catalog.ts` supplies defaults, option/model validation, adapter identity and settings labels/help. Adding another provider registers a peer implementation and definition; the queue and publication repository require no provider branch. See [the extension contract](../../src/parsers/README.md).

`worker/parse-worker/runner.ts` owns claims, leases, source/version fencing, credentials, bounded submission acknowledgement and shared publication. `artifact-staging.ts` owns generated files, aggregate bounds and safe rollback. Parsers yield while waiting or return a shared `ParsedDocument`. General heading ancestry versus legacy section behavior is an explicit document property, independent of provider identity. There is no preferred provider downloader, normalizer or upload path in the shared worker.

The failed real-document regression contained five legitimate empty text entries plus `chart`, `page_footnote` and `ref_text` entries. Empty text now remains in raw data with an explicit skipped-empty diagnostic, while charts retain images/captions/notes, page footnotes become note-role blocks and reference text becomes reference blocks. Missing required visual content or malformed source positions still rejects publication; handling a valid empty text block does not weaken archive or image validation.

Two subsequent real failures contained empty table placeholders (`img_path: ""` and empty caption/footnote strings, without a table body). Such explicit placeholders remain in raw page content with `empty-block-skipped` warnings and do not create empty canonical blocks. Detached nonempty table captions/notes are retained as table blocks with `missing_visual_body` quality metadata and `needs_review`; no body is invented. Missing referenced images, invalid fields, unknown empty structures and corrupt archives still reject publication.

When a confirmed task fails during result download or publication, **Retry** resumes that task's remote ID, provider and normalizer if the attachment fingerprint and source/content versions still match. It resets the local failure budget and extends the tracking deadline without another upload. A newer generation, changed source or live conflict rejects this recovery. Deliberate reparsing and remote parser failures retain their separate semantics.

### MinerU

`src/parsers/mineru/index.ts` owns the workflow; its `provider.ts` implements the [authenticated standard v4 API](https://mineru.net/apiManage/docs), using one file per batch. It requests `POST <api>/file-urls/batch`, persists the returned batch/file identity and signed upload capability before uploading, then sends a token-free binary `PUT`. The service automatically starts parsing. `GET <api>/extract-results/batch/<batch-id>` correlates the file by `data_id`, maps `waiting-file`/`converting`/`pending` to waiting, retains running page progress, and handles `done`/`failed`. API business errors distinguish invalid/expired tokens, quota/queue limits and rejected requests without logging response text. Uploads reject redirects; upload and result hosts never receive the API key.

Successful binary PUT responses may omit a response body, including HTTP 204. Only the upload explicitly opts into that transport behavior; JSON calls and result/image downloads still require a nonempty response body, whether the runtime represents an empty response as null or an empty stream. HTTP errors, redirect restrictions and response-size bounds remain enforced. An empty successful upload acknowledgement advances the same accepted batch to polling without another allocation or PUT.

The supported options are `isOcr` (default true), `enableFormula` (true), `enableTable` (true), and `language` (`ch`). Unsupported options and models are rejected. Page-range parsing is intentionally not exposed: this workflow ingests the entire attachment. The service's 200 MB input limit is enforced independently of the configurable local input limit. Its documented 200-page limit can reject larger PDFs remotely; the normalizer also rejects output page identities outside that bound. The default local input/result budget remains 100 MiB. Upload links expire after 24 hours. The documented 1,000 daily highest-priority pages are a priority allowance, not a guaranteed daily throughput or hard page cap.

The queue checkpoints an upload intent before PUT. A restart before intent can continue with the saved signed URL; once intent exists, an interrupted or uncertain PUT polls the same batch and never automatically uploads again. Successful PUT removes the URL from the checkpoint. An uncompleted upload eventually requires attention; after checking the remote outcome, cancel local tracking and explicitly parse again if necessary. Missing allocation acknowledgements retain the existing ambiguous-submission fence. `data_id` is a correlation value, not a claimed idempotency guarantee. Linking a known remote task uses the batch ID; recovery without a saved file ID accepts only a single-file batch. Remote cancellation is not implemented.

`src/parsers/mineru/archive.ts` decodes ZIP files with Gecko's native streaming `DecompressionStream("deflate-raw")`; there is no Node runtime dependency or helper process. It validates central/local records, names, duplicate/colliding members, regular-file types, compression methods, CRCs, entry counts and aggregate declared/actual expansion bounds. Unsupported PDF/model artifacts remain preserved within the raw ZIP; only JSON/Markdown/image members are materialized in memory. Provider names never become local filesystem paths. Image signatures are checked and assets receive generated hash-based keys before the shared atomic publication transaction.

Normalizer `mineru-v4-6` reads `layout.json` and `*_content_list.json`; the raw ZIP also retains `full.md`, v2/model JSON and original provider artifacts. It preserves blank pages, reading order, block type, table captions/notes, HTML tables, equation text, image captions, source page and original normalized bbox metadata. Zero-based pages become one-based; 0..1000 coordinates are converted using each page's actual dimensions. Missing dimensions retain null locations and explicit warnings. Known page gaps produce partial generations. When polling never supplies an independent expected total, `source-page-count-unverified` records that completeness boundary.

Provider heading levels are retained as the fallback. Shared article-specific inference repairs supported numbered sections, records exact canonical parent positions and preserves the original level when changed. Inferred level changes and unresolved numbered titles are marked `needs_review`. Both current providers publish general section ancestry; see [heading inference](#article-specific-heading-hierarchy). Provider version and normalizer version are stored separately. The hosted service observed during verification reported producer `3.4.4`; the output reference currently linked from its docs describes a different open-source 4.0 schema. Unsupported output shapes fail validation instead of silently importing empty content.

Existing PaddleOCR configurations, queued/accepted jobs, v1 normalization and published generations retain their compatibility behavior. Only unsubmitted jobs adopt the current active provider. API keys remain in the private local configuration, never in task identities or artifacts. A not-yet-started MinerU upload temporarily stores its signed upload URL in the local job checkpoint; treat that database as private along with its source documents.

### PaddleOCR

The adapter uses the official asynchronous job protocol. Local upload is `POST <api>` multipart with `file`, `model` and JSON-encoded `optionalPayload`; it does not expose Zotero's attachment directory or require a publicly reachable file URL. Submission returns `data.jobId`. Status is `GET <api>/<encoded-job-id>` with states `pending`, `running`, `done`, `failed`, optional `extractProgress`, and `resultUrl.jsonUrl` on completion. Authenticated API calls reject redirects. Artifact requests omit bearer tokens and cookies and validate HTTP(S) destinations; production URLs require HTTPS.

Direct-upload fields were verified against the [official SDK transport](https://github.com/PaddlePaddle/PaddleOCR/blob/main/api_sdk/typescript/src/internal/http.ts) and [API guide](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/serving/paddleocr_official_api/typescript.md). The plugin implements this contract with native Gecko APIs; the Node-only SDK is not a runtime dependency.

The plugin's effective default options are: orientation/unwarping off, layout detection on, chart/seal/image OCR off, table merging/title releveling on, shape `auto`, prompt `ocr`, repetition penalty 1, temperature 0, top-p 1, pixels 147384–2822400, layout NMS/page restructuring on, and ignored Markdown labels `header`, `header_image`, `footer`, `footer_image`, `number`, `footnote`, `aside_text`. Missing options in older configuration files receive these defaults in memory; explicit overrides survive validation and settings save. All 18 options are sent in `optionalPayload`. The API/model/key and execution limits remain hot reloadable. New installations default to three retryable failures; existing configured budgets are preserved.

Normalizer `paddleocr-vl-16` applies versioned content-quality, paragraph-boundary, image and table rules, and associates empty visual blocks with their page-local crops. JSONL preserves physical page positions and gaps; exactly one unknown failed chunk can infer its span from the expected page count. Ambiguous positions reject publication. Header/header-image/footer/footer-image/page-number blocks are excluded from canonical text, while raw layouts remain unchanged. Cross-page body text and abstracts merge only at consecutive physical page boundaries using punctuation/heading rules and explicit keyword-list boundaries; numbered references use the dedicated entry-boundary rule below; merged blocks retain all source IDs, page spans and available coordinates. Document titles become level-one headings. Chinese numbered paragraph titles default to level two and other paragraph titles to level three unless Markdown markers already exist; shared article-specific inference then replaces only supported numbered levels and parents. HTML table structure and merged cells survive, captions are centered, adjacent formula numbers become LaTeX tags, and footnotes become quotes. Formula source is retained; rendering is handled separately by the Markdown companion.

Only retained `paragraph_title` headings create sections. Approved numbered headings use their explicit inferred parent; other current headings use the level-based ancestor stack. Legacy output retains its original two-level publication behavior. Section paths, sibling order and ancestor page/canonical ranges follow the resulting tree. Document titles remain in the root. Partial results mark nodes and blocks `needs_review`, and footnotes have role `note`. Quality flags classify boilerplate, short fragments, authors, keywords, references, tables, formula-only blocks and OCR noise without removing retained canonical blocks or starting embeddings. Detected title/abstract/language are derived metadata: the native Zotero title is never overwritten, and only missing knowledge abstract/language fields are filled.

Unsubmitted work adopts the current normalizer before upload. Confirmed or ambiguous v1 submissions retain their original processing identity and use `legacy-transform.ts` when resumed. Existing published generations remain unchanged; explicitly parsing again applies the new rules. A failed reparse preserves the old readable generation.

Result images are downloaded, signature-checked as PNG/JPEG/WebP/GIF, stored under generated paths and rewritten to local asset keys. Provider-supplied names never become filesystem paths. Artifacts include original `raw.jsonl`, `normalized.json` before URL rewriting, cleaned `document.md` with page/layout comments, rewritten `pages.json`, embedded images, `inputImage` page images and compatible diagnostic output images. Page-scoped image keys prevent repeated filenames on different pages from colliding. Page images have separate artifact roles/page numbers and are not automatically embedded in the reader. The reader loads only hash-verified managed images, with a 10 MiB per-image and 30 MiB aggregate display bound; other images remain placeholders. The reader joins canonical block Markdown in reading order; `document.md` remains a complete page/comment-bearing export artifact. The DOM allowlist renders HTML tables, row/column spans and centered captions, strips active elements and event handlers, hides layout comments, and allows images only through verified local assets. External images remain inert. The existing reader text limit is 2 MiB, enforced before publication.

Live PaddleOCR results can leave `image`/`chart` block text empty while `markdown.images` holds crops named `img_in_<label>_box_<x1>_<y1>_<x2>_<y2>.<extension>`. The normalizer associates one exact label/bounding-box match on the same page, retains that original key in block metadata and produces Markdown pointing to the managed local image. It never guesses from array order, a different page, approximate geometry or duplicate matches. Hydration occurs on a deep copy before paragraph merging, so a newly visible chart remains an independent visual block even when its surrounding prose is rejoined; provider raw data remains unchanged. Existing nonempty visual text/Markdown and header-image exclusions retain their behavior. Accepted v1–v15 identities remain supported; new work records v16.

## Article-specific Heading Hierarchy

Current output normalizers are `paddleocr-vl-16` and `mineru-v4-6`. Both apply the
shared heading refinement after provider normalization and before publication.
Previously accepted identities remain supported; confirmed PaddleOCR v1 work
still uses its original legacy transformer. Existing published generations are
not rewritten at startup; explicit reprocessing adopts the new rules and retains
the preceding generation if publication fails.

Numbering styles do not have a universal priority. The algorithm first infers
the styles used by one article, with independent scopes at explicit
Part/Chapter/Section, Chinese unit and appendix boundaries. It compares candidate
orders against sibling progression, parent-scoped counter resets, duplicate
numbers and child-series starting values. Supported relations require repeated
structure or enclosure by progressing parent siblings; transitive relations
allow a branch to omit an intermediate style. For example, both
`一、 > （一） > （1）` and `（一） > 一、 > （1）` can be inferred. A single
occurrence of each prefix does not establish either convention.

Matching applies Unicode NFKC normalization and removes formatting differences
inside a recognized numbering prefix: full-width/half-width/mixed parentheses,
spaces inside parentheses, and spaces around Chinese enumeration delimiters,
decimal dots and letter delimiters. It does not merge separated digits or Chinese
numerals, change body text/title spelling, or substitute OCR-confusable letters,
digits and dashes. The original title, raw pages, source identities and geometry
remain available; approved output changes the Markdown heading level only.

An approved decision records its exact canonical parent position, independently
of provider source IDs, which may repeat across pages. Publication uses that
parent for the section tree and restores its ancestor stack for subsequent
unnumbered headings. Markdown, stored depth, section paths and ancestor ranges
therefore describe the same hierarchy. Document titles stay outside the section
tree. Diagnostic metadata records the algorithm version, numbering style,
decision, reason and parent. Changed levels retain their original level and the
`heading_level_inferred` review flag.

Unnumbered titles retain their original levels. Sparse/conflicting rules,
missing/duplicate parents, uncertain figure panels, OCR digit ambiguities and
isolated parenthesized/circled enumerations retain provider formatting with
`heading_hierarchy_uncertain` and `needs_review`. Confident table/figure/algorithm,
hypothesis and reference-entry prefixes are retained as paragraphs without
creating sections. No paragraph is promoted to a heading. An ordinary short
list already mislabelled as headings can still imitate a section series;
numbering alone cannot reliably distinguish that case. Each scope is limited to
seven flat styles, 250,000 simulated heading states and five section levels below
the document-title root; exceeding a limit retains reviewable provider output.

## Output Provenance and Audit Corrections

Every parser returns a required `ParsedDocument.normalizerVersion` identifying the algorithm actually used to generate the returned content. The worker rejects missing, unsupported or foreign output versions before publication. The shared transaction writes this value to `content_generations.normalizer_version`. The accepted job payload, deduplication key, provider configuration and `parse_runs.normalizer_version` retain the original submission identity. Resuming accepted PaddleOCR v2–v10 or MinerU v1/v2 jobs uses the current corrected transformer and records its current output version without uploading the PDF again. PaddleOCR v1 retains its legacy transformer and output version. Existing published generations are immutable and are not relabeled at startup; no schema migration is required.

Background collection synchronization retains an attachment's active published generation when its bytes/source version are unchanged, even after a normalizer upgrade or parser/endpoint/options change. Complete and partial publications, including hidden task history, remain retained without another upload. Existing current queued work keeps priority over history reuse. When no published generation can be reused, unchanged live tracking and failed/cancelled attempts remain attached to their original identity instead of silently restarting under a different parser. Stale source/content history is excluded from that reuse. Explicit parsing and changed attachment bytes still admit new work under the selected configuration.

PaddleOCR continuation follows consecutive physical page boundaries even when an intermediate page contributes its whole paragraph to an earlier page. Page gaps, blank pages, completed sentences, headings, empty tables and equations stop continuation; image/table interruptions follow the conservative rule below. Keyword lists are also standalone boundaries in either merge direction, even when the list has no terminal period. English Keyword/Keywords/Key words and simplified/traditional Chinese labels are recognized with a colon, including simple Markdown/HTML emphasis; ordinary prose such as "Keywords are useful for" remains eligible for continuation. This prevents a page-one keyword list from swallowing the introduction on page two. The correction applies to both canonical blocks and generated Markdown, with raw pages and source IDs retained. Numeric source ID zero and generated page/block fallback IDs remain in merged source lists and locations. Malformed page layouts cannot silently become successful blank pages; explicit empty layout arrays remain valid blank pages.

Both parsers rewrite complete Markdown and HTML image destinations, including angle-bracket destinations, image titles, entity-encoded HTML URLs and unquoted HTML sources. Rewriting does not replace a filename in ordinary prose, alt text, or a different URL that merely contains the same path. Raw provider artifacts are preserved. MinerU task projections retain the upload stage after allocation until its binary PUT completes.

`test/parser-correctness.test.mjs` covers version-divergent accepted-job recovery for both providers, immutable submission identity, output-version rejection, multi-page continuation and source IDs, gap/blank/heading boundaries, malformed layouts, exact managed image publication/rendering, running-margin safeguards and MinerU upload-stage projection. These are correctness corrections, with no runtime speedup claim.

## Reference Ingestion

Nonempty canonical `reference`, `reference_entry` and `bibliography` blocks
produce derived bibliography entries in the same fenced publication transaction.
`reference_number` stores the recognized original integer, or null when absent;
`entry_order` stores the zero-based entry position. `raw_text` contains the merged
Markdown body without the leading number, enclosing brackets or following
separator punctuation. Half/full-width square/round brackets, `【】`, `〔〕`,
`〖〗`, braces, angle/quotation/decorative brackets, bare `1.`/`1)`/`1、`, and
emphasized labels are supported. Compatible half/full-width pairs may mix;
mismatched bracket families remain invalid. Bare publication years and decimals
are not treated as labels. Gaps and repeated original numbers are retained.

Numbered line starts split packed entries, including a number on its own line
or source block. PaddleOCR normalizer v13 uses the same prefix recognizer for
entry boundaries; confirmed earlier jobs can recover without resubmission.
An unnumbered reference fragment can
continue a numbered owner across adjacent pages and intervening images, tables,
captions or footnotes. Headings/body blocks, protected manual records and page
gaps stop merging. Unnumbered entries can also continue across consecutive pages
without an original numeric label: a split hyphenated word, an unclosed title
quote/bracket, lowercase continuation, unfinished clause or volume/DOI tail
provides evidence. New author/year openings and terminal sentence punctuation
stop these joins. Unnumbered same-page blocks remain independent. Exact
suffix/prefix overlap is removed conservatively. `reference_source_blocks` links
every merged source block; split entries can share a block. Original canonical
Markdown, page spans, boxes and provider artifacts remain unchanged. Missing
positions stay missing. Publication failure rolls back content and references;
reprocessing preserves history. This does not infer authors/titles/DOIs, match
targets, create Zotero items or call another model.
`parsed_json` remains `{}`, confidence is null and match status is `unmatched`.
Bibliography records do not change embedding admission: reference blocks are
still excluded from semantic input.

Migration `0011-reference-backfill` locally derives the same records from all
existing ready, partial and superseded parse generations. It retains prior
bibliography records, including manual corrections and explicit tombstones, and
does not mutate blocks, resource versions or earlier migrations. The normal
pre-upgrade database snapshot protects the upgrade. No PDF upload, OCR request or
artifact rewrite is required. Imported/manual/edit generations are excluded.

Migration 0013 adds numbering/provenance fields and projection checkpoints.
Startup transactionally rebuilds each missing published parser projection from
canonical blocks. Projection v2 also upgrades completed v1 generations. A frozen
v1 replay checks source links, body, number, label and order before replacing
automatic rows; manual/matched/edited records and tombstones protect every linked
source block. Upgrade failures roll back records, links and the checkpoint
together. Current generations are skipped on restart. No document/source version
or content fingerprint changes, provider request or raw-artifact rewrite occurs.

The reader renders labels separately as `[n]`: original numbers take precedence;
otherwise the entry's one-based reading position is used. Canonical source reads
still return the unchanged source Markdown.

MCP `list_references` reads only authorized current source/generation anchors,
groups sources by ID and sorts anchored references by canonical block order.
Standard responses include `referenceNumber`; full responses (or explicit
`includeFields`) also include `entryOrder`, `sourceBlockIds`, `canonicalOrder`,
`pageStart`, `pageEnd` and aggregated `locations`. `rawText` is the number-free
derived body; an unavailable position is null or an empty array.
Pre-upgrade reference cursors are invalidated by a reference projection revision.
The availability flag means records exist, not that their bibliographic fields
have been parsed or independently verified.

## Numbered Reference Continuation

PaddleOCR v11 adds a dedicated rule for provider-labeled `reference_content`.
For same-page continuation, the owning reference starts with a numeric marker such as `[1]`,
`【1】`, `(1)` or `1.`; full-width equivalents and simple emphasis are accepted
for marker detection without changing the stored spelling. A subsequent
`reference_content` block without a new marker can continue it on the same page
(including a column break), across consecutive pages, or through image/table/note
groups. Every explicit new marker stops continuation, including when the earlier
entry has no terminal punctuation. A body-text, abstract, heading, formula,
unknown structural block, empty table or missing/blank page remains a boundary.
Reference fragments never merge into ordinary body text or author biographies.

Reference continuation uses the same reading-order scan and independent floating
blocks as body continuation, with its own entry-boundary predicate. Periods after
author initials, titles or journal names do not stop a numbered reference; the
body sentence-stop policy is unchanged. No space is inserted between a retained
terminal hyphen and a following Latin word, so `bag-of-` plus `words` becomes
`bag-of-words`; no hyphen or other source character is deleted. The owning block
retains source IDs, page spans and boxes, with `reference_continuation_merged: true`
and applicable page/image/table/note flags. Canonical blocks and `document.md`
share the rule. Bounded MCP block/document reads use the resulting canonical
entries. Bibliography record ingestion is a separate publication concern.

Normalizer v13 additionally recognizes cross-page unnumbered continuation using
the shared lexical predicate described above. Same-page unnumbered entries and
complete/new-author citations remain separate. This does not infer bibliographic fields, relabel provider text/notes,
split multiple citations already inside one source block, or change MinerU.
Existing generations require explicit reprocessing or a local saved-artifact
replay; they are not rewritten during startup.

## Image-, table- and note-interrupted paragraphs

PaddleOCR v10 extends the v8 image/note continuation rule to tables. Body text
can continue across independent notes, images/charts or nonempty tables, with
provider-labeled captions and notes on either side of those elements. It works on the
same page or across consecutive physical pages and composes with ordinary page
continuation. The first text block owns the complete paragraph; the floating blocks follow it,
retaining the relative order of all its images, tables, captions and notes. Captions and
notes never become paragraph text. Canonical Markdown and the document export
use the same merged working copy. Raw layouts are unchanged.

The merged block retains every original source ID, page span and available source
box, and records `cross_image_merged: true`, `cross_table_merged: true` and/or
`cross_note_merged: true` alongside `cross_page_merged` when appropriate. Empty
tables, equations, headings, unknown structures, completed sentences, keywords,
missing/blank pages and structured Markdown/HTML prose prevent merging.
An explicit `table_title` requires a table in the interruption. PaddleOCR also
uses `figure_title` for table captions; figure/chart caption labels can accompany
either an image/chart or a table without relabeling or inspecting their text.
Orphan captions do not trigger merging. Ordinary adjacent
same-page paragraphs stay separate. Independent footnotes and visual notes may interrupt the same paragraph on one
page or across consecutive pages, with or without images. Their content is never
absorbed into the paragraph, and no figure association needs to be inferred. A
terminal sentence stop remains a hard boundary, including before parenthetical
explanations such as i.e. or e.g.; there is no semantic exception. Numeric note
markers after a sentence stop do not conceal that boundary.

Execution order is explicit: validate physical pages, copy layouts and detect
running margins, hydrate image crops and attach source locations, remove confirmed
margins, then scan the copied blocks once in physical-page/reading order. Page, image, table and
note continuation are predicates within that scan, not successive mutating passes.
Each successful join retains the first owning paragraph and accumulates provenance
flags, so repeated and mixed interruptions compose regardless of group order.
An intervening table-only page can retain the pending continuation, but missing
or explicitly blank pages reset it. Canonical blocks and `document.md` use this
same deterministic merge function; stored reader content and MCP consume the
published blocks without rerunning a rendering-only merge. Existing generations
still require explicit reprocessing or local replay before this behavior appears.

Provider block labels remain authoritative: note types are not inferred from
text prefixes, and mislabeled note text is not reclassified automatically.

This is a conservative layout/punctuation heuristic, not OCR or semantic model
inference. Ambiguous provider labels and sentence boundaries can still leave
fragments separate. MinerU keeps its provider block boundaries. Existing saved
generations are not rewritten automatically; a local rebuild from retained raw
artifacts or explicit reprocessing is required to change their canonical text.

## Visual Associations

Migration `0012-visual-links` adds a derived relationship projection beside
immutable `content_blocks`. Each persisted link has its own UUID, generation ID,
visual block UUID, related title/note block UUID, role (`caption`/`note`), position
(`before`/`after`), evidence (`layout`/`adjacency`/`provider`) and ordinal. Composite
foreign keys require both blocks to belong to the same generation; a title/note
block has at most one owner. These are generation-bound associations, not IDs
reused across reprocessing. Ordinary text and source labels are never reclassified.

PaddleOCR titles and notes remain independent canonical blocks. Association
considers only labeled captions/footnotes and images/tables in the same local
reading-order group; ordinary text, headings and other structures stop the search.
At most twelve neighboring entries are inspected per direction. Same-page boxes
must overlap horizontally by at least 35% of their smaller width, be above/below
rather than inside the visual, and have a nearby vertical gap. Distance bounds
use observed page extents (9% for titles, 12% for notes, with a 48-unit floor).
Candidates with similar scores remain unlinked. Explicit `table_title` requires
a table; generic figure titles can accompany tables because PaddleOCR uses this
label for table captions too. Missing geometry allows only a unique direct
caption/visual-note neighbor on the same or consecutive page, recorded as weaker
adjacency evidence; an unlocated ordinary page footnote is not linked this way.
This is a conservative layout heuristic and does not establish semantic certainty.

MinerU's embedded `*_caption`/`*_footnote` arrays already specify ownership.
Their exact title/body/note parts are retained in relationship rows only when
reconstructing them exactly matches the saved canonical visual block after asset
rewriting. The original combined block remains unchanged. Empty/detached visual
parts keep their existing warnings; missing or corrupt saved artifacts leave
the combined block readable without invented associations.

New publication creates the projection in its fenced content transaction. On
upgrade, local startup backfills unprojected published parser generations, one
transaction per generation. A completed projection keeps its relationship UUIDs
on repeated startup; a failed transaction can retry. Saved MinerU pages are read
only from bounded, hash-verified managed artifacts. No PDF upload, provider call,
canonical rewrite, source version change or annotation remapping is required.
Historical generations retain their own associations. MCP full block metadata
exposes links under the same resource/generation authorization boundary; a change
to the active projection invalidates old read cursors.

## Queue and Publication

`processing_jobs` is the authoritative queue. `parse_runs` holds durable submission identity, remote job ID, stages and progress. A claim uses a fresh execution token and a 90-second lease, renewed every 20 seconds. Writes validate token, lease, cancellation, source fingerprint/version, content version and a surviving knowledge membership. Metadata-only edits do not change the PDF fingerprint or force reparsing.

The job advances through validation/submission, polling, download and publication. `waiting` and `retry_wait` retain checkpoints without holding a lease. Transient errors use bounded exponential backoff and jitter; HTTP 429 respects `Retry-After`. Unknown submission outcomes enter `needs_attention` and never automatically submit again. **Link server task** accepts an existing job ID after the user checks the server; otherwise the user can cancel after checking the submission. No unsupported provider idempotency or cancellation endpoint is invented.

Cancellation stops local work and fences publication. The official contract used here has no verified remote cancellation operation, so an already accepted server job may continue. The remote concurrency setting bounds live tracked jobs; cancelling local tracking can release a slot while remote computation continues. Shutdown stops claims, aborts requests, drains execution and releases ownership before closing storage. Restart resumes confirmed remote IDs and recovers expired attempts. An abandoned submitting attempt remains ambiguous even when its crash budget is exhausted.

Downloads use execution-specific generated paths and a prewritten manifest. The final transaction inserts a staging content generation, section tree, ordered blocks, file/artifact links, revision and outbox event, then switches the active generation and completes the job together. A rollback retains the old readable generation and removes uncommitted files. Failed cleanup retains its attempt manifest. Before starting claims, startup reclaims unreferenced generated files, including legacy attempts with a missing manifest, while preserving every database-referenced file. A locked attempt retains recovery evidence and does not block startup or recovery of other attempts; its files are retried on the next startup. Published generations stay immutable; annotations retain their original generation targets. Active manual/edit generations require review rather than silent replacement. No annotation remapping is claimed.

The panel shows the latest job in an explicit retry chain while retaining older attempts in the database. Target labels reflect current knowledge memberships. SQLite owns state, services own commands, the application owns the worker, and each window owns only its task projection/subscription. Closing the panel does not stop processing.

Matching PDF bytes and parser settings do not by themselves make a live or failed attempt reusable. Admission also checks the current source and base content versions, fences stale live leases before replacing their deduplication key, and replaces obsolete cancellations after readmission. Current partial publications and deliberate user cancellations remain reusable during periodic sync, preventing automatic repeat uploads. Returning to earlier PDF bytes after an intervening file change creates a fresh attempt. Task-view notification failures are isolated from submission, publication and scheduler completion, so a detached panel cannot invent an uncertain remote outcome.

Single-item actions reject replaced or cleared attempts, including commands captured by a stale context menu, instead of starting another paid parse. Publication-error cleanup checks database file ownership before reclaiming staged artifacts: a lost acknowledgement after a successful commit cannot delete published files. If ownership cannot be read, the manifest and files remain for safe startup recovery. A corrupt manual Markdown cache does not prevent reading a healthy processed generation; a failed processed read still preserves an available manual import.

New manual retries also link to the previous matching attempt. For older records without such a link, the task projection shows only the latest attempt with the same deduplication identity, preventing obsolete failures from remaining visible beside a successful retry. Hiding that latest history does not reveal an older failed attempt. HTTP rejection messages include the status code in all supported locales without rendering arbitrary provider response bodies. Explicit sync-folder retry delegates to failed children while preserving unknown submission outcomes for recovery.

### Ambiguous Submissions and Batch Actions

Recovery keeps an unresolved upload visible and cancels unsubmitted replacement
attempts before resuming its tracking. Submission reservation also rejects another
attempt for the same PDF while its outcome is unknown, including across parser
profiles. Accepted successors retain their remote IDs and must finish or be
cancelled before linking a conflicting attempt. Explicitly hidden history remains
hidden until admission reopens it.

Persisting an accepted remote ID is retried up to three times. Exhaustion keeps
the durable submission fence and exposes recovery instead of creating another
upload. Source identity and PDF fingerprint also fence uncertain terminal records.
Local cancellation stays cancelled during background recovery and synchronization;
later explicit admission can reopen tracking without automatically uploading again.

Batch actions continue independent children after failures, refresh the task
projection and wake eligible work before reporting combined localized errors.
Batch Retry selects current visible attempts, skips successful children and unknown
submission outcomes, and retains completed generations. Eligible failed, cancelled
or partial attempts can retry or resume recoverable tracking. **Parse again** is
available for an individual completed item, not a completed batch folder. Sync
group retries use the same batch command.

## Verification

The parsing, parser-registry, MinerU, normalization, heading, reference, running-
margin, paragraph-continuation and visual-content tests use synthetic fixtures.
They cover wire fields, options, provider/normalizer identity, accepted-job retry,
ambiguous submission, missing/empty content, managed paths, archive limits,
ordering, source positions, transactional publication and cleanup/recovery.

Native checks separately verify Gecko multipart/fetch/decompression/IOUtils and
SQLite publication against a loopback synthetic provider. Use a disposable data
root and fixture-owned artifacts. Test restart, cancellation, changed sources,
failed cleanup, commit-acknowledgement uncertainty and exact attachment reading.
Never use a production artifact directory for failure injection or cleanup tests.
Live provider output quality and quota use are separate from routine regressions.
