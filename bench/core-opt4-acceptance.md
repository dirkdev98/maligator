# Core opt4 closure audit

## Status

**NOT ACCEPTED.** The opt4 investigation and this audit are complete, but the
implementation does not meet the plan's final performance gates. The permanent
baseline and the accepted architecture record were therefore left unchanged.

This is an active-device reference dated 2026-09-04. It is deliberately not
presented as the quiet, repeated campaign required for acceptance.

## Revisions and identities

| Item                                  | Value                                                              |
| ------------------------------------- | ------------------------------------------------------------------ |
| Report-preparation HEAD               | `7d3526d30999b51ac1914214d0918821c0387bff`                         |
| Final self-compile measurement source | `db918b071ef05d047b28fd1fb6d69da14f4884ab`                         |
| Self-compile source digest            | `3df7f0d2361b5ea7d318223fecf276915f5601a684e92fd1612883cb173d4907` |
| Benchmark digest                      | `427d7ef335c3934116ef753857d46514ab5178e3ce6d395412f19f64c6d9b775` |
| Configuration digest                  | `1509e8d492d351fcfb6821fda64cada15f933cc8591ba1c871f812c9728a051a` |
| Final output-matrix source            | `f74c2fa9fef82a7540455e83ebb558b84457d415`                         |
| Final ladder report source            | `668ceeae958e8e5e35f6d5599c2b01d596acc095`                         |
| Platform                              | Apple M3 Pro, arm64 macOS, Node v26.7.0                            |

The report-only and documentation commits after the measured sources do not
change compiler or runtime output. `7d3526d3` changes native command resource
collection and was separately verified with a forced fresh measured native
build.

## Slice requirement audit

| Slice                | Result                 | Evidence and remaining requirement                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — quiet baseline   | **Fail**               | Isolated Tier 17/Tier 18 instrumentation, owner attribution, and parity exist, but the retained references were captured on an active device. Only one final warm pair was captured, and `bench/core-opt4-output-start.json` was never produced.                                          |
| 1 — Node closure     | **Fail**               | One measured admission correction was retained and the rejected experiments are recorded. Final Node wall and optimizer time remain above target, the final five-sample campaign was not repeated, and several qualifying owners remain.                                                  |
| 2 — host-gap ladder  | **Pass for diagnosis** | The permanent 34-kernel ladder has work/checksum parity, identifies the first ratio cliffs, maps the top owners to representative kernels, and attributes effectively all measured full-compiler time and allocation.                                                                     |
| 3 — host-gap closure | **Fail**               | Three general TypedArray corrections were retained, but the total ratio is 10.907x rather than at most 7x. Allocation, RSS, phase-ratio, and repeated-sample gates fail. No independent allocation/GC correction was retained.                                                            |
| 4 — native build     | **Fail**               | Attribution shows one 57.2 MB generated-C translation unit consuming 204.1 seconds of the 210.7-second build. No native-build correction meeting the independent 10% rule was found.                                                                                                      |
| 5 — completion       | **Fail**               | The complete dual-host ladder, output matrix, and cold `test:check` were repeated. The final repeated five-warm Tier 18 campaign, complete final Node ladder, and family-ablation matrix were not run because earlier hard gates already failed. Baseline adoption was correctly skipped. |

## Retained implementation work

| Commit                               | Retained correction                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `e65eb9b6`                           | Admit `fold-exact-allocation-observations` only where an operand can resolve to an allocation.                      |
| `9b6c832f`, re-applied by `d8d34199` | Lower exact TypedArray loads from Core-owned proof metadata.                                                        |
| `4d9c1b77`, re-applied by `d45285b5` | Lower exact TypedArray stores while retaining generic fallback semantics.                                           |
| `2725a197`, re-applied by `db918b07` | Prove contained fixed-storage TypedArrays in Core and lower direct length/load/store plans.                         |
| `c3098658`                           | Register the new TypedArray refinement pass in the optimizer ownership matrix.                                      |
| `7d3526d3`                           | Remove the self-host compiler's unsupported `spawnSync` dependency while preserving native-command RSS measurement. |

The host-gap runner, owner/resource telemetry, and retained reports were added
by `c9e6c1d8`, `84903083`, `2a00b5f1`, `78d78f6a`, `8ece735d`,
`c12b6aad`, `5f71b2a0`, `c726c283`, `668ceeae`, and `133b6646`.

## Rejected experiments

All rejected implementations were removed or reverted. The retained history and
artifacts cover:

- value-kind observation admission;
- single-predecessor MemorySSA bookkeeping omission;
- fresh-own-slot forwarding admission;
- stack-object cell admission;
- two `hasControlCycle` allocation variants;
- direct intrusive body iteration;
- CFG-successor reuse in immediate dominators;
- typed-array dominance-position storage in MemorySSA;
- lazy and eager program-flow structural-caller ownership;
- dense verifier membership storage;
- a shared CFG edge argument getter;
- effective-read-only memory-forwarding admission;
- batched block-parameter removal;
- allocation-free builtin-call scanning;
- aggregate scalar-replacement admission;
- direct empty-forwarding-block tests;
- inlined contained dynamic-array push/pop helpers (`f9292410`, reverted by `717182ec`);
- fixed-count `push` pre-reservation (`510d2ace`, `2e56f847`, `87d8ed5c`, reverted by `60046922`, `7b08aba3`, `f74c2fa9`).

The dynamic-array helper inline candidate was neutral (+0.09% Maligator time in
the exact matched check). The reserve candidate did not reach the real nested
compiler loop and did not change runtime or allocation; widening its structural
admission also violated the existing alternate-producer policy test.

## Final self-compile reference

Artifact: `bench/core-opt4-after-typed-arrays.json`.

| Metric             |          Node |      Maligator |   Ratio |
| ------------------ | ------------: | -------------: | ------: |
| Total              | 17,373.673 ms | 189,490.073 ms | 10.907x |
| Graph              |        167 ms |         746 ms |  4.467x |
| Semantic           |        277 ms |       1,883 ms |  6.798x |
| Construct Core     |      1,968 ms |      21,748 ms | 11.051x |
| Optimize Core      |     10,045 ms |     135,440 ms | 13.483x |
| Core to Execution  |      1,526 ms |      12,231 ms |  8.015x |
| Execution to Image |      1,788 ms |       7,041 ms |  3.938x |
| Emit               |      1,378 ms |      10,308 ms |  7.480x |
| Write              |         17 ms |          65 ms |  3.824x |

Corresponding Node and Maligator samples have identical generated-unit counts,
digests, observable checksums, and optimizer work counters.

### Warm and cold samples

The final artifact contains one warm pair, not the required five:

| Sample |          Node |      Maligator | Code units | Pair digest parity |
| ------ | ------------: | -------------: | ---------: | ------------------ |
| warm 1 | 17,373.673 ms | 189,490.073 ms | 60,197,024 | yes                |
| cold 1 | 17,141.099 ms | 189,350.887 ms | 60,197,710 | yes                |
| cold 2 | 17,246.558 ms | 190,295.782 ms | 60,197,710 | yes                |
| cold 3 | 17,288.409 ms | 190,804.170 ms | 60,197,710 | yes                |

The most recent five-warm isolated Node campaign at the earlier retained
`e65eb9b6` checkpoint measured 17,961.773, 17,874.045, 18,103.907,
17,966.653, and 18,000.095 ms. It is historical context, not a substitute for
the missing final five-pair campaign.

### Runtime and memory

| Metric          |          Final | Slice 0 active-device reference |  Change |       Required |
| --------------- | -------------: | ------------------------------: | ------: | -------------: |
| Allocated bytes | 62,242,489,814 |                  61,522,693,492 |  +1.17% |    at most 70% |
| Collections     |            396 |                             374 |  +5.88% |     diagnostic |
| Peak live bytes |    248,928,000 |                     258,045,632 |  -3.53% |    at most 80% |
| Maximum pause   |     421.832 ms |                      471.143 ms | -10.47% |    at most 60% |
| Runtime RSS     |  2,149,335,040 |                   2,192,474,112 |  -1.97% |    at most 80% |
| Node peak RSS   |  1,854,439,424 |                               — |       — | at most 2.0 GB |

The earlier final-instrumentation Node profile at `e65eb9b6` reached 916,578,344
bytes managed heap and 1,707,278,336 bytes RSS. Its isolated ordinary warm
samples reached 1.90 GB managed heap and 2.41 GB RSS, so the repeated final
memory gate is unresolved and cannot be marked passed from the single newer
sample.

## Full owner host-gap table

The final owner sample attributes 100% of Node optimizer time, 99.998% of
Maligator optimizer time, 100.108% of the measured host gap within timer noise,
and 100% of Maligator allocation.

|  ID | Owner                                     | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| --: | ----------------------------------------- | ------: | -----------: | -----: | -----: | ------------------------: |
|   0 | unattributed                              |       0 |            0 |    n/a |      0 |                         0 |
|   1 | semantic-to-Core construction             |   1,950 |       21,756 | 11.16x | 19,806 |             6,943,108,392 |
|   2 | construction structural cleanup           |     152 |        3,163 | 20.81x |  3,011 |               107,506,160 |
|   3 | dense generation barrier                  |     268 |        2,690 | 10.04x |  2,422 |             1,134,425,168 |
|   4 | fused local optimization                  |     499 |       11,303 | 22.65x | 10,804 |               690,456,384 |
|   5 | block-parameter simplification            |     561 |        6,073 | 10.83x |  5,512 |             2,414,022,768 |
|   6 | forwarding and linear block normalization |     457 |        5,181 | 11.34x |  4,724 |             2,100,304,528 |
|   7 | CFG edge construction                     |     486 |        4,282 |  8.81x |  3,796 |             1,906,233,128 |
|   8 | control-flow traversal                    |     237 |        1,851 |  7.81x |  1,614 |               617,315,440 |
|   9 | immediate dominators                      |     264 |        2,359 |  8.94x |  2,095 |               798,294,000 |
|  10 | loops and dominance frontiers             |     179 |        1,447 |  8.08x |  1,268 |               472,625,264 |
|  11 | local value kinds                         |     576 |       12,463 | 21.64x | 11,887 |             1,250,733,432 |
|  12 | canonical value roots                     |     219 |        3,062 | 13.98x |  2,843 |               725,867,720 |
|  13 | local fact and provenance construction    |     363 |        4,502 | 12.40x |  4,139 |             1,518,177,664 |
|  14 | memory event extraction                   |     102 |        1,289 | 12.64x |  1,187 |               333,075,360 |
|  15 | memoryVersions / MemorySSA                |     907 |        5,346 |  5.89x |  4,439 |             2,251,231,944 |
|  16 | program-flow local extraction             |      53 |          696 | 13.13x |    643 |               170,378,816 |
|  17 | program-flow convergence                  |   1,283 |       16,050 | 12.51x | 14,767 |             2,533,385,648 |
|  18 | cross-call transforms                     |      60 |        1,081 | 18.02x |  1,021 |               441,095,896 |
|  19 | specialization discovery                  |     259 |        2,482 |  9.58x |  2,223 |               419,460,616 |
|  20 | specialization selection                  |      17 |           65 |  3.82x |     48 |                         0 |
|  21 | Core verification                         |   1,259 |       18,181 | 14.44x | 16,922 |             4,258,409,566 |
|  22 | Core-to-Execution lowering                |   1,503 |       12,322 |  8.20x | 10,819 |             6,406,867,280 |
|  23 | Execution-to-Image lowering               |   1,669 |        7,122 |  4.27x |  5,453 |             4,695,675,282 |
|  24 | emission                                  |   1,337 |       10,310 |  7.71x |  8,973 |            12,598,778,550 |
|  25 | other function optimization passes        |   1,578 |       23,642 | 14.98x | 22,064 |             4,879,515,488 |
|  26 | optimizer instrumentation                 |      10 |           58 |  5.80x |     48 |                 5,893,440 |
|  27 | optimizer orchestration                   |     398 |        8,904 | 22.37x |  8,506 |             1,192,489,470 |
|  28 | module graph                              |     166 |          786 |  4.73x |    620 |               260,839,410 |
|  29 | semantic analysis                         |     277 |        1,882 |  6.79x |  1,605 |             1,120,079,536 |
|  30 | output serialization                      |       0 |            0 |    n/a |      0 |                         0 |
|  31 | output writing                            |      56 |           82 |  1.46x |     26 |                     9,968 |

Owners still consuming at least 3% of total Maligator time are semantic-to-Core
construction, fused local optimization, block-parameter simplification, local
value kinds, program-flow convergence, Core verification, Core-to-Execution,
emission, other function optimization passes, and optimizer orchestration.
Several remain above 10x without a repeated owner-specific correction, so the
Slice 3 owner gate fails.

## Complete host-gap ladder

Artifact: `bench/core-opt4-host-gap-analysis.json` and rendered report
`bench/core-opt4-host-gap-analysis.md`.

- 34 kernels completed with identical operations and checksums.
- The first primitive above 7x is now `dynamic-array-operations` at 12.84x.
- `typed-array-operations` moved below the cliff to 5.78x (45 ms Node, 260 ms
  Maligator) after the retained TypedArray corrections.
- The first algorithm above 7x is `pruned-ssa` at 12.73x.
- The largest kernel gaps are optimizer queue (27.74x), value kinds (35.17x),
  spread copies (20.63x), pruned SSA (12.73x), and program-flow convergence
  (14.22x).

The exact high-duration contained-TypedArray A/B moved Maligator from 1,106 ms
to 649 ms while Node moved from 111 ms to 110 ms: -41.32% Maligator time and
-45.83% host gap with equal operations and checksum. The complete compiler did
not inherit that magnitude because TypedArray indexing is only one fraction of
its remaining owners.

The complete final Node complexity ladder was not repeated after the TypedArray
work. Earlier Slice 1 lower-tier screens and the final Tier 17/Tier 18 sources
remain available, but this missing final repetition is a failed acceptance
requirement rather than inferred success.

## Native-build attribution

| Metric              | Slice 0 reference |            Final | Change | Gate                                   |
| ------------------- | ----------------: | ---------------: | -----: | -------------------------------------- |
| Total build         |        212,482 ms |       210,735 ms | -0.82% | **Fail**, needs at most 75%            |
| Generated C compile |        205,262 ms |       204,106 ms | -0.56% | **Fail**, needs at most 75%            |
| Peak RSS            |     4,646,797,312 |    4,543,676,416 | -2.22% | **Fail**, needs at most 80% and 3.0 GB |
| Generated C         |  57,008,292 bytes | 57,187,766 bytes | +0.31% | **Fail**, needs at most 100%           |
| Object output       |  36,149,864 bytes | 36,265,496 bytes | +0.32% | Pass, below 102%                       |

Final subphases were runtime projection 891 ms, runtime C compilation 2,005 ms,
generated C writing 88 ms, generated C object compilation 204,106 ms, linking
281 ms, and binary publication 172 ms. The generated program remains one
translation unit. Preprocessing/frontend/backend and LTO were not independently
split by a compiler time trace, and final binary bytes were not recorded.

The dominant remaining native-build problem is therefore the single generated
C translation unit and its compiler frontend/optimization work. No general
partitioning or encoding correction was attempted without a design-sized slice.

## Emitted-output matrix

Artifact: `bench/core-opt4-output-final.json`; five rotated samples per mode or
HTTP subject, with matching observable checksums.

| JavaScript mode    | Final median | Change from saved baseline | Result                 |
| ------------------ | -----------: | -------------------------: | ---------------------- |
| Node               |     351.0 ms |                      -1.1% | reference              |
| closed compiled    |   2,590.5 ms |                     +87.8% | **Fail**               |
| open compiled      |   2,591.1 ms |                     +24.7% | **Fail**               |
| closed interpreted |   4,028.9 ms |                      +4.7% | **Fail**               |
| open interpreted   |   4,032.4 ms |                     -17.7% | pass for runtime delta |

| HTTP lane      | Final throughput | Throughput delta |      p99 | p99 delta |
| -------------- | ---------------: | ---------------: | -------: | --------: |
| bare           |    162,085 req/s |           +0.55% | 0.787 ms |    -2.16% |
| Express routes |     26,964 req/s |           +0.15% | 2.685 ms |    -0.96% |
| Express JSON   |     19,386 req/s |           -1.12% | 3.423 ms |    +0.59% |
| Express form   |     16,072 req/s |           +0.21% | 3.979 ms |    -1.36% |

The Express geometric mean is 20,329 req/s, 0.26% below the saved baseline.
Individual HTTP throughput and p99 guards pass, as do the at-most-2% binary
growth guards. The plan's separate at-least-108%-of-opt3 Express gate is not
demonstrated, and no output/native-build metric improved by 10%. The
optimization-family profitability matrix was not repeated, so that acceptance
requirement also fails.

## Correctness and Tier 19

| Command                       | Result                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run type-check`          | pass                                                                                                                                                                             |
| `npm run lint:ci`             | pass                                                                                                                                                                             |
| `npm run test:unit`           | 113 files, 1,344 tests passed                                                                                                                                                    |
| `npm run test:smoke`          | pass in 46.1 s                                                                                                                                                                   |
| `npm run test262:regressions` | 259/259 selected files passed in strict/sloppy combined result                                                                                                                   |
| `npm run selfhost:frontend`   | byte-identical output passed in 2m18s                                                                                                                                            |
| `npm run selfhost:native`     | isolated native/eval parity passed in 4m25s                                                                                                                                      |
| `npm run selfhost:cli`        | isolated distributed CLI passed in 3m55s                                                                                                                                         |
| `npm run test:check`          | cold-cache 11-stage gate passed in 3m08s; 1,344 unit tests, 36 native-normal tests plus one skip, 60 UBSan tests, 252 Test262 regression files, and 106 WPT files/1,541 subtests |
| `git diff --check`            | pass                                                                                                                                                                             |

Full canonical Test262, `test:full`, and `test:full:report` were not run because
they require separate authorization.

## Final gate decision

| Gate family                                                | Decision                             |
| ---------------------------------------------------------- | ------------------------------------ |
| Quiet and repeated measurement                             | **Fail**                             |
| Node wall and optimizer time                               | **Fail**                             |
| Node construct time                                        | Pass in the single final warm sample |
| Node repeated RSS/managed heap                             | **Fail / unresolved**                |
| Work, checksum, and output parity                          | Pass                                 |
| Owner attribution coverage                                 | Pass                                 |
| Maligator total and phase ratios                           | **Fail**                             |
| Maligator allocation, peak-live, pause, and RSS reductions | **Fail**                             |
| Native-build time and RSS                                  | **Fail**                             |
| JavaScript emitted runtime                                 | **Fail**                             |
| HTTP per-lane throughput and p99                           | Pass                                 |
| Complete final Node ladder                                 | **Fail / not repeated**              |
| Complete final dual-host ladder                            | Pass                                 |
| Optimization-family profitability                          | **Fail / not repeated**              |
| Tier 19 correctness                                        | Pass in 3m08s                        |
| Baseline adoption                                          | Correctly skipped                    |

The next measured performance reference should start at dynamic arrays for the
first primitive cliff, then optimizer queue/value kinds/program-flow for the
largest allocation-free algorithm gaps. Native build closure requires a
separate generated-translation-unit design slice; it is not a small cleanup.
