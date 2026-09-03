# Core optimizer scalability acceptance

- Date: 2026-09-03
- Measured commit: `a8835ad852c9d31d84c15f0c345c0fe02abf537b`
- Reference host: Apple M3 Pro (11 logical CPUs), macOS 25.5.0, Node `v26.7.0`
- Configuration: locked primordials, Node and Maligator surfaces, eval/realms/Web Platform disabled
- Verification: unconditional Core boundaries; per-pass verification disabled for timings

## Verdict

The Core replacement and optimizer cutover are architecturally complete in the
validated production paths. All measured compiler-time and scaling thresholds pass,
including the Node-hosted self-compile limits. This report does **not** mark the whole
project accepted because two mandatory evidence gates remain failed:

1. Slice 0 was stopped without a usable full self-compile allocation/GC profile, so
   the final allocation, GC and managed-heap ratios cannot be compared with the
   frozen baseline.
2. `test:check` was stopped by the required five-minute command fuse while stage 8,
   the native-normal batch, was still running. Stages 1 through 7 passed, but an
   aborted stage is a failed gate under the completion plan.

`bench/baseline.json` therefore remains unchanged. The baseline-adoption slice in
`core_todo.md` explicitly follows review and cannot run from this report.

## Plan reconciliation

`core_optimizer_todo.md` is authoritative where it conflicts with `core_todo.md`.
The former's permanent complexity ladder, split `optimizeCore` timing and compact
recipe contract supersede the earlier combined optimize/lower measurement. The
original Core slices 1–15 are otherwise represented by the final implementation.
Slice 16 is deliberately pending because acceptance has not occurred.

The optimizer plan's deliberate non-goals were respected: no parallel compilation,
persistent cross-build cache, emitter rewrite, runtime-semantic reduction or legacy
optimizer mode was introduced to obtain these numbers. Full Test262, `test:full` and
`test:full:report` were not run because repository policy requires separate explicit
approval. The committed strict/sloppy Test262 regression selection and smoke lanes
were run instead.

## Slice ledger

| Slice | Owning checkpoint                    | Result                                                                                                                                                                           |
| ----: | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 | stopped before a complete checkpoint | Failed. No five-warm/three-cold self-compile or allocation/GC reference exists.                                                                                                  |
|     1 | `3311ecbb`                           | Symbolic `AnyScriptAggregate` graph completed. Accepted reference: T10 23,421.884/19,741.447 ms wall/optimize; T11 91,728.096/82,258.321 ms; T12 52,054.603/45,938.080 ms.       |
|     2 | `bbafb414`                           | Scalar `CoreFunctionKernel`, intrusive live uses and snapshot-reader cutover completed. T10 reached 21,927.001/18,757.407 ms.                                                    |
|     3 | `58f07fa2`                           | Fused sparse local optimizer and function feature gates completed. No full self-compile was retained at this boundary; focused semantic, structural and work-count gates passed. |
|     4 | `e82f1e1e`                           | One compact program-flow engine owns targets, summaries, value kinds and reachability. Independent production fixed points were deleted.                                         |
|     5 | `0b6f6113`                           | Shared local fact ownership, sparse numeric memory state and once-per-epoch candidate discovery completed.                                                                       |
|     6 | `c11f8b02`                           | Batched cross-call waves and compact verified recipes completed; tests lock at most two solves and one caller edit session per wave.                                             |
|     7 | `a8835ad8`                           | Full ladder, repeated hotspot loop, self-host validation and final recipe-composition correction completed.                                                                      |

The missing numeric samples for slices 3–6 are not reconstructed from unrelated
later measurements. Intermediate measurements retained during Slice 7 provide these
additional anchors:

| Checkpoint               | State                       | Self-compile wall |    `optimizeCore` |
| ------------------------ | --------------------------- | ----------------: | ----------------: |
| original reference       | frozen plan value           |        115,139 ms |        104,376 ms |
| `b6a4e406`               | first complete Tier 13      |     31,399.643 ms |     23,711.267 ms |
| `ffb91813` + local edits | analysis-context experiment |       27,980.7 ms |       20,203.4 ms |
| `1721736b` + local edits | fourth full profile loop    |       22,711.1 ms |       15,140.2 ms |
| `a8835ad8`               | final five-run median       | **22,076.087 ms** | **14,532.934 ms** |

Rows marked with local edits were exploratory dirty-tree measurements, not release
checkpoints. They are included only as optimization-loop evidence.

## Architecture audit

The final source and structural tests establish the required shape:

- `CorePassScope` contains only `function`, `scc` and `program`.
- Numeric work identities are used by production optimizer queues, caches and graph
  indexes; the active source has no legacy scheduler, `mutationEpoch`, `maxRounds`,
  generic `dependsOnProgram` or preservation-matrix identifiers.
- Allocating Core debug snapshots are isolated behind `core-debug-view` and used by
  `core-format`; production optimization and lowering do not import them.
- Live use traversal reported exactly zero dead-use skips throughout the final ladder.
- Wildcard storage is one aggregate dependency per eligible function plus wildcard
  source and exact-edge rows. At 1x to 10x, stored graph entries grew 55 to 487
  (8.85x) and transfer records grew 514 to 4,618 (8.98x), below the 15x gate.
- `CoreProgramFlowEngine` owns interprocedural convergence. Call-target, summary,
  value-kind and reachability modules are views or dimensions of that engine rather
  than independent whole-program solvers.
- Cross-call transforms used one wave, 99 caller edit sessions, 94 caller local
  optimizations and two program-flow resolves in the final full profile.
- Target lowering consumes the verified compact recipe table. It imports no call
  target, summary, provenance, shape-provenance, value-kind or program-flow analysis
  module to rediscover policy.
- The final Test262 regression found one residual composition flaw: an indexed-length
  recipe could overlap a shape-proven known-own-slot load. `a8835ad8` moved that
  exclusion and instruction-adjacency contract into Core candidate admission and
  Core plan verification. All 259 curated tests then passed.

The exact legacy-name scan covered `src`, `tests`, `scripts` and `package.json` for
`Core2`, `LegacyCore`, old/new adapters, `mutationEpoch`, `optimizationRounds`,
`maxRounds`, `dependsOnProgram`, preservation helpers,
`compactCoreProgramFunctions` and `core-ir-opt`; it returned no matches.

## Correctness and parity

| Gate                                          | Result                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused region placement/validity/image tests | 3 files, 145 tests passed                                                                                                                                   |
| Full unit lane                                | 105 files, 1,281 tests passed before the last proof-only fix; final `test:check` partitions passed 8 files/245 tests and 97 files/1,037 tests (1,282 total) |
| TypeScript                                    | Passed in final `test:check`                                                                                                                                |
| Lint and formatting                           | Passed in final `test:check`                                                                                                                                |
| Test262 smoke                                 | 7/7 strict and 7/7 sloppy passed                                                                                                                            |
| WPT smoke                                     | 1 execution, 2 subtests, no unexpected results                                                                                                              |
| Test262 regression manifests                  | **259/259 passed** across strict/sloppy folding                                                                                                             |
| `selfhost:frontend`                           | Passed in 2m17s; byte-identical 666-byte wire                                                                                                               |
| `selfhost:native`                             | Passed in 4m23s; isolated compiler linked and produced `native:13,16:26,32`                                                                                 |
| `selfhost:cli`                                | Passed in 4m00s; isolated product CLI, cache, eval, assets, Express and test paths passed                                                                   |
| `test:check` / Tier 14                        | **Failed evidence gate:** five-minute fuse expired during stage 8/11 after stages 1–7 passed                                                                |
| `git diff --check`                            | Passed after final formatting                                                                                                                               |

No command above ran longer than five minutes. The full Test262 corpus and exhaustive
test tiers remain unrun by policy, not treated as passes.

## Final complexity ladder

Every completed case maintained identical generated units, generated-code digest and
observable checksum across its warm, cold and profile samples. Times below are
milliseconds. `opt/k` is warmed `optimizeCore` milliseconds per 1,000 input Core
instructions.

| Tier / case              | Input instructions |      Warm wall |  Warm optimize |      Cold wall |       opt/k |
| ------------------------ | -----------------: | -------------: | -------------: | -------------: | ----------: |
| 1 arithmetic 1x          |                145 |          9.079 |          5.307 |         39.289 |      36.597 |
| 1 arithmetic 3x          |                409 |         16.552 |          8.976 |         51.222 |      21.945 |
| 1 arithmetic 10x         |              1,333 |         50.474 |         18.320 |         94.228 |      13.743 |
| 2 straight line 1x       |              2,653 |        133.810 |         33.700 |        188.671 |      12.702 |
| 2 straight line 3x       |              7,933 |        924.532 |         98.267 |        989.761 |      12.387 |
| 2 straight line 10x      |             26,413 |     10,044.156 |        445.055 |     10,060.738 |      16.850 |
| 3 CFG 1x                 |                255 |         18.905 |          9.619 |         60.349 |      37.723 |
| 3 CFG 3x                 |                735 |         37.367 |         18.152 |         91.582 |      24.696 |
| 3 CFG 10x                |              2,415 |         99.559 |         44.264 |        177.171 |      18.329 |
| 4 loops 1x               |                265 |         23.428 |         13.302 |         66.540 |      50.197 |
| 4 loops 3x               |                721 |         47.227 |         26.071 |        102.935 |      36.159 |
| 4 loops 10x              |              2,317 |        145.062 |         63.590 |        218.536 |      27.445 |
| 5 memory 1x              |                278 |         16.969 |          8.458 |         54.685 |      30.424 |
| 5 memory 3x              |                758 |         40.420 |         15.967 |         83.320 |      21.065 |
| 5 memory 10x             |              2,438 |        142.171 |         35.060 |        207.960 |      14.381 |
| 6 exact SCC 1x           |                250 |         17.300 |          9.054 |         61.460 |      36.218 |
| 6 exact SCC 3x           |                730 |         35.588 |         18.445 |         91.387 |      25.267 |
| 6 exact SCC 10x          |              2,410 |         91.897 |         45.436 |        171.027 |      18.853 |
| 7 wildcard 1x            |                331 |         23.891 |         13.792 |         73.035 |      41.668 |
| 7 wildcard 3x            |                883 |         46.042 |         25.928 |        109.035 |      29.364 |
| 7 wildcard 10x           |              2,815 |        128.630 |         70.722 |        215.955 |      25.123 |
| 8 transform candidates   |                913 |         48.867 |         25.052 |        116.396 |      27.439 |
| 8 pass manager           |            148,907 |      7,027.337 |      4,651.588 |      7,584.427 |      31.238 |
| 8 shape provenance       |             82,140 |      3,886.991 |      2,514.907 |      4,414.160 |      30.617 |
| 9 memory                 |             88,433 |      4,325.782 |      2,838.682 |      4,886.046 |      32.100 |
| 9 summaries              |             55,917 |      2,474.209 |      1,559.149 |      2,923.936 |      27.883 |
| 9 value kinds            |             50,617 |      2,177.180 |      1,299.595 |      2,531.072 |      25.675 |
| 10 `optimize.ts`         |            196,156 |      9,088.199 |      6,032.423 |      9,838.914 |      30.753 |
| 11 `compile-program.ts`  |            378,014 |     19,239.253 |     12,609.067 |     19,884.970 |      33.356 |
| 12 complete Core subtree |            293,652 |     13,229.157 |      8,591.509 |     14,006.833 |      29.257 |
| 13 Node self-compile     |  425,284 (profile) | **22,076.087** | **14,532.934** | **22,936.826** |      34.172 |
| 14 cold `test:check`     |                n/a |            n/a |            n/a |       >300,000 | failed fuse |

The synthetic fixed-cost cases have their highest normalized values at 1x and fall as
size grows. Real tiers 8–13 remain between 25.675 and 34.172 ms per 1,000 input
instructions, so no real neighbor exceeds the 2x complexity-cliff gate.

Two raw historical comparisons require workload explanation:

- Slice 1's nested-loop generator accidentally emitted the same 54-instruction Core
  input at 1x, 3x and 10x. `91766020` made loop structure scale geometrically; raw
  wall times are therefore not comparable, while final normalized cost falls from
  50.197 to 27.445 ms/k.
- The pass-manager workload grew from 35,041 to 148,907 input instructions as the new
  Core dependencies were implemented. Raw wall time rose from 3,848.314 to 7,027.337
  ms, but normalized optimize cost fell from 85.012 to 31.238 ms/k (63.3%).

## Self-compile samples and phases

Timing samples used instrumentation `off`; counters and profiles were captured in a
separate full-instrumentation run. All samples produced 9 units and 63,018,333 code
units.

| Sample          |          Total | `optimizeCore` |
| --------------- | -------------: | -------------: |
| warm 1          |     22,591.867 |     14,868.086 |
| warm 2          |     22,066.993 |     14,409.880 |
| warm 3          |     22,076.087 |     14,488.158 |
| warm 4          |     22,021.778 |     14,532.934 |
| warm 5          |     22,875.288 |     15,063.528 |
| **warm median** | **22,076.087** | **14,532.934** |
| cold 1          |     22,999.468 |     14,705.723 |
| cold 2          |     22,881.495 |     14,550.944 |
| cold 3          |     22,936.826 |     14,643.204 |
| **cold median** | **22,936.826** | **14,643.204** |

The slowest warm total is 1.036x the median, below the 1.12x gate.

| Phase              | Warm median | Cold median |
| ------------------ | ----------: | ----------: |
| module graph       |     165.098 |     157.653 |
| semantic analysis  |     239.932 |     236.004 |
| construct Core     |   2,922.033 |   2,990.979 |
| optimize Core      |  14,532.934 |  14,643.204 |
| Core to execution  |   1,371.902 |   1,550.740 |
| execution to image |   1,605.437 |   1,714.497 |
| emit               |   1,207.258 |   1,505.401 |
| serialize          |     135.658 |     171.875 |

Output digest:
`873cb5f879e7f69b977e07ae1c0ba4f4d8ac6eafbbe48b0f5e9cf67fa6bbd672`

Observable checksum:
`654945f4a7ce2119433eee8aa4080dfc469b6ec6f3c88c467f9c4da6a04c82b0`

Against the original 115,139/104,376 ms reference, the final warm medians are 80.83%
lower in total wall time and 86.08% lower in `optimizeCore` time.

## Threshold table

| Threshold                      |                  Required |                                                     Final | Result                |
| ------------------------------ | ------------------------: | --------------------------------------------------------: | --------------------- |
| Warm median `optimizeCore`     |               <=45,000 ms |                                             14,532.934 ms | pass                  |
| Warm median total              |               <=58,000 ms |                                             22,076.087 ms | pass                  |
| Slowest warm / median          |                   <=1.12x |                                                    1.036x | pass                  |
| Cold median total              |               <=70,000 ms |                                             22,936.826 ms | pass                  |
| T10 optimize reduction         |                     >=60% |                                                    69.44% | pass                  |
| T11 optimize reduction         |                     >=60% |                                                    84.67% | pass                  |
| T12 optimize reduction         |               informative |                                                    81.30% | pass                  |
| Wildcard 10x work growth       |                     <=15x |                              8.85x rows / 8.98x transfers | pass                  |
| Real normalized neighbor cliff |                      <=2x |                              maximum adjacent ratio 1.20x | pass                  |
| Sampled optimize allocations   |          <=40% of Slice 0 |                        1,320,176 bytes; no baseline ratio | **unverifiable/fail** |
| GC wall in optimize            |          <=50% of Slice 0 | observer 0 ms; CPU sample 1,897.178 ms; no baseline ratio | **unverifiable/fail** |
| Peak managed heap              |          <=70% of Slice 0 |                    2,703,220,032 bytes; no baseline ratio | **unverifiable/fail** |
| Cold `test:check`              | <=12 minutes and complete |                               incomplete at 5-minute fuse | **fail**              |

The full profile measured 425,284 input instructions, 134,842 blocks, 1,672,902
values and 3,602 functions. Output contained 255,281 instructions, 73,796 blocks,
177,850 values, 12,892 facts and 185 selected recipes. Sampled optimizer allocation
was 3.104 bytes per input Core instruction. Peak RSS was 3,592,765,440 bytes.

Normalized work from the same profile:

- queue pops: 933,525; below `425,284 + 6 * 125,465 = 1,178,074`;
- SCC transfers: 7,423, or 1.382 per exact edge plus SCC;
- memory state rows: 0.677 per memory access;
- memory state entries: 1.020 per memory access;
- memory transfers: 1.096 per memory access;
- candidate rows: 3.065 per eligible function;
- specialization stage: 637 ms, 3.52% of profiled `optimizeCore` time.

## Optimization loop and remaining costs

The retained loop fixed more than the required three independent hotspots. Important
owning checkpoints include:

- `f0274ed2`, `ea7311d6`, `8195ddbc`, `6bde93de`, `8f121fb0` and `1721736b`:
  cached cell resolution and edge arguments, sparse CFG rows, lazy arguments and
  reusable handler-free control flow;
- `9f11118a`, `d03fe9e1`, `14dd5903` and `d4a1746e`: numeric value-kind dependencies,
  kernel traversal, allocation-free operands and in-place live-use relinking;
- `5977b69e`, `f8ad4bb1`, `5e4bfb77`, `9292c0d7` and `03672091`: sparse memory rows,
  numeric locations, family epochs, admission-cliff removal and reused instruction
  indexes;
- `34390711`, `916a46b6`, `56ac62ac` and `fbb10dbe`: shared program-flow worklists,
  exception-handler indexes and numeric changed-edge deduplication;
- `b6a4e406`, `ffb91813`, `14969609`, `4714bd7a`, `3f40b2c2` and `643bedc0`:
  batched replacements and direct numeric/expression/proof/fact equality;
- `6b8cf388`, `31fb733f` and `a8835ad8`: self-host correctness for call-clobbered
  loop memory, indexed literal-template copying and composed late recipes.

Measured experiments rejected rather than retained included a full program-flow
extractor for local value kinds, per-block/body snapshot caches, eager numeric
MemorySSA hashing, linear recipe equality and a generic recipe hash. Each either
regressed its target tier, shifted cost downward or failed to improve repeated data.

The final profiled residuals are GC (1,897.178 sampled CPU ms), CFG edge/build work
(692.298 + 689.289 ms), local value-kind analysis (643.855 ms), immediate dominators
(630.932 ms), canonical roots (579.907 ms) and MemorySSA (524.708 ms). These remain
algorithmic Core/GC costs rather than target emission costs. They are follow-up
opportunities, not current timing cliffs: the real ladder is flat and every measured
compiler-time limit has substantial margin.

## Final artifacts

The complete final run is retained locally under `.cache/core-optimizer-ladder/` as:

- `final-a8835ad8-tiers-01-07.json`
- `final-a8835ad8-tiers-08-09.json`
- `final-a8835ad8-tier-10.json`
- `final-a8835ad8-tier-11.json`
- `final-a8835ad8-tier-12.json`
- `final-a8835ad8-tier-13-timing.json`
- `final-a8835ad8-tier-13-profile.json`

These files include every phase, optimizer counter, memory sample, output digest and
observable checksum collected by the permanent ladder. They are intentionally cache
artifacts rather than a replacement for the reviewed benchmark baseline.
