# Read and edit extracted text

After parsing finishes, open a PDF in Zotero's native reader and click **M**.
The Markdown companion displays the selected attachment's published text with
available math, tables, images and source context. PDF content and annotations
remain in Zotero's native reader.

## Navigate

- Use **Contents** to browse headings. The current heading and its ancestors
  follow the reading position.
- Use document search to find text or model-backed matches within this PDF.
- Hover or focus a recognized citation to inspect bibliography entries and
  available source navigation. Ambiguous citations may offer several candidates.
- Use the floating reading bar to change text size or return to the top.

Visibility, split ratio, outline settings and text size persist across documents
and restarts. Extraction and citation matching can be imperfect; compare the PDF
when exact wording or attribution matters.

## Correct a block

1. Use the pencil icon or a text block's context menu to enter editing.
2. Edit Markdown and switch between source and preview. Formula source can be
   edited where the block mapping supports it.
3. Apply the block edit to update the working preview, outline and local text search.
4. Use undo/redo as needed, then choose **Save document** to publish your edits.

Block type changes, insertion and confirmed deletion are available for blocks
whose source mapping is unambiguous. Some blocks cannot support every operation.

Applying a block is not the same as saving the document. Unsaved edits and the
in-memory undo history are lost when the PDF reader closes or the plugin or
Zotero restarts. Hiding the Markdown pane preserves the working session.

Saving publishes a new content generation with conflict detection. Unchanged
matching vectors can be reused; changed text follows the configured background
embedding policy. If saving reports a conflict, preserve your unsaved text
before reloading the current document.
