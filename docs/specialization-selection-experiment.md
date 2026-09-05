# Specialization selection experiment — 2026-09-05

The call-ranking experiment did not establish a performance improvement beyond
noise. Its patches and raw results are retained locally for inspection. The
correctness prerequisite is retained in unsigned local commit `ddbe1220`.

## Refreshed baseline and hypothesis

The initial checkout was clean at `9c5fe909`, with `e1fb84b8` and `dbdbf4bf` already
in its ancestry. Full-source compiler diagnostics found 7,325 guarded-call
candidates, one selected call, and 18,135 generated-code-budget declines. The
selection phase consumed its remaining 3,072 cost units; preceding transformations
had consumed 1,024 of the shared 4,096-unit budget.

The candidate ranked calls by estimated frequency divided by target-set size.
Frequency used the existing loop-depth weights and one bounded propagation step
from callers to helpers. Repeated calls preceded local specializations; local
specialization ordering and budget limits stayed unchanged. A second candidate
weighted proven exact calls more highly than open targets requiring guards.

## Correctness prerequisite

An open singleton target set was being lowered as an unconditional direct call.
Knowing one possible function does not prove that a mutable target still contains
that function. A reproduced call through a property replaced with `null` failed
to throw in compiled output while interpreted output correctly threw `TypeError`.

Commit `ddbe1220` carries the exact/guarded representation through recipes, site
facts, lowering and reporting. Open singleton calls retain their runtime guard
and generic fallback. A native regression exercises receiver and argument values,
the non-callable replacement, exception behavior and GC stress. Existing direct
and finite-call tests cover captures, receiver/callee identity, argument ordering,
overflow, target replacement and fallback.

The performance baseline was rebuilt after this fix. No performance conclusion
uses the incorrect pre-fix candidate as its comparison baseline.

## Measurements

The workload is the repository self-compile entrypoint compiling the fixed,
type-stripped `core-ir-shape-provenance.ts` dependency closure. These measurements
are an AOT compiler workload, not the complete canonical self-compile benchmark.
They include compiling, emitting and writing generated C, with Core instrumentation
disabled. Executables use development mode, O2, no LTO, compiled execution and locked
primordials. Processes ran sequentially on AC power after CPU and cache checks.

Five pairs alternated AB/BA/AB/BA/AB, with warm filesystem state:

| Metric                                 | Corrected baseline | Caller/loop ranking |
| -------------------------------------- | -----------------: | ------------------: |
| Median elapsed                         |           36.967 s |            36.609 s |
| Sample range                           |    36.433–37.117 s |     36.390–37.885 s |
| Compiler binary                        |   35,645,744 bytes |    35,902,208 bytes |
| Compiler generated C                   |   60,508,800 bytes |    61,729,888 bytes |
| Observed build wall time               |           94.746 s |            95.801 s |
| Direct call sites in native image      |                  1 |                 936 |
| Guarded call sites in native image     |                  0 |               2,113 |
| Cached-call expressions in generated C |             15,365 |              14,441 |

The median difference was 0.97%, but paired speedups were +1.37%, +1.47%,
−0.97%, −3.99% and +1.60%. This does not establish a repeatable improvement.
Binary size grew 0.72% and generated C grew 2.02%. Build times are individual
observations with retained phase/cache events, not a repeated build-cost benchmark.

Generated-code inspection confirms direct calls and guarded exact-script paths
were emitted. Some frequently executed helpers switched from cached dispatch to
guarded exact-script dispatch, while several hotter property calls remained
generic. A guarded exact-script path still enters the runtime call machinery;
selecting thousands of sites does not imply a comparable reduction in execution
cost.

The exact-target-weighted variant emitted the same workload output and had the
same direct/guarded site counts in the compiler binary. Its generated C was
61,731,102 bytes and its binary 35,902,208 bytes. Its 47.917 s build reused cached
work and is not a comparable build-speed improvement.

The repeat completed five alternating pairs: baseline median 38.999 s
(38.589–39.948 s), candidate median 38.692 s (38.132–38.859 s), a 0.79% median
improvement. Paired speedups were +1.03%, +2.80%, +1.85%, +0.36% and +0.89%.
Comparing generated translation units showed that the two candidates differed
only in the ranking function and its metadata, not the selected call paths.
Across both campaigns the mean paired gain was 0.64%, with a sample standard
deviation of 1.90 percentage points. The repeat is encouraging but does not
resolve the first campaign's variability. Both ranking changes were removed;
no performance optimization is accepted from this experiment.

## Validation and limits

Every measured native emission matched its corresponding Node-hosted revision's
SHA-256 output digest. Baseline and candidate digests differ because their selected
specializations differ; these are not equal cross-revision checksums. Native
behavioral tests supply separate semantic evidence.

The correctness checkpoint passed all 11 stages of `npm run test:check` in
262.442 s, including the selected native, sanitizer, Test262 and WPT lanes.
Focused verification passed four compiler test files and three native test files
(14 native tests). The final ranking variant passed 58 focused compiler tests.

A preliminary canonical JavaScript comparison was stopped after discovering the
singleton-guard defect. Its one completed pair and incomplete report are not
acceptance evidence. Complete JavaScript, HTTP, full self-compile and full Test262
acceptance remain unverified. No push or benchmark/standards baseline update was
performed.

## Local evidence and reproduction

Raw data, generated C, executable hashes, fixed-input hashes, candidate patches,
build events, commands and harnesses are in
`.cache/specialization-selection/README.md`. In particular:

- `caller-ranked-samples.json`: first complete five-pair campaign.
- `quick-pairs/samples.json`: the repeat campaign with exact-target weighting.
- `caller-ranked.patch` and `exact-ranked.patch`: experimental edits against
  `ddbe1220`.
- `guard-baseline/`, `ranked-candidate/`, `exact-candidate/`: retained executables,
  generated C and build metadata.
- `prerequisite-gate.json`: completed normal gate report.
- `guard-baseline-profile.json`: refreshed compiler profile.

Retained executables can be compared without changing the checkout:

```sh
npm run env:check -- --json
node ./src/index.ts cache status
node .cache/specialization-selection/run.ts pairs 5 quick guard-baseline ranked-candidate
```

The harness writes `quick-pairs`; preserve its previous contents before rerunning.
