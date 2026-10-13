# Runtime region contracts

Regions retain established facts and temporary state across operations that would
otherwise rediscover them. Expansion uses the existing traversal, conversion,
search, and construction algorithms. A new method or input kind must establish
the same contract before consuming retained state.

## Authority and lifetime

A captured method remains the call's authority after argument evaluation.
Mutable calls guard that actual callee; locked calls use their certified builtin
operation. Neither a property name nor a receiver constructor establishes method
identity. Realm checks also protect delayed materialization, whose prototype must
belong to the original operation's realm.

Exact callback contexts carry the callee, creation environment, canonical compiled
entry, and stable function index. Runtime image growth can replace the function
table, so contexts resolve rows through that index. Dynamically scoped contexts
belong to the fiber's execution state and restore their predecessor on return or
throw. Runtime nomination of a compiled callback supplies no numeric argument or
result facts; selected numeric adapters retain their separate guards.

String spans retain a rooted source, normalized UTF-16 bounds, and one cached
materialization per lifetime. Child spans share the source while retaining their
own bounds and observation state. Coercing arguments and unsupported observers
materialize before the original operation. Search helpers honor both window
boundaries, including when traversing ropes in reverse.

## Effects and continuation

Virtual state follows allocation identity and control flow. Unreachable uses do
not create an escape, but live joins, exception transport, and allocation-generation
backedges still require a valid lifetime proof. A runtime guard may restart an
operation only before observable work. After completed work, fallback resumes from
the corresponding state rather than replaying earlier effects.

Fixed TypedArray regions preserve memory-operation order for overlapping views.
Their induction update proves the stride; admission covers the visited index
windows. Polling publishes completed-iteration state before resumption. Fresh Array
plans use the shared builder's root and publication contract: only effect-free
initializer work can move before allocation, and references remain rooted until
the completed result is published.

## Bounded expansion

Discovery limits cover unsuccessful candidates as well as accepted plans. Shared
preparation and selection use compatible bounds, and transported plans are
independently checked against the current body. Artifact schema changes invalidate
older compiler caches.

Admission and execution counters distinguish selected metadata from exercised
paths. Semantic and memory checks establish correctness; retained matched timing
evidence is still required before claiming a performance improvement. Wider
regions must account for discovery cost, root slots, retained state, and generated
code as well as the work removed from their successful path.
