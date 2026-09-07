# Numeric specialization reverification

This recheck covers the six original proposals after `22cfa82a`. It found three
additional places where the existing proof could support more forms. No evidence
supports claiming that every JavaScript spelling now specializes.

| Original proposal             | Reverified behavior and change                                                                                                                                                                                                                                     | Remaining boundary                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bottom-preserving unary kinds | All six numeric unary operations preserve bottom through forward SSA dependencies, loop joins, and forward call-return edges. Closed single-assignment globals now forward the stored SSA value into the lattice worklist, preserving arithmetic and joined kinds. | Unknown inputs remain top. Global forwarding requires the existing closed-slot certificate, one non-TDZ store, and store dominance; external/multiple stores and reads before initialization remain conservative. This does not infer arbitrary inter-function global stores. |
| Primitive numeric unions      | Number/undefined/null/Boolean proofs survive arithmetic, relational operations, contextual entries, serialization, and native emission. The new field-entry path consumes these same certificates.                                                                 | Equality remains kind-sensitive. String, object, Symbol, and BigInt coercion retains general semantics. Numeric representations are never used to erase null/Boolean identity.                                                                                                |
| Loop-weighted signatures      | The planner still uses capped 1/4/8 loop weights for both ranking and benefit accounting, with bounded signature and expansion budgets. Single and nested-loop selection tests still pass.                                                                         | These are heuristic weights, not measured trip counts. This recheck does not claim a separate performance gain from weighting or change its limits.                                                                                                                           |
| Numeric field entries         | Field computations can now use Boolean and null/undefined intermediates certified by the native-entry analysis. Locked, proven number-returning Math operations use their builtin descriptors instead of a floor/min/max name list.                                | Only consumed fields must be Numbers. Metadata remains boxed and rooted for fallback; accessors, escaping/mutating arguments, unknown computations, and mutable Math identity remain generic. Four-field and four-target limits stay in force.                                |
| Proof-safe bounded inlining   | Primitive effect facts are re-proved in the caller; diamonds and early returns pass the caller-local proof checks.                                                                                                                                                 | Eight blocks/48 instructions remain the limit. Cycles, handlers, suspension, captures, reflection, unsupported terminators, and foreign obligation-bearing proofs remain outside this inliner.                                                                                |
| Numeric sort callback edges   | Direct/computed-property calls, detached aliases, and prototype `sort.call`/`toSorted.call` forms can select the existing two-number callback ABI. The original invocation still runs after identity and domain checks.                                            | `.apply`, bound calls, unsupported callback arities, argument reflection, and unproven captured numeric results are not newly specialized. BigInt and nonnumeric comparison pairs retain fallback behavior.                                                                   |

The detached path checks canonical `Function.prototype.call`, the actual sort
builtin, the receiver brand/domain, callback identity, and the compared operands.
Realm checks cover both called builtins. It preserves original argument forwarding,
exceptions, reentrancy, and the original sorting algorithm. Artifact version 60
carries the new invocation form and rejects malformed callback contracts.

## Validation

The focused set passed 123 unit tests covering all six mechanisms, including
negative contracts and forward call/global dependencies. Both native fixtures passed
in locked and mutable worlds through compiled and interpreted backends, including
GC stress; all four focused UBSan cases passed. A separate GC-stress parity test also passed
for overriding `.call` on the canonical sort function, restoring it, and replacing
it with a non-callable value. That additional case also passed UBSan.
Final type checking and lint/format checks passed after adding it.

The normal `npm run test:check` gate passed all eleven stages in 170 seconds:
1,508 unit tests, 42 selected native tests (one existing skip), 60 UBSan tests,
and the selected Test262/WPT checks. Its first attempt stopped at the socket-driver
test because the execution sandbox blocked loopback. The environment probe confirmed
that restriction; the exact gate passed after restoring its required capabilities.

Source checkpoints are unsigned local commits `827acd94` and `c31244e7`.
The full Test262 corpus, `test:full`, a Wasm build, HTTP performance, and AOT
self-compilation timing were not run. Benchmark and standards baselines are unchanged.

## Measurement

The focused comparison uses the existing JavaScript workload with its collection
sort changed only to `values.sort.call(values, compare)`. Both revisions compile
identical input; all six phase checksums are checked on every execution. The
comparison targets the newly admitted spelling. It does not refresh the earlier
full benchmark or turn historical results into validation of this revision.

Production `-O2`/ThinLTO builds used base `22cfa82a` and candidate `c31244e7` on
macOS arm64. The fresh environment probe passed on AC power with zero active
Maligator commands. Ordinary desktop activity remained present. One warmup per
binary preceded five alternating pairs per world; intervals are percentile
bootstrap intervals over paired percentage changes (2,000 resamples). Percentage
changes use within-pair ratios, so they differ from ratios of the separate medians.

| Compiled metric       | Base median, ms | Candidate median, ms | Median paired change | 95% paired interval |
| --------------------- | --------------: | -------------------: | -------------------: | ------------------: |
| Closed collections    |          252.00 |               199.00 |              -19.57% |  [-32.54%, -18.73%] |
| Closed whole workload |         1174.74 |              1146.16 |               -5.21% |   [-15.78%, -1.82%] |
| Open collections      |          275.00 |               219.00 |              -22.22% |  [-24.76%, -18.28%] |
| Open whole workload   |         1294.99 |              1238.32 |               -4.49% |    [-7.21%, -3.66%] |

The closed async control increased from 89 to 91 ms, with a +2.30% median paired
change and an initial interval of [+1.02%, +3.30%]. Its emitted C is unchanged.
Seven additional closed-mode pairs again showed a roughly 2 ms median increase:
+2.27%, with an interval of [0.00%, +10.11%]. That follow-up reproduced the
collections gain (-22.67%, interval [-24.70%, -19.26%]) and lower whole-workload
time (-2.87%, interval [-5.95%, -1.28%]). This is retained as an unresolved small
async cost; it does not establish performance parity for every control. Other
initial phase intervals include or touch zero.

The closed binary grew by 192 bytes (2,568,288 to 2,568,480); the open binary grew
by 16,736 bytes (31,482,128 to 31,498,864, +0.053%). Static inspection of this matched
source selects one additional two-number callback entry in each world, increasing
closed entries from eight to nine and open entries from six to seven. Canonical
numeric registers remain 59. Generated C grows by 901 bytes in each mode. The
production C diff changes the collections call and adds its numeric entry; async
function bodies are identical. These results establish benefit for the new detached
sort form, with the above control and size limitations.

A fresh before/after inspection also compiled the same frozen 3,968-function compiler
workload through both revisions. Both select 918 canonical numeric registers and
zero direct entries. Generated C changes from 53,623,876 to 53,623,676 bytes. The
broader forms therefore add no observed signature coverage on that compiler input;
no new compiler performance gain is claimed.

## Retained evidence

- `.cache/numeric-reverify/gate-check.json`, plus `.cache/numeric-reverify-gate-corrected.log`.
- `.cache/numeric-reverify-unit.log`, `.cache/numeric-reverify-native.log`, `.cache/numeric-reverify-sanitize.log`, `.cache/numeric-reverify/outer-call-guard.log`, and `outer-call-guard-sanitize.log`.
- `.cache/numeric-reverify/measurements.json` and `async-followup.json`: raw pairs, checksums, binary paths/sizes, and intervals.
- `.cache/numeric-reverify/build.mjs`, `measure.mjs`, and `async-followup.mjs`: exact local reproduction harnesses; `base/` is a source archive of `22cfa82a`.
- `.cache/numeric-reverify/javascript-*.json`, `compiler-*.json`, and `closed-generated.diff`: matched static plans and generated-code evidence.
- `.cache/numeric-reverify/benchmark-environment.json` and `benchmark-cache.log`: execution readiness.

The frozen input is `.cache/numeric-reverify/detached-javascript.mjs`, SHA-256
`9f430bc1f1380d6f5f9c24b42efd5ae2f4cc2fa512f3eaa2b1e55cb1018dd7b9`.

The earlier [numeric specialization experiment](numeric-specialization-experiment.md)
remains a separate comparison against the original six-change baseline.
