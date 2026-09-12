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
through constant own reads or certified `includes`, `indexOf` and `lastIndexOf`, while its original callable body
remains available. Signatures share variants, capped at four per target. Recursive,
escaping, identity-sensitive and unsupported signatures retain normal calls and
materialization. Sloppy helpers that can expose their function identity through a
callback's `caller` are excluded. A resolved property or call does not by itself
eliminate an object; consumer demands and current virtual state determine whether
its representation can disappear.

Helper search variants retain sparse source indexes and distinguish strict equality
from SameValueZero. Index searches branch to the first match in their search order;
holes are skipped only after inherited indexed properties are proved absent. The
existing 64-element and per-target variant bounds apply to these expansions.
Fixed numeric, boolean, null, undefined and certified string offsets are decoded
from the helper's own SSA definitions. Unknown offsets retain the original call
and coercion; caller analysis is never queried with helper-local value IDs.

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

Constant evaluation uses the `mal-binary64-utf16-i128-unicode17-v4` target contract.
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
certificate. Constant case calls also fold for certified `tr`, `az`, `lt`, `en`,
`en-US`, and `und` tags when the target explicitly enables Intl. The evaluator and
native emission share the tag-to-mapping selection. With Intl disabled, locale case
calls use root rules and ignore locale values, while retaining argument evaluation.
Generic locale calls retain full locale-list
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
Signed 128-bit BigInt constants support exact increment, decrement, same-type
comparisons, bitwise operations, powers and bounded shifts. Powers use checked
squaring within the work budget; negative exponents and overflowing products retain
runtime evaluation. Zero exponents and bases zero or plus/minus one avoid expansion.
Negative shift counts reverse direction; large right shifts produce the sign
extension without a large host shift. Updates and left shifts outside the target
range and mixed numeric operands retain their runtime operations.
Zero-width `BigInt.asIntN` and `BigInt.asUintN` calls can discard narrowing when
the value is a proved primitive BigInt or Boolean and the shared evaluator certifies
the width conversion. Value producers remain; other value kinds keep their
conversion and errors even when the width is zero.

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
changes and certified push/pop/shift/unshift/fill/copyWithin/reverse operations in
virtual cells. Shift preserves hole positions relative to the remaining elements
and returns the original first cell. Unshift moves cells in descending order and
returns the new length;
an empty argument list performs no indexed transfer. Fill accepts certified primitive
bounds and retains its returned receiver alias. Empty pop/shift perform no indexed
deletion. Reverse preserves holes and keeps its returned receiver as an alias of
the same array. Each affected endpoint is proved before any swap is applied. This
transfer is limited to 64 cells and 4,096 instruction visits per pass. Constant
keys, ordinary writable data descriptors and inherited-property absence proofs are
required where relevant.
CopyWithin proves source reads and destination writes before transferring cells,
preserves holes through deletion, and reverses direction only for overlapping
ranges whose destination follows the source. Its native fallback uses the same
direction rule to preserve observable getter/setter order for disjoint ranges.
Direct method syntax can enter this pass before known-call lowering only when the
locked inherited resolution identifies the exact Array prototype method and every
captured method use is consumed by the completed state transfer.
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

The same primitive tables support `indexOf` and `lastIndexOf` with numeric results.
Hole tags remain distinct from own undefined values, and NaN never matches a strict
index search. A missing `lastIndexOf` offset starts at the last element; an explicit
undefined offset starts at zero. Reverse searches retain the last matching index
during a bounded forward scan of immutable data, avoiding a second offset table.
Offset coercion remains before the scan and can throw or trigger image adoption;
empty receivers skip that coercion. Wire and compiler-artifact identities change
when query kinds are added.
Constant searches fold through the same bounded scan. `includes` returns a boolean
under SameValueZero, including NaN and holes read as undefined; index searches
return original positions. Boolean, null, undefined and certified string offsets
use the shared primitive conversion. BigInt offsets retain the runtime's ToNumber
rejection.
BigInt comparisons fold only within the signed 128-bit literal range; larger
descriptions retain runtime comparison after the target's literal wrapping.
Short index searches with dynamic elements use strict comparisons and bounded
numeric index selection. They retain original positions and choose the first match
in the requested direction; holes are skipped only after inherited absence is proved.
Constant primitive tables remain available when a short comparison sequence is
ineligible or the receiver is larger than sixteen elements.

Private read-only consumers that still need runtime storage can select lazy cached
templates. Generated C checks the current VM's slot inline and calls construction
only on a miss. A VM retains at most 32 cached graphs, each compiler-selected recipe
bounded to 16,384 words; FIFO eviction clears the owning realm's slot. Live aliases
remain independently rooted. Strings, BigInts and recipe words belong to the image;
the retention bound covers materialized graphs, not the immutable program image.
Fresh instances use the same recipe storage without a cache slot. The runtime's
mutable backing stores are owned, so these choices introduce no copy-on-write layer.

Bounded `toReversed`, `with` and `toSpliced` results carry fresh array descriptions
with shallow child bindings. Proved absent indexes become own undefined elements;
replaced or removed indexes need no read. Effectful index conversion, observed
accessors and unproved inherited indexes retain the original operations. Description
expansion is capped at 256 elements. The existing virtual-state pass consumes copies
of at most 64 elements, discards unobserved results, and constructs a fresh array at
an identity observation. Canonical `Array.of` results use the same materialization
path. Producer expressions and child identities remain in their original order.

`slice` descriptions additionally prove the default species through the locked
intrinsic Array constructor, rejecting own constructor overrides. Copy bounds
accept numeric, boolean, null, undefined and certified string conversions; BigInt
and effectful object bounds retain runtime coercion. Omitted and undefined slice
end bounds use the source length. Sparse slices preserve missing properties:
materialization creates the result length and writes only present own elements.
Complete ordinary array descriptors permit this path for both sparse and dense
results.

Concat builds bounded fresh descriptions after proving default receiver species
and absent spreadability overrides on each object segment. Array segments preserve
holes and shallow element aliases; known primitive and ordinary non-array segments
append as single values. Unknown protocol reads retain the runtime operation.
Descriptor scans share a budget of 4,096 across segments and inherited-property
proofs, independently of the 256-element output cap.
Flat uses the same root species proof and follows certified depths through known
array children, removing proved holes at every visited level. At exhausted depth
it retains child identities without inspecting their array brand. Traversal is
bounded to 256 result elements, 4,096 visits and 32 nested descents; cycles, unknown
array brands and unsupported allocation recipes retain runtime flattening.

Storing an object in a distinct ordinary fresh container can expose the child
without changing its contents. Data definitions with primitive keys preserve that
snapshot; array length definitions remain a coercion boundary. Unknown subsequent
calls or writes still invalidate the exposed child's contents.

Join folds bounded arrays of certified primitive elements using target string
conversion. Holes, null and undefined contribute empty text; explicit undefined
separators use the default comma. Object and Symbol conversions retain runtime
behavior, including on empty receivers where separator conversion still matters.
Descriptor scans and generated UTF-16 text share the evaluation budget.

Construction roots the result and active parent frames, polls during deep graphs,
preserves allocation exceptions and publishes a cache slot only after success.
Static queries root coercible operands and refresh image data after calls and GC
safepoints. Wire loading validates primitive table payloads and operand bounds;
merging and adoption relocate template references. Interpreter instructions keep
the 20-byte ABI by storing query metadata in the instruction side-data pool.

Boolean, Number and String constructors can receive preconverted static inputs
while retaining their fresh wrappers and original `newTarget`. Boolean conversion
can discard private aggregate inputs; numeric and text conversion require a
target-certified primitive constant. Argument effects, mutable callees, effectful
coercions and prototype lookup retain their original runtime order.

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
node scripts/generate-static-value-coverage.ts
npm run test:unit -- --run tests/primordial-catalog.test.ts
npm run test:unit:full-only -- --run tests/primordial-inventory.test.ts
```

The tracked coverage ledger owns its seed assignments and expansion obligations, so
regeneration does not depend on workspace-only planning files.

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

Primitive function-valued descriptors, Math and Number constants, and well-known
Symbols have own-read witnesses across effects, escape, loops and suspension, with
mutable lookup and native proxy/coercion boundaries. The proved ordinary data read
has no invocation, exceptional outcome, fresh input or result allocation, state
update, callback, iteration or payload preparation. Those axes are inapplicable for
the static-observable, escaping-identity, large-recursive-loop and
environment-state-gc-suspension read profiles. Receiver/key producers, caller control
flow and replaced/proxied descriptors retain their effects and exceptions. Reading
a function value does not invoke it; wrappers, registry operations and callable
invocations keep their separate obligations. Constant, repeated and unused reads
retain their own implementation witnesses.

`Reflect.get` shares descriptor resolution when its target is a proved canonical
object and its key is fixed. Data reads preserve argument evaluation and reuse the
installed value; accessor calls use the explicit receiver, defaulting to the target
only when it is absent. Primitive targets, proxies and effectful keys keep runtime
validation and conversion. The adapted and dynamic-argument data-read profiles have
the same non-invoking, non-allocating slot semantics as ordinary own reads.

Proved rejected primitive construction retains argument effects, receiver/list
validation and fresh runtime errors through unknown argument brands, dynamic
`newTarget`, unused results, escaping arguments and suspension. It has no normal
constant result, target-owned state update or payload preparation; construction-body
callbacks and iteration are absent. Caller argument production and reflective list
access remain separate obligations. `BigInt` and `Symbol` have throwing constructor
bodies, so an unknown `newTarget` still requires validation before entry. Mutable
callables keep their distinct construction paths.

Primitive construction also uses exact `newTarget` facts: known nonconstructors
reject before a reflective argument list is read, while argument expressions still
execute. After list expansion, `BigInt` and `Symbol` with any proved canonical
constructor as `newTarget` become their residual constructor-body errors. Unknown
targets and effectful lists retain runtime validation; source spreads still run
before construction checks.

Private named properties on Number and String wrappers use the shared virtual
state path. Input conversion remains at construction, independently of whether
the wrapper disappears or materializes later with its final properties. String
indexes and `length` remain exotic-property boundaries. Unknown Object inputs,
alternate `newTarget` values, mutable prototypes and inherited setters retain
their runtime behavior.

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

Escaping Symbols also retain their identity while canonical metadata consumers reuse
the description captured at creation. Object conversion stays after argument
evaluation and before allocation. An unknown fresh-Symbol input branches once for
undefined and shares the captured description and descriptive text across consumers.
Registry keys always undergo ToString. Handler arguments that would depend on moved
instructions prevent the conditional transform; mutable metadata lookup remains
ordinary dispatch.

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
Exact parsing, Number and BigInt formatting, BigInt width, Symbol description and
registry-key, and URI/legacy codec calls use the same contained payload proof.
Receiver brand checks and ordered argument conversions remain in the consumer;
Symbol output identity and registry effects also remain. Symbol.keyFor requires a
primitive Symbol and therefore cannot consume a wrapper through this substitution.
String character, search, range, construction, normalization and HTML methods can
also consume contained wrapper arguments. String.raw applies this proof only to
substitutions. Custom split/replace protocols receive the original limit or
replacement argument, so those positions require a primitive pattern. Receiver
identity remains subject to the separate protocol proof. Locale arguments and raw
template objects retain their object semantics.

String.raw may consume a private, single-use template and dense raw array whose
own data elements contain dynamic values. Raw segments and substitutions are
converted in their original interleaved order at the call, after argument
evaluation; repeated values retain repeated conversion. The template and array
can disappear because no callback can observe or mutate their structure. Escaped
arrays, captured aliases, holes, getters and proxies retain ordinary property
reads. The result remains a primitive string, including when it escapes or is
retained across suspension.

Exact Boolean text observations normalize to Core ToString and select the VM's hot
true/false strings. Native operator input certificates retain semantic Boolean kinds
when a physical register also serves unrelated boxed values. Selection queries the
current local kind analysis for conversions introduced after effect refinement;
function versions protect the resulting proof. Method and String calls still require
proven callee identity, while implicit conversion does not consult those properties.
Unknown and mixed kinds retain generic conversion, including wrapper coercion.

Single-assignment primitive cells retain their payload facts through arbitrary uses:
passing a primitive to a callback cannot mutate it. The shared cell index still
requires a unique Core writer. A dominating initializer in the same activation
licenses facts at a load; otherwise, a retained TDZ check licenses them only at a
later consumer. A read never uses its own future TDZ check as proof. Cross-function
writer changes invalidate both ordinary and observation-specific query caches.
Object and array cells retain their separate read-only-content proof.
Symbol data records registry membership independently of per-evaluation identity.
Fresh and registered Symbol payloads are immutable; storing them in a cell retains
their data and TDZ obligations. Only intrinsic and registry identities remain stable
across cell reads. Fresh identities stay tied to the runtime cell/activation, so
repeated closure creation cannot pool distinct Symbols. Registry creation and key
coercion still execute even when later metadata observations fold.
Primitive lowering queries constants and brands at the consuming instruction, so a
retained TDZ check can license a fold, residual exception, or prepared input without
making the original load unconditionally constant. Split data still materializes a
fresh array on escape; String.raw and exact sums can consume initialized primitive
cells without aggregate inputs. Collation keeps target-owned comparison data and
retains primitive coercion before using captured locale/options data.
Residual primitive calls can expose initialized scalar cell values as ordinary
constant operands for existing typed kernels. The original cell load and TDZ check
remain in place. This does not recreate BigInts or identity-bearing Symbols.
String searches with proved primitive String receiver and needle and a numeric
position use the shared search kernel directly. Cons strings retain both GC roots
while flattening before the scan; unknown string operands keep the guarded entry.
Proved primitive String receivers also admit `repeat(0)` as the empty string and
`repeat(1)` as the original value after certified count conversion. Nonpositive
padding lengths reuse the receiver without converting the filler. Receiver
conversion and argument producer effects remain at their original positions.
Full-range `slice` and `substring` calls reuse the string when certified bounds
cover every possible receiver length. A no-argument `concat` also returns that
immutable value; uncertain bounds retain the ordinary operation.
Certified empty slice/substring ranges discard only the string operation. Empty
primitive needles make includes/startsWith/endsWith true after certifying position
conversion; unknown or effectful positions still execute at runtime.
Concat also reuses the receiver when every suffix is an empty primitive string.
Padding with an empty primitive filler reuses it after certified length conversion.
Substr supports certified full-range and empty-result identities while preserving
its start/length conversion rules and argument producer effects.
Split of a proved primitive string with an omitted or undefined separator carries
a fresh singleton result whose element references the receiver. A certified zero
ToUint32 limit produces a fresh empty result when the separator is also a proved
primitive string or undefined. Receiver and argument producers remain; unknown
separator protocols or limit coercions keep the original call. Fully constant
splits continue through the existing literal-template lowering.
Successful locale case transforms with immutable primitive String receiver and locale
inputs can reuse their result. The target fixes default-locale behavior; locale-list
objects retain each property observation. Discarding an unused transform additionally
requires certified valid options, so an unknown locale String still validates at runtime.
Generator and async builtin calls retain bounded Core input-kind certificates through
register allocation and the compiler artifact. Number, Boolean and String operands
can use typed entries even though coroutine slots remain boxed and GC-visible.
Unknown resume values retain ordinary coercion and brand checks. Resumable emission
also receives the target string-constant table for certified locale and normalization
options; it does not infer constants from register writes.
Callback replacements retain their separate allocation cost model. Character access
with a proved primitive String and numeric position uses the shared inline UTF-16
kernel. Lazy string storage can flatten there; unknown receivers and positions retain
the flat helper guard or ordinary coercion path.

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

Exact primitive-slot methods can consume a proven wrapper constructor's original
payload even after the wrapper escapes. The constructor and escaping uses retain
the object identity; only the method receiver changes. Number and String inputs
must already have the matching primitive kind, and Object must wrap a matching
primitive. Boolean may repeat its effect-free truthiness conversion on the original
SSA value. Matching constructor/new-target identities and ordinary argument lists
are required. Unknown producers, proxies, merged receivers, generic coercion and
mutable method lookup retain their ordinary behavior. This forwarding does not
remove allocation or duplicate user coercion, and preserves all argument effects.

Known calls with array-like argument mode can expand after later operand folding
completes their call-site array proof. The same descriptor and inherited-hole
checks govern initial adapter resolution and this later expansion; unknown lists,
getters and proxies retain their protocol. Numeric and stable-symbol constant-call
witnesses cover surrounding effects, escaping consumers, loops, suspension,
repeated and unused calls, and reflective array arguments in both primordial modes.
These witnesses certify the selected exact inputs, not arbitrary target libm
evaluation or entropy and registry operations.

Scalar representation changes stay local when a value feeds an ordinary
control-flow edge, so a Math result can still join an initial undefined or object
value. Typed Math opcodes keep their numeric operand contract
when coroutine storage boxes registers; native emission unboxes those operands
without coercion and stores results in the destination's actual representation.
Other known numeric calls retain their ordinary path when lowering has not carried
the numeric proof across suspension.

Repeated exact `Symbol.for` calls may reuse a prior successful result in the same
basic block when the key is the same proved primitive value. Registry entries retain
their Symbol identity across arbitrary effects. The first call still performs the
lookup or insertion, even for unused results; unknown object keys retain repeated
coercion, and fresh `Symbol` calls remain distinct. This rule performs no motion
across control-flow or suspension boundaries. Primitive-key registry lookup has no
user callback or iterator protocol; input conversion and argument effects remain
separate obligations.

Symbol metadata may forward the string used by a known Symbol producer even when
its identity escapes. Registry keys are converted once at Symbol.for evaluation;
description and keyFor consumers reuse that string while the registry call stays
in place. Fresh Symbol descriptions forward a proved String input, or convert a
proved non-undefined primitive at creation and retain that text. Unknown inputs
keep the absent-description distinction; argument coercions and their exceptions
remain before the fresh identity is created.
Unknown producers, merged Symbols, proxies and mutable descriptor lookup retain
their ordinary paths.

For the witnessed primitive-only numeric calls, private state update and
callback/iterator specialization are inapplicable: these algorithms mutate no
JavaScript receiver or result state and take no callback or ECMAScript iterator.
Math's internal numeric argument loops do not introduce a user iteration protocol.
The separate caller conversion, reflective list access, callback, loop and
suspension still run. Symbol metadata reads return an existing immutable String or
undefined; they have no new result identity, mutable state, callback/iteration or
payload preparation. Symbol creation, registry insertion, wrapper inputs and
wrong-brand errors keep their own obligations. These classifications exclude
mutable targets, unproved coercion, entropy and sumPrecise iteration.

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
