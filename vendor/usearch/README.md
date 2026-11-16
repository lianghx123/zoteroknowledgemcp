# USearch runtime

USearch v2.26.5, commit `7a4abfb2033935498256044e01bc0049ec80d76c`.
See `provenance.json` for upstream Git blob identities and `source/LICENSE`.

Local changes in `index_plugins.hpp` add an optional arena allocation ceiling.
`index_dense.hpp` applies a 32 MiB ceiling only to vector tape allocations.
Graph allocation keeps upstream behavior. `wrapper.cpp` adds scoped search,
runtime dimensions, direct JS-source restoration and bounded serializer slices.

Build with `scripts/build-usearch.ps1` using Emscripten. Generated assets in
`addon/content/vector/` ship in the XPI; no compiler or helper runs in Zotero.
The canonical Float32 vectors remain in the independent plugin database.

`build.json` uses `sha256-lf-text-v1`: text identities normalize CRLF to LF;
WASM identities hash the exact bytes. This avoids checkout-dependent failures
without accepting source or binary changes. Compilation output is unchanged.
