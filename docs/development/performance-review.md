# Performance Review Requirements

Performance changes must preserve the plugin's content, authorization, transaction
and lifecycle contracts. Passing tests or reducing query counts alone does not
establish a native speedup.

## Measurement Protocol

Use representative isolated fixtures, warmups and repeated alternating baseline/
candidate samples in the applicable Zotero runtime. Record fixture sizes, CPU/RAM,
host/runtime versions, cache conditions, accessibility activation and concurrent
work. Report elapsed distributions and variability. Separate local SQL/worker/UI
costs from parser/model network latency and exclude fixture preparation from the
timed operation.

Only retain changes with demonstrated gains and acceptable behavior across small
and larger fixtures. Investigate material regressions and independently repeat
marginal results. Complexity estimates and unused-code cleanup are different from
measured runtime improvement.

## Correctness Gates

Preserve exact scope, evidence, Unicode positions, current source/profile fences,
replay/cursor invalidation, transaction rollback and full cleanup. Deletion retains
shared memberships, recovery rights and incoming references. UI work preserves
native selection, scroll/expansion and bounded rendering.

## References

| Boundary | Measurements and limits |
| --- | --- |
| Repository and native UI operations | [Native measurements](performance-measurements.md) |
| Plugin enabled/disabled overhead | [Runtime comparison](plugin-runtime-overhead.md) |
| Database connections and mixed load | [Database concurrency](database-concurrency-performance.md) |
| MCP materialization and page reads | [MCP reads](mcp-read-performance.md) |
| Local retrieval and evidence display | [Retrieval](retrieval-performance.md), [inline rows](retrieval-toggle-performance.md) |
| Vector index recall/memory | [Vector acceptance](vector-retrieval-acceptance.md) |

Each dated measurement applies to its stated fixture/runtime, not every later
package or real literature corpus. See [project status](project-status.md) for
unaccepted scale, relevance and platform work.
