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

The source registries define the current division. Remaining consolidation belongs
in [TODO.md](../../TODO.md#compiler-infrastructure), rather than a second registry
of proposed pass names. The [Core storage contract](04-core-storage-and-optimizer.md)
defines mutation versions, analysis lifetime, and specialization ownership.
