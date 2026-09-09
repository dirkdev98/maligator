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
callback's `caller` are excluded. A resolved property or call does not by itself
eliminate an object; consumer demands and current virtual state determine whether
its representation can disappear.

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

Constant evaluation uses the `mal-binary64-utf16-i128-unicode17-v3` target contract.
Portable folds cover certified binary64 arithmetic, exact number formatting, UTF-16
code units, and the runtime's bounded 128-bit BigInt semantics. Work and output bounds
leave expensive operations at runtime. A required runtime exception is never reported
as a compiler error. General transcendental functions, time zones, and locale services
require their own target certificates.

Case conversion and normalization use Unicode 17.0.0 tables generated for both
TypeScript and C from the same checksum-verified Unicode Character Database files.
Run `node scripts/generate-unicode-data.ts <ucd-directory> <output-directory>` with
`UnicodeData.txt`, `SpecialCasing.txt`, `DerivedCoreProperties.txt`,
`CompositionExclusions.txt`, and `PropList.txt` from the official 17.0.0 distribution.
The generated `unicode-data.ts` belongs in `src/compiler/shared`; `unicode_data.h`
belongs in `runtime/src`. The data license is retained in `runtime/vendor/unicode`.
Updating Unicode requires reviewing the contextual rules and bumping the evaluator
contract; the generator rejects unrecognized special-casing conditions.

Both implementations preserve lone surrogates, canonical composition exclusions,
Hangul composition/decomposition, stable combining-class order, and full case
expansions. Final sigma and Lithuanian/Turkic contexts inspect the original input.
The runtime bounds long combining runs with stable class buckets; the compiler
abandons work exceeding its evaluation budget.

The current runtime default locale is `en-US`, recorded in the constant-evaluation
target. Nonlocale transforms and default-locale case conversions can fold under that
certificate. Prepared `tr`, `az`, and `lt` case calls select the corresponding mapping
only when the target enables Intl. Generic locale calls retain full locale-list
validation and receiver coercion order. Catalog proofs separately check the target's
feature availability, including the value reached through a protected global binding.

String collation plans retain their raw locale tag and flat ICU option bits in the
shared runtime image. They require a constant locale and complete private option data;
option specialization also requires primitive receiver/argument coercions to exclude
reentrant mutation. Native code performs those coercions before target-side locale
validation, then uses a 16-entry thread-local cache of immutable ICU plans. The cache
owns no VM references and is scoped to the linked ICU data. The shared operation takes
only the compared values, so private options do not materialize. Ignored property
initializers and extra argument effects remain. The Number result feeds downstream
primitive consumers without boxing. Dynamic observed options, getters, unsupported
plans and mutable primordial identities use the generic implementation. Both backends
retain receiver/argument coercion before target locale validation. Wire loading checks
the ASCII locale, option bits and registers; packed option bits preserve the 20-byte
VM instruction layout.

Primitive-string parsing shares the runtime's UTF-16 parsing kernels. Numeric radices
and BigInt widths use direct numeric entries, guarded when their registers remain
boxed. Nonprimitive inputs retain ordered coercion through the known operation.
BigInt width validation precedes conversion of the value, including width zero;
unchanged primitive results reuse their immutable cell. Valid numeric radix paths
still check the receiver brand. Coercing global `isNaN`/`isFinite` use native predicates
only for proven or guarded numbers, independently of the noncoercing Number methods.

Certified builtin failures become a no-input `builtinError` operation at the original
source position and exception edge. The native and interpreted backends allocate a
fresh error using a shared checked identity/message table. Argument expressions and
earlier observable conversions remain; unused input objects can disappear. Earlier
unknown coercions prevent selection. The compiler never throws the JavaScript error
during compilation. Runtime wire version 47 and compiler artifact version 73 encode
these errors and prepared collation directly, replacing the native-only annotations.

The materialization pass discards bounded private initializer writes after proving
that the aggregate has no content or identity observer. It retains computed-key
coercions at the original write and rejects array length writes, nonconfigurable
definitions, handler storage and escaping aliases. A proved non-Number element in a
private sum array uses the same error operation only after the default iterator and
absent iterator-return proofs discharge iteration and closing.

Primitive brand proofs also select failed numeric/string conversions and wrong
receivers. They stop at an earlier unknown coercion, range validation or symbol
protocol; invalid later arguments cannot replace that earlier work. Null receiver
failures retain each String method's target diagnostic. Number and String constructor
conversion failures additionally require a proved ordinary constructor target.

Repeated primitive calls can share a completed value within one basic block when
all observed inputs have immutable primitive semantics. The first call and every
argument expression retain their original evaluation position. Calls with user
coercions, callbacks, entropy, registry creation, locale state, or fresh object
results do not use this rule. Suspension clears the available-value set. Unused
calls are removed only after a separate proof that they cannot throw; immutable
constant descriptions distinguish bit patterns and never merge fresh symbols.

Static plain-string replacement computes bounded UTF-16 match positions and emits
ordinary runtime calls to a proven callable replacement. Each call receives the
match, position and source with an undefined receiver; its result undergoes ToString
before the next callback runs. Argument expressions remain before the replacement,
and callback or conversion failures retain the original exception destination.
Unknown search values and callbacks keep the runtime protocol path. No application
callback executes in the compiler.

Math folding distinguishes specified special cases from approximated finite results.
Zero, infinity, NaN and domain branches are evaluated without invoking host libm;
general transcendental results remain target operations. Number exponentiation and
`Math.pow` share the same certified cases. A number raised to a zero exponent can
lose the power operation after its producer effects, and one-argument numeric
`hypot` becomes absolute value through the normal representation pass.

`Math.sumPrecise` consumes dense private numeric arrays when the locked-world proof
establishes the default array iterator and its `next`/`return` behavior. Constant
inputs use a bounded exact binary accumulator and one ties-to-even rounding, including
overflow cancellation and signed zero. One or two dynamic Number elements reduce to
their SSA values and a single addition; their producer effects remain in order.
Three through 64 Number elements use a bounded `preciseNumberSum` operation shared by
native and interpreted execution. Its raw numeric operands feed the runtime's exact
accumulator without an input JS array. The wire loader validates the operand count
and every register before accepting side data; accumulator allocation failure remains
a throwing operation with ordinary GC and exception bookkeeping.
Unknown elements, accessors, larger arrays and unproved iterators retain runtime
iteration. Proven non-Number entries, including unshadowed holes, retain argument
effects before a residual TypeError.
Primitive type facts with unknown contents retain operand bindings in aggregate
descriptions rather than becoming constant members.

Constant numeric unary results reuse those same certified facts, allowing their dead
argument work to disappear after a builtin folds. Protected immutable global data
bindings resolve to catalog references under the locked-world proof; mutable reads
retain lookup. Neither rule suppresses unknown coercions or failed conversions.

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
wire version 45 and compiler artifact version 67 reject older representations.
Region plans use absent producer markers when normalization has removed a property
or intrinsic load, and validate the remaining operation identity and operands.

To regenerate bindings, capture a full inventory and supply its explicit callback
manifest to the generators:

```sh
node scripts/primordial-inventory.ts full .cache/primordial-inventory
node scripts/generate-known-operations.ts
node scripts/generate-known-native-entries.ts .cache/primordial-inventory/native-bindings.json
```

## Materialization and virtual state

Consumer plans distinguish metadata, contents, mutation, aliases and identity/storage
exposure. Child escapes propagate to containing recipes. Unknown calls, captured
aliases, reflection, callbacks and suspension retain fresh identities. Description
interning shares immutable recipe words; it never merges fresh runtime identities.

Bounded private ordinary arrays and objects can keep local writes, deletes, length
changes and certified push/pop operations in virtual cells. This transfer is limited
to 64 cells and 4,096 instruction visits per pass. Constant keys, ordinary writable
data descriptors and inherited-property absence proofs are required where relevant.
The existing scalar replacement and SSA passes handle compatible branch and loop
values. Other joins, handlers and suspension retain or reconstruct runtime storage.
Unsupported internal slots remain with their owning operation families.

At an observation boundary the compiler reconstructs the current state under the
original allocation token. Arguments and coercions keep their original evaluation
positions. Unknown keys, descriptors, cycles and observable calls stop the local
transfer; the compiler does not replay effects to enter the ordinary runtime path.
Handler-visible objects remain materialized so partial mutations are visible in
catch/finally. Escaping aliases share one instance per dynamic evaluation.

Primitive `includes` can use a short comparison chain for at most 16 entries with a
proven offset, or `queryStaticData` over an immutable table for up to 32,768 entries.
Own-property queries can scan a complete private key table without constructing
property values. Producers with observable effects still run. Dynamic offsets and
keys retain `ToNumber`/`ToPropertyKey`, exceptions and GC roots; an empty includes
table skips offset coercion. Tables use bounded scan code and pooled string/BigInt
references, with direct numeric comparison for compact int32 words.

Private read-only consumers that still need runtime storage can select lazy cached
templates. Generated C checks the current VM's slot inline and calls construction
only on a miss. A VM retains at most 32 cached graphs, each compiler-selected recipe
bounded to 16,384 words; FIFO eviction clears the owning realm's slot. Live aliases
remain independently rooted. Strings, BigInts and recipe words belong to the image;
the retention bound covers materialized graphs, not the immutable program image.
Fresh instances use the same recipe storage without a cache slot. The runtime's
mutable backing stores are owned, so these choices introduce no copy-on-write layer.

Construction roots the result and active parent frames, polls during deep graphs,
preserves allocation exceptions and publishes a cache slot only after success.
Static queries root coercible operands and refresh image data after calls and GC
safepoints. Wire loading validates primitive table payloads and operand bounds;
merging and adoption relocate template references. Interpreter instructions keep
the 20-byte ABI by storing query metadata in the instruction side-data pool.

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

Schema 2 groups decisions with identical evidence across explicit profile/axis
lists. Validation expands their Cartesian product and rejects overlapping cells;
grouping does not change the obligations. Implemented cells name a source entry and
a positive witness, and every decision names a boundary witness. Parameterized
witnesses can identify their exact source case. The checker verifies those source
references and reports decided and pending counts by task:

```sh
node scripts/check-static-value-coverage.ts --wave F --out .cache/static-values-f/coverage.json
node scripts/check-static-value-coverage.ts --wave F --closure --out .cache/static-values-f/closure.json
```

`--task F-01` selects one task; repeated task selectors and `--wave` are additive.
Closure applies only to the selected tasks while validating the complete inventory
and every supplied decision. A failed closure writes its report and exits nonzero.
The report is a source-evidence index; the relevant test runs remain necessary.

Instance-property seeds identify an observed constructor result and name positive
and escaping/coercion witnesses. They do not add invented installed descriptors to
the primordial graph. Reconciliation validates the constructor identity, task,
exposure reference and witnesses; its optimization cells still need closure.

Math and Number constant descriptors and well-known Symbol descriptors have explicit
constant-read, repeated-read and unused-read witnesses, with mutable lookup boundaries
and native primitive/wrapper checks. For the all-static read profile, state mutation
and callback/iteration axes are inapplicable: these own data descriptors yield
immutable primitives without invoking a protocol. This classification does not apply
to wrappers, symbol registry operations, or other profiles of these exposures.

Contained String wrappers also disappear for fixed numeric index reads, including
negative zero and absent indexes. Conversion remains at construction, and index
reads use the primitive string. A key coercion that exposes the wrapper, or an
escaping result whose descriptors can be inspected, retains the String object.

Fresh Symbols consumed only through their descriptions or descriptive strings can
carry the converted description directly. The bounded use walk rejects identity
escapes. An input that may be undefined branches before ToString and rejoins with
the description plus its textual form; an absent description stays undefined for
the getter and uses an empty string inside descriptive text. ToString stays at
creation, before later effects and observations, with the original exception
handler. Registry operations keep their runtime identity.

Mutable Number formatting retains the property Get and all argument evaluation.
Native and interpreted calls guard the captured native callback, current realm,
primitive Number receiver and valid numeric option before entering the existing
exact formatter. Native emission validates constant options ahead of time and
passes their unboxed values to that formatter. A failed guard performs no work
and the original callee receives the original arguments once. Foreign callees,
wrappers and coercing or invalid
options use ordinary dispatch, preserving error realms and coercion order.

Mutable Number predicates guard the captured native callback after all arguments
have been evaluated. The existing noncoercing kernels return a Boolean without
allocation, exceptions or realm state, so callback identity also admits functions
from another realm. Native numeric operands use the corresponding finite, NaN or
integer test; boxed operands use the same inline noncoercing kernels. A failed guard calls the captured function with the original receiver
and full argument list; its result remains unconstrained.

Known noncoercing Number predicates consume contained primitive wrappers without
materializing them and return false. Strict self-comparisons retain object identity
semantics even when a Number wrapper contains NaN. The bounded use walk validates
every consumer before replacing any result; escaping identities and unknown calls
retain their objects. Constructor conversion stays at its original position, so
user coercion and exceptions precede later argument evaluation. Ignored predicate
receivers and extra arguments need no wrapper identity, but their producer effects
still execute. String construction retains ordinary ToString, including its Symbol
exception, and exact constructor/newTarget proof excludes subclass construction.

Under the locked single-realm contract, contained wrappers also supply primitive
payloads to arithmetic, relational and numeric update operations, and to exact
Boolean, Number, String, BigInt and global numeric-predicate conversions. Conversion
of the original constructor argument still precedes later operand expressions;
other operands retain their own coercions. Equality and identity-sensitive consumers
do not use this substitution. Boolean observes the wrapper's truthiness, and String
on a Symbol wrapper becomes ordinary ToString at the consumer so the Symbol error
survives. Own coercion overrides, mutable prototypes and escapes retain their objects.
The same proof permits the shared numeric Math unary operations and exact atan2,
pow, imul, clz32, hypot, min, max and f16round calls to consume primitive payloads.
Every consumed argument retains ToNumber, including Symbol and BigInt exceptions;
ignored arguments retain expression effects. Nonfinite inputs do not skip later
coercions in variadic methods. Iterator consumers such as sumPrecise remain outside
this numeric-argument proof.

Public global names use the global environment unless an immutable binding proof
permits intrinsic loading. NaN and Infinity are permanently non-writable and
non-configurable; compiler-private operations remain intrinsic. Mutable constructor
replacement, accessors, deletion and assignment therefore observe the current global
binding. Optimizations requiring an exact constructor remain restricted to a proved
intrinsic; a global name alone does not establish that identity. The embedded eval
compiler explicitly enables intrinsic global reads for its own implementation.
This does not freeze properties or grant immutable-binding facts, and the mode is
not propagated to the user source it compiles. Replacing a public constructor or
globalThis therefore affects dynamic user code without redirecting compiler internals.
Existing entry-pair regions admit constructed iterator sources through their exact
runtime cursor guard; they do not require an immutable public constructor binding.

Canonical function comparisons use the inventory's object identity, independently
of native callback sharing. This folds repeated references across effects while
keeping String valueOf/toString and Symbol valueOf/toPrimitive distinct. True aliases
such as trimLeft/trimStart retain their shared identity. Mutable property reads keep
lookup and observe replacement; escaped method values retain the actual runtime
function objects.

Rejected primitive construction has explicit per-target witnesses for runtime
TypeError, preserved argument effects, earlier argument exceptions and fresh thrown
errors. For the all-static construction profile, ordinary constant results and
target-owned state updates or callback/iterator execution are inapplicable because
construction is rejected. This does not classify normal calls, mutable targets,
argument producers, or error-object materialization as inapplicable.

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
