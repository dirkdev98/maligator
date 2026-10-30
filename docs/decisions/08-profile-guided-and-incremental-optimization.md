# PGO and persistent Core reuse

Profile-guided optimization and persistent optimized Core modules added training,
validation, serialization, and scheduling policy without establishing enough
representative benefit to justify their cost.

## Persistent Core reuse

Persistent Core serialization, receipt storage, module import, and resumable
optimization recipes are retired. The opt-in Core cache made compilation harder
to reason about without a repeatable net rebuild benefit on application edits.
Exact frontend, dependency-fragment, and generated-object caches retain their own
boundaries; see [native builds](../native-builds.md).

A future persistent IR design needs a new ownership and invalidation contract and
measured net benefit on representative application edits.

## Profile-guided optimization

VM training counters, PGO capture and merge, profile-based Core hints, separate
hot and unknown budgets, and their CLI and wire contracts are retired. Training
and validation did not establish a representative net benefit sufficient to
support the additional optimization policy.

Ordinary Core transforms and diagnostic `--profile` recording remain available.
A future profile-directed design needs a new measurement and ownership contract.
