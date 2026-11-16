# Bailian HTTP connection reuse

Measured on 2026-10-24 on Windows, Zotero 10.0.6 / Gecko 140.17.0, using one isolated instance and Bailian endpoints. The existing transport reuses HTTP/2 connections through Gecko.

## Implementation and measurement

`ModelGateway` retains one `BrowserParseTransport`. Requests use the main window's `fetch`; Gecko owns the connection pool. A request-specific AbortController controls cancellation and timeout, not a separate HTTP client or socket. Creating another transport object still uses that pool.

`http-on-modify-request`, `nsIHttpChannelInternal` and `nsITimedChannel` supplied connection metadata and PRTime timestamps. A temporary HTTP activity observer exposed endpoint fields; all observers were removed afterward. The production transport read complete responses and validated provider output. No application configuration or global network preference changed.

| Observation | Result |
| --- | --- |
| First embedding request | DNS 3.342 ms; TCP approximately 23.366 ms; TLS 77.134 ms; complete request 291.293 ms |
| First rerank request | Same connection; no new connection/TLS timestamps |
| Subsequent measurements | 72/72 successful; all HTTP/2, same local TCP port, no new connection/TLS timestamps |
| Coverage | Retained transport, a new transport per request, and a connection-flag diagnostic; embedding and rerank alternated |

The socket endpoints, HTTP/2 protocol and absent new connection timestamps jointly support reuse. Gecko reports unavailable timestamps as zero; the controller converts these to `null`, rather than claiming a measured zero-millisecond handshake. The initial observed new connection did not follow a DNS/TLS/system cache reset and is not a fully cold-cache sample.

## Alternating measurements

Each operation/path had twelve samples. Path order rotated each round, and embedding/rerank order alternated. Request starts were at least 1100 ms apart to exclude the default 60 requests/minute queue. Two initial warmups are excluded below.

Times include transport, complete response reading, JSON parsing and provider validation. They exclude gateway rate/concurrency waits, local retrieval and UI work. P50/P95 use nearest rank; SD is population SD. With twelve samples, P95 is the maximum; small cloud-latency differences cannot be established from this sample.

| Operation | Transport lifetime | n | P50 ms | P95 ms | Mean ms | SD ms | Min–max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Query embedding | Retained, production | 12 | 187.09 | 310.47 | 202.67 | 58.86 | 122.93–310.47 |
| Query embedding | New per request | 12 | 153.59 | 439.56 | 185.98 | 82.70 | 135.68–439.56 |
| Rerank | Retained, production | 12 | 122.60 | 274.42 | 143.06 | 56.24 | 94.57–274.42 |
| Rerank | New per request | 12 | 119.13 | 175.77 | 124.23 | 20.96 | 98.41–175.77 |

Neither lifetime caused new handshakes. Variation does not establish a connection-reuse benefit or prove that new objects are faster. The retained production object remains appropriate. Most remaining request time lies between sending and first byte, a mixture of networking, gateway queueing and model execution that local timing cannot separate.

## Ineffective diagnostic control

An additional 24 requests used `LOAD_FRESH_CONNECTION` in `http-on-modify-request`, recorded as `fresh-connection`. They still used the same HTTP/2 connection and cannot represent forced new connections, cold startup or repeated handshakes. They are excluded from the table: only 48 of the 72 requests compare transport lifetime. This records the flag's failure at this hook and in this environment, not universal Gecko behavior.

The default controller compares only the two lifetimes. `--probe-fresh-flag` adds the diagnostic, which requires actual new socket/handshake evidence before interpretation. No global connection clearing was performed.

## Implications and reproduction

An extra plugin-specific connection pool is unnecessary. Fetch `keepalive` controls request survival after document unloading; it does not enable pooling. HTTP/2 does not require a manual `Connection: keep-alive` header. No HTTP acceleration change was retained. Provider queueing, cache hit rate, rerank input size, SQL and evidence assembly remain separate analysis opportunities.

Configure the isolated plugin with Bailian default embedding/rerank models,
768 dimensions and valid Login Manager credentials. The controller reads only
that plugin configuration inside Zotero; it never reads another project or
returns keys to Node. Separate embedding/rerank keys are supported. Then use:

```powershell
$env:ZOTERO_DEBUG_PORT = "12456"
node scripts/verify-model-http.mjs
# Optional: verify actual socket/timing evidence before interpretation.
node scripts/verify-model-http.mjs --probe-fresh-flag
```

The default issues 50 real Bailian requests, including two warmups; diagnostic mode issues 74. These consume provider quota. Wait for the asynchronous JSON report's terminal `status` before restarting the instance. Outputs remain ignored. The controller does not change production settings or introduce a Node/Python runtime proxy.

References: [Gecko ESR140 nsITimedChannel](https://github.com/mozilla-firefox/firefox/blob/esr140/netwerk/base/nsITimedChannel.idl), [nsIHttpChannelInternal](https://github.com/mozilla-firefox/firefox/blob/esr140/netwerk/protocol/http/nsIHttpChannelInternal.idl).
