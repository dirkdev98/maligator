# Platform catalog and execution context

Status: accepted. Initial implementation: `execution` from `maligator:process`.

## Public contract

Maligator APIs are ordinary JavaScript APIs first. Adopt established JavaScript and
Web conventions where they fit. Native capabilities carry explicit compiler
contracts; static knowledge improves generated code without changing runtime
semantics, except for explicitly declared compile-time operations.

The platform catalog owns module identities, exports, value and operation
contracts, effects, types, and public documentation. Generate declaration files and
website reference content from it. Compiler resolution, immutable-value knowledge,
and import evaluation policy consume the same catalog. Do not duplicate these
contracts in optimizer-specific name matches or handwritten declaration files.

Registered `maligator:` modules have no externally observable import-time effects.
Static imports, re-exports, and dynamic imports share export identities. Unused
modules retain no installer or native implementation dependencies; reachable
operations retain their effects. Namespace reflection or escape can require all
observable exports. Runner bootstrap work belongs to explicit initialization,
outside public module evaluation.

## Execution description

`execution` is one deeply frozen JavaScript data object per application context.
Its command, explicit production intent, application backend, optimization policy,
target, normalized command options, and resolved public configuration are fixed
before application compilation. A built executable retains `command: "build"`;
application code is not executed during its compilation. Profiling selects full
optimization and can select native compilation without changing production intent.
Runtime arguments, environment, working directory, and process identity are not
static execution fields.

The catalog documents every field, default, applicable command, and static
guarantee. Public options omit compiler diagnostics, output paths, and scheduling
controls. Configuration describes requested policies, never the implementation
features left after tree shaking. Missing flags are normalized before compilation;
an automatically chosen test shuffle seed is chosen exactly once.

Compiler constants and runtime objects derive from the same validated description.
Known own-property reads, import aliases, re-exports, immutable aliases and
destructuring, primitive comparisons, boolean operations, and conditional branches
specialize in both development and full pipelines. Unknown property keys and opaque
calls keep ordinary runtime behavior. Frozen objects retain their observable shape,
identity, and descriptors when they escape.

Application fragments share a context; the compiler or CLI host does not supply
its own context accidentally. The versioned description participates in every
affected compilation cache identity. A backend-changing fallback must reconstruct
the description before recompilation. Internal wire and cache changes invalidate
old artifacts rather than adding compatibility readers.

## Asset boundary

This change prepares reachability for statically declared assets; it does not add
asset producers, frontend process management, `maligator:http`, or a replacement
asset API. Future asset collection consumes the specialized program, so an
unreachable declaration does not require its source files to exist.

## Verification

During implementation, use tiny compilation inputs, generator checks, focused
contract tests, and isolated declaration consumers. Defer runtime rebuilds, native
link checks, broad type/lint checks, and the normal developer gate until other
heavy work has finished and a fresh environment/activity probe permits them. Keep
pending verification in `TODO.md`; do not treat structural checks as native runtime
or native dependency-elimination evidence.
