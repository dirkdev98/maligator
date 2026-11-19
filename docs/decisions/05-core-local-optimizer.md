# Core local optimizer ownership

Local edits should wake the rules that consume them without rescanning every
instruction for every pass. The function optimizer combines dirty opcode and block
queues with explicit function-wide transforms.

## Scheduler boundary

[CoreLocalOptimizer](../../src/compiler/core/core-local-optimizer.ts) owns local
instruction and block rules. Their edits wake dependent local work. Dead-code
removal and fact normalization belong to the edit machinery rather than separate
cleanup passes.

The [function session](../../src/compiler/core/core-function-optimization-session.ts)
coordinates those queues with canonicalization, CFG, proof, and memory passes.
Function transforms can dirty local work; they remain outside opcode and block
queues when their proofs or edits span the function. Program flow, cross-call
selection, and late recipes retain their program-level owners.

The function scheduler coalesces wakes before evaluating admission predicates
or filtering candidate sites. A rejected optional pass can wait behind pending
cleanup and reconsider the current function when it reaches the front of the
queue. Only an executed pass consumes its work and edit budgets.

Opcode gates and candidate selectors share the function's ordered opcode
inventory. Opcode changes rebuild that inventory, CFG and exception changes
refresh control features, and selector dependencies govern semantic filtering.
A pass can prepare discovery results when dequeued and use them during the same
visit. That preparation belongs to the current function snapshot.

The source registries define the current division. Select remaining scheduler
consolidation from measured repeated work in
[TODO.md](../../TODO.md#compiler-throughput-and-analysis-scalability). The
[Core storage contract](04-core-storage-and-optimizer.md)
defines mutation versions, analysis lifetime, and specialization ownership.
