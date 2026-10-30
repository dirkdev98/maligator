# AOT to C

Maligator compiles JavaScript to standalone native executables so applications can
ship without a Node.js installation. A TypeScript compiler keeps language analysis
accessible while C provides the native toolchain and FFI boundary.

## Decision

The compiler emits C and links it with Maligator's native runtime. Semantic
analysis, Core SSA optimization, and target lowering preserve JavaScript behavior;
the runtime owns dynamic values, closures, garbage collection, and host integration.

The [VM and program-image contract](02-vm.md) defines shared runtime ownership.
[Native SSA lowering](native-ssa-lowering.md) defines the independent native target
and its storage, call, and root-publication contracts.

## Consequences

The compiler and runtime span TypeScript and C, so changes across that boundary
need explicit representation and lifetime contracts. Generated code retains source
positions and profiling support for debugging native execution.
