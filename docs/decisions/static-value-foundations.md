# Static value foundations

Static descriptions describe data and construction recipes. They never grant a
runtime object identity. `CoreProgram.staticDescriptions` interns this metadata;
`CoreStaticValueAnalysis` owns the function-local SSA bindings and allocation
identities. A fresh allocation identity is per evaluation, including each recursive
call and loop iteration. A realm-pool identity explicitly denotes existing shared
literal materialization. Equal descriptions cannot establish object equality.

The analysis is queried from existing transform candidates and uses existing Core
use/definition and CFG data. Dynamic leaves remain ordinary SSA operands. Results
record the function and program data versions; verification rejects stale facts,
dead bindings and bindings that do not dominate a consumer. Recursive queries widen
to unknown; local cyclic object edges retain their original SSA identity bindings.
The default work/depth bounds are 65,536 visits and 128 recursive queries. Initial
allocation facts describe construction, not contents after subsequent writes. The
literal pass still proves containment and instruction ordering before reuse.

## Discovery and propagation

Array descriptions store sparse own descriptors separately from length. A missing
index differs from an own `undefined` value; the literal wire format gives each its
own tag. Unknown members and incomplete contents remain explicit. Object keys retain
ECMAScript enumeration order, descriptor flags, symbol identities and prototype
edges. Nested data shares descriptions while retaining separate allocation bindings.

`queryAt` replays relevant private initialization and writes up to an observation.
Unknown writes, escapes, exceptional edges and loops widen contents conservatively.
SSA joins keep common fields, with a phi discriminator for alternative allocations.
Private global and captured cells use the existing single-assignment and memory
analyses. Cross-function forwarding requires a dominating TDZ check, one initializer,
and an audit of every read for mutations or escapes. The program owns the cell index across function sessions. It refreshes changed
functions and shares a bounded proof budget, borrowing analysis access from the
current session without retaining that session's caches. Lexical blocks in try/catch/finally retain their TDZ initialization.

Certified constructors and factories retain brand, prototype and construction
arguments without claiming dynamic contents are constant. Ordinary calls, construction
and alias-returning `Object` calls have separate contracts. Mutable constructors and
unproved subclass/new-target behavior keep their runtime operations.

Ordinary property consumers fold own data, lengths, presence, descriptors and brand
queries. Bounded dynamic keys use one `ToPropertyKey` followed by known-key selection
and the original fallback lookup. Prototype-dependent results require the shared
primordial proof; missing methods still evaluate arguments before throwing.

Known-call specialization reuses existing target/effect summaries and candidate
budgets. A non-inlined helper can consume a complete private array/object description
through constant own reads or certified `includes`, while its original callable body
remains available. Signatures share variants, capped at four per target. Recursive,
escaping, identity-sensitive and unsupported signatures retain normal calls and
materialization. Sloppy helpers that can expose their function identity through a
callback's `caller` are excluded. General virtual returns and demand-driven allocation
remain later work; a resolved property or call does not by itself eliminate an object.

`builtin-registry.ts` exports the shared primordial graph, literal entries and
invocation summaries. The native descriptor audit supplies canonical object and
symbol identities, alias groups, getter/setter halves, descriptors and prototype
edges. Invocation summaries are separate from descriptor metadata: a readonly
receiver does not imply an effect-free operation. Coercions, property reads,
callbacks, writes, retained aliases, fresh results and environmental dependencies
remain separate obligations. Existing entry-point descriptors retain ABI metadata.

A lookup proof needs locked primordials, a known current-realm prototype chain,
complete own-property evidence and stability through the read. A brand by itself is
insufficient. Eval/source closure and mutable host bindings grant no additional
primordial authority. Lowered Core operations carry world dependencies verified by
the existing IR verifier. Program-wire and compiler-artifact versions change with
this contract; no legacy reader is retained.
Runtime archive and generated-object cache identities include generated `.inc`
tables alongside source/header inputs, so a registry edit cannot reuse stale
dispatch or intrinsic definitions.

Constant evaluation uses the `mal-binary64-utf16-i128-v1` target contract. Portable
folds cover certified binary64 arithmetic and UTF-16 code units. BigInt arithmetic
checks signed-128 bounds before evaluation, including when the compiler itself runs
on Maligator. Unsupported operations and exhausted work budgets retain runtime work.
The evaluator can describe a required runtime exception; it does not report it as a
compile error. Locale, timezone, Unicode-data-dependent transforms and general
transcendental functions require separate target certification.

## Known operations

An exact callable identity becomes `callKnown` independently of receiver storage.
The operation carries its canonical catalog identity, receiver or `new.target`,
arguments, invocation mode and world dependencies. `loadPrimordial` preserves a
captured identity when it is also used as a value. Resolution requires the locked
primordial and realm contract, including the receiver's actual prototype chain and
own descriptor. A brand alone does not authorize bypassing a property lookup.

Canonical `call`, `apply`, `bind` and Reflect adapters use the same operation.
Argument-list modes distinguish nullable Function `apply`, strict array-like lists,
array spread and iterable spread. Normalization preserves argument evaluation,
constructor validation order and the captured callee. A changed or unproved adapter
retains ordinary dispatch.

The operation's default effects remain conservative. Exact collection, numeric and
string/RegExp region proofs may refine or specialize it. Bounded static `includes`
lowers to boolean operations only after proving indexed reads and offset conversion;
this permits ordinary DCE without dropping callbacks or coercions. Native numeric
representation selection recognizes the known-call boxing boundary. Static numeric
payloads use binary64 unless an int32 encoding preserves the value, including its
zero sign.

Native callback bindings are generated from a live descriptor capture and the owning
C definitions, including their feature guards. Generated wrappers enter through
`mal_vm_call_known_native` and the existing exact-native call/construct frames. They
retain callee metadata, roots, arguments, completion handling and constructor checks.
The interpreter resolves the same operation through the current VM's primordial
bindings and ordinary engine entry route. No compiler-host heap pointer is embedded.

`CALL_KNOWN` replaces the former exact-builtin and literal-method wire tags. Runtime
wire version 44 and compiler artifact version 66 reject older representations.
Region plans use absent producer markers when normalization has removed a property
or intrinsic load, and validate the remaining operation identity and operands.

To regenerate bindings, capture a full inventory and supply its explicit callback
manifest to the generators:

```sh
node scripts/primordial-inventory.ts full .cache/primordial-inventory
node scripts/generate-known-operations.ts
node scripts/generate-known-native-entries.ts .cache/primordial-inventory/native-bindings.json
```

## Native inventory and coverage

Run the environment probe first. Capture each mode exported by
`scripts/primordial-inventory-config.ts` into one directory:

```sh
npm run env:check -- --json
node scripts/primordial-inventory.ts full .cache/primordial-inventory
```

Repeat that capture for every listed mode, then regenerate the shared graph and
coverage ledger:

```sh
node scripts/generate-primordial-catalog.ts .cache/primordial-inventory
node scripts/generate-static-value-coverage.ts maligator_static_values_backlog.json
npm run test:unit -- --run tests/primordial-catalog.test.ts
npm run test:unit:full-only -- --run tests/primordial-inventory.test.ts
```

The matrix records both language initialization and host installation, including
individual Intl services and diagnostic installers. Raw JSONL retains every native
record. Normalized records retain duplicate-key anomalies explicitly. Mutable host
primitive values are runtime data, not compiler constants. Host graph snapshots are
target-specific; a new target needs a native audit. Source installer fingerprints
make an unaudited installer edit fail the normal unit lane.

Every discovered descriptor receives a coverage row and an owning later slice.
Every axis/profile cell remains pending until it has the appropriate positive and
negative witnesses. Resolved/direct dispatch does not prove input allocation
elimination. Budget bailouts, missing support and blanket runtime-only labels are
not semantic inapplicability. Generation preserves existing decisions by exposure
identity. Closure validation rejects pending cells and unreconciled seed obligations.

## Baseline measurement

```sh
node scripts/static-values-baseline.ts .cache/static-values-baseline
```

This writes function-scoped Core, execution IR and C for `includes` and absent
`includex`, with observed and unused results in separate functions. It also records
normal/profiled compiled/interpreted native execution, output parity, GC/allocation
counters, native toolchain/configuration, compile samples and generated sizes.
`bench/static-values.mjs` supplies never, cold and hot execution modes. Keep the
result directory when comparing revisions; never infer allocation elimination from
a discarded result or from a direct call alone.

For paired compiler translation measurements, capture each revision with
`npm run bench:self-compile-experiment -- capture <directory>`, then inspect and run
the comparison using the same two capture directories:

```sh
npm run bench:self-compile-experiment -- compare <base> <candidate> --output .cache/static-values-compare --host native --workload parser --pairs 5 --budget-seconds 600 --plan=json
npm run bench:self-compile-experiment -- compare <base> <candidate> --output .cache/static-values-compare --host native --workload parser --pairs 5 --budget-seconds 600
```

Use a separate output directory with `--host node --workload full` for Node-hosted
translation. The runner alternates paired samples and checks every generated output
against its frozen Node oracle. Report native compiler build time separately from
translation. For application measurements, run both captured binaries with the same
`never`, `cold` and `hot` arguments, warm each once, then alternate execution order
for at least five pairs. Keep stdout checksums, process resource reports and the
`MAL_HOST_GC=1 MAL_GC_STATS=1 MAL_PERF_STATS=1` allocation/retention probes.
