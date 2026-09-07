# Numeric specialization and callback experiment

The six requested compiler changes are implemented through Core proofs, native
selection, Program Image serialization, and C emission. The strongest measured
result is a consistent reduction in the JavaScript collections phase in both
compiled world modes. Interpreter performance remains inconclusive.

The comparison used base `4966936101196bd7062404e42c718ed37ce26598` and candidate
`6d6ce8e3308a7d9976537a0dad19e28abf108606`, on macOS arm64 with Node 26.7.0 and
Apple clang 17. Production builds used `-O2 -g0 -flto=thin` and stripping. The
environment probe passed on AC power, with no other active Maligator commands.
Browser activity and substantial timing drift occurred during measurement.

## Implementation

| Checkpoint | Change and boundary                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `86a5d82a` | Preserve unresolved unary kinds for all six numeric unary operations. Forward dependencies and loop joins converge independently of block order; unknown inputs stay conservative.                                                                                                                                                                                                                                        |
| `3e081c5a` | Infer and lower arithmetic and relational operations over Number, undefined, null, and Boolean. Verified operand masks reach canonical and contextual native entries and the artifact codec. Equality retains its narrower kind-sensitive contract; strings, objects, Symbols, and BigInts retain general semantics.                                                                                                      |
| `c03c49ab` | Admit numeric field entries when only the consumed fields are numeric. Unused initializers still execute, and heap-valued metadata stays rooted for complete fallback object materialization.                                                                                                                                                                                                                             |
| `dde73b04` | Rank signatures and charge expected benefit with bounded loop weights: 1 outside loops, 4 inside a loop, and 8 for nested loops. Signature counts and expansion budgets remain bounded.                                                                                                                                                                                                                                   |
| `5da12818` | Inline primitive refinements by re-proving them in the caller. Extend the existing inliner to acyclic helpers bounded by eight blocks and 48 instructions, including diamonds and early returns. Foreign proof IDs are not copied. Captures, handlers, suspension, loops, and argument reflection remain excluded.                                                                                                        |
| `6d6ce8e3` | Discover guarded numeric sort callback edges within the existing signature planner. Check canonical builtin identity, callback identity, receiver domain, and each compared pair before calling a checked two-number native entry. Support `sort` and `toSorted` on numeric TypedArrays and ordinary Arrays, including numeric pairs in mixed Arrays. The existing sorting algorithms and general fallback remain in use. |

Open-world call sites retain runtime identity checks and generic branches. The
numeric callback bridge preserves realm switching, checked frame entry, exceptions,
reentrancy, comparator result handling, and GC behavior. Artifact version 59 carries
and validates the new contracts. Verified immutable plan copies retain the proof
payload identities needed for subsequent validation.

Stress and parity tests also exposed two existing defects on the exercised paths:
Symbol addition incorrectly produced NaN, and `TypedArray.toSorted` could collect
its fresh result while a comparator ran. Both are fixed. Primitive conversion follows
the [ECMAScript ToNumber rules](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-tonumber).

The compiled and wire/interpreted native paths were exercised. The Wasm build shares
the same Program Image/C emitter through `emitProgramTranslationUnits`; a Wasm build
was not run.

## Measurement

```sh
node scripts/bench.ts javascript \
  --compare 4966936101196bd7062404e42c718ed37ce26598 \
  --runs 3 --max-pairs 5 --budget-seconds 900
```

The inspected plan selected all four world/backend modes, two warmup snapshots,
and three to five measured pairs. Five alternating pairs completed in 887.6 seconds.
Every workload checksum matched; the report is complete with no unpaired metrics.
No benchmark or standards baseline was updated.

| Metric                         | Base median, ms | Candidate median, ms | Median paired change | 95% paired interval |
| ------------------------------ | --------------: | -------------------: | -------------------: | ------------------: |
| Closed compiled collections    |             348 |                  278 |              -22.36% |  [-26.24%, -19.50%] |
| Open compiled collections      |             380 |                  287 |              -21.53% |  [-27.71%, -18.09%] |
| Closed compiled whole workload |         1592.88 |              1578.71 |               -5.30% |    [-7.49%, -0.89%] |
| Open compiled whole workload   |         1825.42 |              1815.81 |               -4.77% |    [-5.92%, +3.29%] |

Changes and intervals use pairwise percentages and the runner's bootstrap method.
Because the host changed speed during the run, the paired change differs from the
quotient of the two separately calculated medians. Open compiled whole-workload
results and all Node-relative balanced scores are inconclusive.

The comparison exited 1. It classified open-mode binary growth, two link-time
metrics, and the closed interpreted async phase as regressions. Closed interpreted
whole-workload time had a +1.70% median paired change; open interpreted had +1.96%.
Both remain inconclusive under the runner's policy. A focused follow-up with five
closely alternating interpreted pairs also verified all checksums; its async result
was +2.24%, with an interval of [-20.45%, +18.05%]. This does not establish either
interpreter parity in performance or a repeatable async regression. The async
workload's only bytecode differences are register assignments and one extra register;
its instruction count, control flow, generator, and async-step helpers are unchanged.

The open compiled binary grew from 31,296,456 to 31,480,360 bytes (+183,904 bytes,
0.588%); open interpreted grew by 183,840 bytes (0.591%). Closed compiled grew by
384 bytes, and closed interpreted by 256 bytes. RSS was classified unchanged in all
four modes. Link-time measurements came from cached builds and do not establish
cold compilation cost. The binary-size cost is retained alongside the demonstrated
compiled collections benefit; there is no blanket claim of improvement in every mode.

## Applicability on real source

Static inspections compiled identical input from the base source archive through
each compiler revision. The JavaScript workload gains one two-number sort entry in
each world mode: closed entries increase from eight to nine, open from six to seven.
Its canonical numeric register count remains 59. Generated C changes from 282,437
to 282,386 bytes closed, and 288,925 to 288,938 bytes open.

On the 3,968-function compiler workload, canonical numeric registers increase from
856 to 918 across 58 functions. Examples include `parseBinaryExpression`,
`solveCallTargets`, `solveSummaries`, `verifyFacts`, and `expandPositions`. Generated
C decreases from 53,790,568 to 53,623,876 bytes. These are representation and size
observations, not an AOT self-compilation timing result.

Isolating `c03c49ab` versus `dde73b04` selects the same signatures and generates the
same C size on both inspected workloads. The compiler workload selects no direct
entries at either revision. Loop weighting demonstrably selects the numeric hot
signature in the mixed-signature regression tests, but has no separately measured
speedup on these real workloads. Its weights remain a heuristic, not trip counts.

## Validation and retained evidence

`npm run test:check` passed all eleven stages in 289 seconds on the source committed
as the candidate. This includes type checking, lint and formatting, 1,489 unit tests,
native coverage, 60 UBSan tests, and selected Test262/WPT coverage. One existing native
test was skipped. Focused primitive and callback native checks passed in both world
modes and both backends, including GC stress. Field-entry fallback/rooting and bounded
inlining native tests passed; focused field and callback UBSan checks also passed.
Filtered addition Test262 coverage completed with 48 passes and no new failures.
The full Test262 corpus, `test:full`, HTTP performance, and AOT self-compilation timing
were not run.

Local raw evidence is retained at:

- `.cache/bench-comparisons/2026-09-07T10-27-11-416Z-QBvki8/report.json`, with all warmup and paired snapshots and logs.
- `.cache/optimization-evidence/gate-check.json` and `.cache/optimization-gate.log`.
- `.cache/optimization-evidence/async-control.json`, with its build and measurement scripts.
- `.cache/optimization-evidence/javascript-*.json`, `compiler-*.json`, and `compiler-numeric-gains.json`.
- `.cache/inspect-optimization.mjs`, which inspects actual Core plans, native representations, and emitted C on matched input.

All implementation checkpoints are unsigned local commits. Nothing was pushed.
