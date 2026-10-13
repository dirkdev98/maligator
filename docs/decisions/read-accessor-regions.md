# Class read-accessor regions

Core lowers bounded class read accessors into admitted read regions before memory
optimization. The function effect summary describes a chain rooted at `this`:
private data fields, named properties, indexed arguments, and an optional nullish
default. The description does not weaken the function's JavaScript effects.

Module class lowering owns private-name identity. It records the global cell and
its class evaluator; Core validates the complete writer graph, a unique
`createPrivateName` initializer, and an acyclic evaluation site. Captured and
per-evaluation private environments remain conservative. Equal private keys do
not make their field values immutable. These identities reflect the separate
private environments created by [class evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-classdefinitionevaluation).

Call specialization groups a bounded sequence of accessor calls and non-observable
work. It preserves the originally resolved callee and arguments.
Single field reads with no sharing benefit retain ordinary inlining. Summary discovery stops at its
instruction bound, and region discovery walks only its bounded neighborhood using
the existing call-site index.
Statically nonnumeric, fractional, negative, or out-of-range indexed arguments retain
their ordinary path; unknown arguments still require runtime admission.

Function identity guards also enforce the existing realm contract. Successful probes admit private
data, ordinary named data properties, and present dense array elements. Getters,
proxies, holes, unsupported keys, and other misses enter the original operations
in their original order. Earlier successful probes have no observable effects,
so replay on a miss does not duplicate JavaScript work.

For an isolated accessor without retained loop state, a miss on its final indexed
read completes with an ordinary property read from the already-resolved receiver.
No later read can reuse the admitted prefixes, so this terminal slow path can invoke
getters or key coercion without replaying the accessor. It retains normal effects,
exception edges, and GC rooting. Shared regions and retained loop paths still replay
on a miss.

Expansion reuses admitted values and function guards within its non-observable
region before constructing additional success branches. Private writer proofs
refresh after body and control-flow edits; facts and representations do not change
the writer graph or initialization control flow.

The existing memory pass forwards every result of equivalent probes, including
their success flags. Private-key equality uses the producer's validated cell
identity independently of the key load's SSA identity. Memory versions still
govern field values. A separate read lifetime ends at collection, user calls,
suspension, exceptional edges, and loop backedges; this retains required loop
polls and prevents reuse across possible re-entry. Relevant writes remain memory
clobbers. Kernel retirement therefore cannot preserve the old columns reference.

References remain boxed and participate in normal root planning. The first version
does not retain raw array backing addresses or assume stable lengths and elements.
Native and interpreted targets consume the same portable `PROBE_READ` operation;
its extra operands use side data to preserve the packed instruction ABI.
Named probes use the existing per-site property caches and their prototype
invalidation contracts. Misses resolve only ordinary data properties without
executing JavaScript; private probes retain the existing entry hint. The cache
capacity and global optimization budgets are unchanged. Native emission selects
inline probes for the known read kinds instead of dispatching through a generic
probe with unused arguments.

Core's private-name proof is consumed before serialization. Artifacts preserve the actual
guards and probes and validate their operand kinds, register bounds, and named
constant references. Wire and compiler-artifact versions invalidate older caches.

Region size and generated code are charged to existing call-specialization
budgets. The optimization recognizes JavaScript access patterns without compiler
class names or larger global inlining budgets. Structural coverage includes the
actual kernel operand and result materialization loops; native fixtures cover
mutation, retirement, method replacement, getters, private failures, defaults,
backend parity, and collection stress.

The benchmark-only `class-read-accessors` ablation disables caller expansion while
retaining summaries and ordinary inline selection. It applies when building the
measured binary, independently of the compilation settings that binary later
uses. Counter instrumentation reports bounded region visits, plan reuse, offers,
and applications; runtime diagnostics distinguish probe hits from hint/cache
miss searches. Ordinary performance measurements keep that instrumentation off.
