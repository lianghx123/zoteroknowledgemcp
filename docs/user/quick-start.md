# Process your first document

Start with one paper whose PDF is already available locally in Zotero. Processing
uploads that PDF to the parser you configure; check your provider's terms before
using confidential material.

## 1. Configure a parser

Open **Zotero Settings → Knowledge MCP → Document parsing**.
Choose **PaddleOCR (PaddleOCR VL-1.6)** or **MinerU (VLM)**, enter the matching
service credentials, enable parsing and save. See [service configuration](configuration.md)
for endpoint details.

## 2. Add the paper

In a native Zotero literature view, right-click the paper and use
**Add to Knowledge Base**, selecting the desired knowledge library or folder.
The plugin admits its metadata and queues eligible PDF attachments. Adding the
same paper to the same location again does not create a duplicate resource.

An item without a PDF can still have metadata in the knowledge base, but it
cannot acquire extracted text from that metadata alone.

## 3. Follow processing

Open **Import Tasks**. The workflow groups three stages:

1. Add to knowledge base.
2. Extract document content.
3. Prepare semantic search, when enabled.

Extraction includes preparation, upload, provider waiting, extraction, download
and local saving. A provider page percentage describes extraction progress,
not the percentage of the complete workflow. You can inspect failures and use
the available cancel/retry controls. Retrying the vector stage does not upload
the PDF again.

## 4. Read the result

Open the PDF in Zotero's native reader and click **M** to open its Markdown
companion. If the reader was open before processing completed, close and reopen
it. Use the outline, document search and citation previews to navigate.
See [reading and editing](reader.md).

## 5. Search or connect a client

Text search works with published text without an embedding service. For semantic
search, configure and enable model services, then allow indexing to finish.
Use [search](search.md) or [connect a local AI client](mcp.md).
