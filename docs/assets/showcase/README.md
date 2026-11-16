# Reader Showcase Assets

These PNGs demonstrate the current reader components using an original fictional
paper, **Tree cover and urban heat exposure**, with invented authors, references
and table values. No private library records or published paper bodies are used.
The figures illustrate interface behavior and make no scientific or performance
claim. Project-created demonstration text and screenshots use the project MIT license.

- `reader-overview.png`: structured reading and heading navigation.
- `document-search.png`: local full-text search for `tree cover`, showing actual
  matched passages and locations from the synthetic content.
- `block-editing.png`: the actual block editor's Markdown preview, with a
  corrected synthetic paragraph and results table.

The screenshots were captured at 1200 × 760 in headless Chrome using Playwright.
The fixture bundles `src/ui/views/content-reader.ts` and its shipped reader,
search, editor, rendering, Fluent and CSS dependencies. It provides a mock Zotero
host and synthetic attachment content. Native PDF/window chrome and position-sync
controls are omitted because there is no native PDF in this fixture. These are
component demonstrations, not screenshots of a complete Zotero installation or
proof of native runtime/provider acceptance.

When refreshing screenshots, use the current production components and an
isolated synthetic fixture. Exercise the actual search and editor controls before
capturing their states. Preserve the original source-context and draft/save
semantics; never insert private papers, credentials or unaccepted feature mockups.
Update captions in the repository README if the depicted behavior changes.
