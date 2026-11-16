# Interface Localization

The plugin follows Zotero's interface language. Change that language in Zotero's settings and restart Zotero when requested. No separate plugin language preference is required.

| Language | Resource directory |
| --- | --- |
| English | `addon/locale/en-US/` |
| Simplified Chinese | `addon/locale/zh-CN/` |
| German | `addon/locale/de/` |
| French | `addon/locale/fr-FR/` |
| Spanish | `addon/locale/es-ES/` |
| Japanese | `addon/locale/ja-JP/` |
| Traditional Chinese | `addon/locale/zh-TW/` |

Each directory contains one UTF-8 file, `knowledgemcp.ftl`. It covers native context menus, item-pane headings and fields, knowledge tree labels, dialogs, expected operation errors, reader controls/status, and accessible labels. Technical logs, database values, protocol identifiers and literature content are not translated. Existing library/folder names and imported Markdown remain their saved text. A new database's initial library name uses the language active at creation; changing the language does not rename it.

## Add a Language

1. Copy `addon/locale/en-US/knowledgemcp.ftl` to `addon/locale/<locale>/knowledgemcp.ftl`, using the locale identifier supported by Zotero where possible.
2. Translate message values. Preserve every `knowledgemcp-*` ID, attribute such as `.label` or `.tooltiptext`, and variable name such as `$name`. Keep message references and Fluent syntax intact. Translators can reorder variables and use Fluent plural/select expressions.
3. Run `npm run typecheck` and `npm test`, then check the language in isolated development Zotero.

No TypeScript import, registry entry, manifest change or build configuration change is needed. `scripts/prepare-locales.mjs` discovers directories and regenerates `addon/content/locale-catalog.json` during the build. Scaffold packages every locale file through `addon/**/*.*`. Bootstrap registers a complete native Fluent source for each available Zotero locale, using Zotero's locale resolver. The tests discover all locale directories automatically without editing a language list.

English is the complete source catalog. Whenever a feature adds or changes a message, update every translation in the same change. The automatic checks require complete files; do not rely on fallback to fill individual missing messages.

Retrieval result groups, threshold settings, central evidence cards, matching
metadata fields and score explanations use the same seven complete catalogs.
Native formatting and settings mounting are verified by `verify-vector-ui.mjs`;
`verify-vector-result-ui.mjs` also checks new group messages through native Fluent.

## Runtime and Fallback

Native menu and section APIs use Fluent IDs directly. Runtime text calls `t(key, args)` from `src/shared/localization.ts`, which lazily creates Gecko's native synchronous `Localization(["knowledgemcp.ftl"], true)`. This keeps synchronous native tree renderers and dialogs compatible with the host and uses the same Fluent data as menu attributes. There is no custom translation parser or runtime Node dependency. `@fluent/bundle` and `@fluent/syntax` are development dependencies for verification only.

Messages assigned to native menus or section headers must have attributes only, with no main message value. Fluent applies a main value as text content, which removes the native icon and submenu children. For example, keep `knowledgemcp-add-default =` empty and translate its `.label` on the following line. `t()` uses `formatMessagesSync()` and reads the message value or its `.label`, allowing runtime buttons and native menus to share that message safely. References to an attribute-only label use `{ knowledgemcp-info-header.label }`.

Zotero 10.0.6's plugin loader scans all locale directories and resolves each resource file by exact locale, then matching language, then English. Thus English variants can use `en-US`, and unsupported languages use English. File-level fallback belongs to Zotero; it does not merge incomplete translations with English. Names and other variables are passed as Fluent arguments and inserted as text rather than HTML. Reader validation failures have translated messages; unexpected file/host errors show a translated failure message.

Rapid addon replacement can let the host's previous asynchronous `unregisterLocales()` remove its unified source after the next instance starts. Bootstrap therefore owns the independent native `knowledgemcp-owned-locales` source, populated from the same complete packaged catalogs through `L10nFileSource.createMock`. Host locale negotiation still selects the catalog; no custom Fluent parser or per-message fallback is introduced. Shared lifecycle serialization closes the earlier API before new database, resource and locale registrations. The captured instance owns its cleanup, so a late shutdown cannot remove a newer instance's source. Native reload and seven-locale retrieval settings checks are recorded in the [vector acceptance report](vector-retrieval-acceptance.md).

## Verification

`test/localization.test.mjs` checks Fluent syntax, duplicate IDs, complete IDs/
attributes/variables, formatting, literal references and packaged catalogs.
Native menu/section messages must remain attribute-only so localization cannot
replace icon/submenu children. Node/VM/JSDOM scenarios exercise the real catalogs
with synthetic host adapters.

Verify native locale negotiation, labels, icon/submenu preservation and reload
cleanup in isolated Zotero. Formatter/DOM probes do not replace manual visual,
screen-reader or native-language review. See [project status](project-status.md).
