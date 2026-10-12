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
work. It preserves the originally resolved callee and arguments. Function identity
guards also enforce the existing realm contract. Successful probes admit private
data, ordinary named data properties, and present dense array elements. Getters,
proxies, holes, unsupported keys, and other misses enter the original operations
in their original order. Earlier successful probes have no observable effects,
so replay on a miss does not duplicate JavaScript work.

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
its extra operands use side data to preserve the packed instruction ABI. Core's
private-name proof is consumed before serialization. Artifacts preserve the actual
guards and probes and validate their operand kinds, register bounds, and named
constant references. Wire and compiler-artifact versions invalidate older caches.

Region size and generated code are charged to existing call-specialization
budgets. The optimization recognizes JavaScript access patterns without compiler
class names or larger global inlining budgets. Structural coverage includes the
actual kernel operand and result materialization loops; native fixtures cover
mutation, retirement, method replacement, getters, private failures, defaults,
backend parity, and collection stress.
