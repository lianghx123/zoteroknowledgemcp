# Configure services

Open **Zotero Settings → Knowledge MCP**. The pane has **Document parsing**,
**Models and retrieval** and **MCP connection** tabs. Each tab retains its own
save or apply action. Switching tabs retains unsaved inputs.

## Document parsing

| Parser | Endpoint | Model |
| --- | --- | --- |
| PaddleOCR | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` | `PaddleOCR-VL-1.6` |
| MinerU | `https://mineru.net/api/v4` | `vlm` |

Select a parser and enter its corresponding API key/token. Enable parsing and
save. Each parser retains its own credentials and options when you switch.
Models are fixed by the parser selection. Arbitrary OCR endpoints are not
automatically compatible with these protocols.

Use HTTPS for external endpoints; plain HTTP is limited to loopback services.
Endpoint URLs must not embed passwords, query strings or fragments. An accepted
job retains the endpoint and parser identity with which it began; changing the
current parser does not redirect that job.

Queue settings control local execution slots, tracked remote jobs, polling,
timeouts and file/result limits. Start with defaults. Displayed times use seconds
and sizes use MB (1 MB = 1,048,576 bytes).

## Models and retrieval

The shipped provider is **Bailian**. Default models are
`qwen3.7-text-embedding` and `qwen3.7-text-rerank`; the default vector dimension
is 768. Verify that your service account supports the selected models, region,
endpoint and dimensions.

1. Enter an embedding endpoint, model and key compatible with the selected provider.
2. Configure reranking if you want it. Reranking may send retrieved passages to
   its provider; it has a separate credential or can share the embedding key.
3. Use the connection test for each configured service. Tests use the current
   form values and do not save them.
4. Enable services, then **Save and apply**. Check the applied status.
5. Use **Vectorize existing documents** to generate missing embeddings for
   previously processed content when needed.

A blank saved-key input preserves the existing key. Connection success, saved
configuration and applied runtime state are separate indicators.

Changing an embedding model, endpoint or dimensions changes the vector space.
When prompted, choose whether to retain the previous space's vectors or clear
them, or cancel the change. Vectors from incompatible spaces are not mixed.

**Repair search index** rebuilds the local search index from stored vectors
without requesting new embeddings. **Vectorize existing documents** can call
the provider and consume quota. See [troubleshooting](troubleshooting.md).

## MCP connection

Local MCP is optional and disabled by default. Enable it only if a local AI
client needs access. Configure the port, apply the connection settings and
create a token with explicit knowledge libraries and permissions. Follow the
[MCP guide](mcp.md).
