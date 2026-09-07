# Private literals and native entry reachability

Static literal trees can share storage when no consumer can mutate them or expose
their identity. Core encodes nested arrays and objects in the existing literal
template format and assigns each reusable root a private global slot. The runtime
constructs the tree on first evaluation, publishes it only after construction, and
keeps it rooted for the VM lifetime. Primitive values already use immediate operands
and constant pools.

The locked primordial contract allows Core to resolve prototype methods for literal
string, number, boolean, bigint, array, and object receivers. Own properties retain
precedence. The shared method registry supplies both compiler identities and runtime
lookup metadata, including symbol-keyed iteration methods. Calls retain all arguments
and use the ordinary native-call contract for coercion, exceptions, and GC rooting.
Mutable primordials and multiple realms do not admit this rewrite.

Method resolution and storage reuse have separate proofs. Mutation and callback
methods can have a known callee while still needing a fresh receiver. Methods that
return elements require fresh nested objects; methods that return the receiver also
prevent reuse. Read-only observations can share an entire nested tree. Construction,
escape, handler, and control-flow uses must all satisfy the proof before any allocation
is replaced.

Function identity likewise remains separate from executable entry points. In a closed
source graph, Core proves when all private callable uses are covered by selected typed
entries. Namespace and host exports, generic calls, and escaping function values keep
generic execution reachable. Plan verification checks this proof against the sealed
program.

Native emission then checks actual call selection in every emitted caller variant.
Unavailable compilation or typed arguments retain the required canonical entry. When
every reachable call selects a typed entry, both the canonical C body and its bytecode
are omitted from the native image. Function identity and diagnostic metadata remain.
Interpreted images and relocatable overlays retain their executable bodies.
