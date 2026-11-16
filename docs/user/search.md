# Search papers and passages

Choose a knowledge scope, then select a **Knowledge Base** mode in Zotero's
search dropdown. Enter a nonempty query and press **Enter** to submit it.
Changing the mode alone preserves the current list. Empty Enter clears the
plugin result filter without a model request.

| Mode | What it uses | Requirements |
| --- | --- | --- |
| Text | Local text and metadata matches | Published text for passage matches |
| Semantic | Meaning-based vector retrieval | Enabled embedding service and matching indexed content |
| Enhanced Semantic | Semantic retrieval followed by reranking | Configured embedding/reranking services and matching indexed content |
| Fusion | Combined text and semantic retrieval | Available channels; semantic readiness affects results |

Open the native disclosure arrow beside a result to inspect matched passages,
metadata fields and source links. A compact relevance notice precedes lower
scoring results; those results remain available for inspection. Scores are
ranking signals, not factual certainty or a substitute for reading the source.

**My Knowledge Base** can search across active knowledge libraries. A specific
knowledge library or folder narrows the scope. Knowledge Trash has its own
recovery scope.

## Search within an open PDF

The Markdown companion has a separate document search sidebar. It supports
text, semantic, enhanced semantic and fusion modes for the displayed
attachment's current content. Selecting a hit navigates to its source block.
Closing search returns to the outline.

Text search can work before semantic indexing is ready. If semantic results are
missing, inspect Import Tasks, the model configuration and recovery status.
Use [troubleshooting](troubleshooting.md) before reprocessing a PDF.
