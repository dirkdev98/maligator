# Conditional object allocation

Core now sinks a shaped-object allocation into a uniquely entered successor when
all uses occur there. Initializers remain in their original position. This slice
requires scalar fields and excludes exception handlers, suspension boundaries,
handler uses, and proof-dependent allocations. A successor with multiple incoming
edges is ineligible, preserving one object identity per original execution.

In `bench/javascript.mjs`, existing inlining and scalar replacement already remove
the first two vector records. The remaining result record was allocated 8,400,000
times, although only 1,026 iterations retain it. The new pass makes one Core move
in `allocationPhase`, so that allocation runs only on the retaining branch. The
workload and its checksums are unchanged.

Five alternating baseline/candidate pairs used the production plan on macOS arm64,
AC power, Node v26.7.0, and Apple clang 17 with `-O2 -g0 -flto=thin`. Baseline
`e1fb84b84d02bf72f28260fcdb3982cb60d36136` includes the prerequisite correctness fix;
the measured candidate adds only allocation sinking and its regressions.

| Mode               | Before median | After median | Paired time reduction | Bootstrap 95% interval |
| ------------------ | ------------: | -----------: | --------------------: | ---------------------: |
| Closed compiled    |    2,590.6 ms |   2,449.1 ms |                 5.35% |             5.05–6.01% |
| Open compiled      |    2,592.2 ms |   2,437.4 ms |                 6.52% |             5.88–6.76% |
| Closed interpreted |    4,012.4 ms |   3,861.6 ms |                 3.62% |             3.46–4.11% |
| Open interpreted   |    4,000.7 ms |   3,850.2 ms |                 3.79% |             2.87–4.16% |

Before/after columns are medians of absolute samples; reductions are medians of
paired percentage changes. Closed compiled allocation-phase time fell from 1,202
to 1,057 ms, a 12.06% paired reduction. Other JavaScript phase timings were unchanged
or inconclusive; no reported metric was classified as a regression.

Separate resource probes recorded 1,116.70 → 604.07 MiB allocated in closed compiled
execution, saving 512.63 MiB per run. Collections fell from 269 to 144; retained peak
live memory stayed at 12,411.86 KiB. Paired median RSS fell from 55.05 to 42.39 MiB.
Closed-mode binary sizes are unchanged. Open-mode binaries grow by 49,776 bytes
(0.16%) because they include the compiler. The compiled workload's generated C
grows by two bytes. No compiler-time or Node-relative speed claim is made from the
cached build metrics and inconclusive normalized ratios.

Verification: all 11 `npm run test:check` stages passed, including native UBSan,
curated Test262, and 1,543 WPT subtests. Focused coverage checks conditional retention,
initializer effects, identity across loop iterations, aliases, string roots under
GC stress, and negative loop/weak-field/handler/suspension cases. Full Test262,
HTTP timing, and self-compile timing were not run for this slice.

Verification also exposed a pre-existing native stack-object bug: emission inferred
elision from absent property accesses despite Core preserving identity for `typeof`.
The prerequisite commit carries Core's explicit mode through lowering and artifact
serialization instead. An obsolete inherited-stack optimization counter assertion
was removed because current Core has no producer for that path; the fixture's
mutation, getter, identity, and GC behavior checks remain.

Reproduce from the optimization revision:

```sh
npm run env:check -- --json
node ./src/index.ts cache status
npm run bench -- javascript --compare e1fb84b8 --runs 5 --max-pairs 5
npm run test:check
```

[Raw paired timings, resource counters, source identities, and gate results](conditional-object-allocation.json)
are retained separately from `bench/baseline.json`, which was not updated.
