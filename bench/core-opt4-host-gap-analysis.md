# Core opt4 compiler host-gap analysis

Source: `668ceeae958e8e5e35f6d5599c2b01d596acc095`

The kernels replay current compiler operation shapes. They are diagnostic evidence, not product baseline lanes. Node allocation is a V8 sampled-allocation estimate; Maligator allocation and collection deltas are exact runtime counters around the measured kernel. CPU and RSS come from an isolated resource probe, separate from the paired timing samples.

## Diagnosis

- First primitive ratio above 7x: dynamic-array-operations
- First algorithm ratio above 7x: pruned-ssa
- Top host-gap kernels: optimizer-queue, value-kinds, spread-copies, pruned-ssa, program-flow-convergence
- Top Maligator allocation kernels: moderate-retention-churn, pruned-ssa, iterator-generator-traversal, map-operations, block-parameters

Modeled positive kernel-gap fractions:

- runtime-collections-properties: 15.7%
- function-closure-dispatch: 5.8%
- iterators-callbacks: 6.2%
- allocation-gc: 24.6%
- typed-arrays-numeric-loops: 41.9%
- compiler-algorithms: 5.8%
- unattributed-execution: 0.0%

These fractions classify the kernel ladder only. Full compiler owner coverage remains authoritative for the total self-host gap.

## Full compiler owners

Artifact: `bench/core-opt4-after-typed-arrays.json`

- Warm total: 17373.7 ms Node, 189490.1 ms Maligator, 10.91x
- Optimizer attribution: 100.0% Node, 100.0% Maligator
- Host-gap attribution: 100.1%
- Allocation attribution: 100.0%
- Top host-gap owners: other function optimization passes, semantic-to-Core construction, Core verification, program-flow convergence, local value kinds
- Top Maligator allocation owners: emission, semantic-to-Core construction, Core-to-Execution lowering, other function optimization passes, Execution-to-Image lowering
- Slice 3 ranking qualifiers: other function optimization passes, semantic-to-Core construction, Core verification, program-flow convergence, local value kinds, Core-to-Execution lowering, fused local optimization, emission, optimizer orchestration, block-parameter simplification

| Owner                                     | Node ms | Maligator ms |  Ratio |  Gap ms | Maligator allocated bytes | Representative kernels                  |
| ----------------------------------------- | ------: | -----------: | -----: | ------: | ------------------------: | --------------------------------------- |
| other function optimization passes        |  1578.0 |      23642.0 | 14.98x | 22064.0 |             4,879,515,488 | optimizer-queue, candidate-ranking      |
| semantic-to-Core construction             |  1950.0 |      21756.0 | 11.16x | 19806.0 |             6,943,108,392 | pruned-ssa, short-lived-records         |
| Core verification                         |  1259.0 |      18181.0 | 14.44x | 16922.0 |             4,258,409,566 | set-operations, stable-shape-properties |
| program-flow convergence                  |  1283.0 |      16050.0 | 12.51x | 14767.0 |             2,533,385,648 | program-flow-convergence                |
| local value kinds                         |   576.0 |      12463.0 | 21.64x | 11887.0 |             1,250,733,432 | value-kinds                             |
| Core-to-Execution lowering                |  1503.0 |      12322.0 |  8.20x | 10819.0 |             6,406,867,280 | core-to-execution                       |
| fused local optimization                  |   499.0 |      11303.0 | 22.65x | 10804.0 |               690,456,384 | optimizer-queue                         |
| emission                                  |  1337.0 |      10310.0 |  7.71x |  8973.0 |            12,598,778,550 | string-keys, spread-copies              |
| optimizer orchestration                   |   398.0 |       8904.0 | 22.37x |  8506.0 |             1,192,489,470 | unmapped                                |
| block-parameter simplification            |   561.0 |       6073.0 | 10.83x |  5512.0 |             2,414,022,768 | block-parameters                        |
| Execution-to-Image lowering               |  1669.0 |       7122.0 |  4.27x |  5453.0 |             4,695,675,282 | core-to-execution                       |
| forwarding and linear block normalization |   457.0 |       5181.0 | 11.34x |  4724.0 |             2,100,304,528 | optimizer-queue, candidate-ranking      |
| memoryVersions / MemorySSA                |   907.0 |       5346.0 |  5.89x |  4439.0 |             2,251,231,944 | memory-versions                         |
| local fact and provenance construction    |   363.0 |       4502.0 | 12.40x |  4139.0 |             1,518,177,664 | fact-provenance                         |
| CFG edge construction                     |   486.0 |       4282.0 |  8.81x |  3796.0 |             1,906,233,128 | cfg-edges                               |
| construction structural cleanup           |   152.0 |       3163.0 | 20.81x |  3011.0 |               107,506,160 | pruned-ssa, moderate-retention-churn    |
| canonical value roots                     |   219.0 |       3062.0 | 13.98x |  2843.0 |               725,867,720 | canonical-roots                         |
| dense generation barrier                  |   268.0 |       2690.0 | 10.04x |  2422.0 |             1,134,425,168 | dense-relocation                        |
| specialization discovery                  |   259.0 |       2482.0 |  9.58x |  2223.0 |               419,460,616 | candidate-ranking, closure-calls        |
| immediate dominators                      |   264.0 |       2359.0 |  8.94x |  2095.0 |               798,294,000 | immediate-dominators                    |
| control-flow traversal                    |   237.0 |       1851.0 |  7.81x |  1614.0 |               617,315,440 | cfg-edges                               |
| semantic analysis                         |   277.0 |       1882.0 |  6.79x |  1605.0 |             1,120,079,536 | unmapped                                |
| loops and dominance frontiers             |   179.0 |       1447.0 |  8.08x |  1268.0 |               472,625,264 | unmapped                                |
| memory event extraction                   |   102.0 |       1289.0 | 12.64x |  1187.0 |               333,075,360 | memory-events                           |
| cross-call transforms                     |    60.0 |       1081.0 | 18.02x |  1021.0 |               441,095,896 | candidate-ranking, closure-calls        |
| program-flow local extraction             |    53.0 |        696.0 | 13.13x |   643.0 |               170,378,816 | program-flow-extraction, indirect-calls |
| module graph                              |   166.0 |        786.0 |  4.73x |   620.0 |               260,839,410 | unmapped                                |
| specialization selection                  |    17.0 |         65.0 |  3.82x |    48.0 |                         0 | candidate-ranking, closure-calls        |
| optimizer instrumentation                 |    10.0 |         58.0 |  5.80x |    48.0 |                 5,893,440 | unmapped                                |
| output writing                            |    56.0 |         82.0 |  1.46x |    26.0 |                     9,968 | unmapped                                |
| unattributed                              |     0.0 |          0.0 |    n/a |     0.0 |                         0 | unmapped                                |
| output serialization                      |     0.0 |          0.0 |    n/a |     0.0 |                         0 | unmapped                                |

Associated positive full-compiler owner-gap fractions:

- runtime-collections-properties: 16.2%
- function-closure-dispatch: 1.9%
- iterators-callbacks: 0.0%
- allocation-gc: 32.3%
- typed-arrays-numeric-loops: 27.2%
- compiler-algorithms: 22.4%
- unattributed-execution: 0.0%

The category association maps measured owner gaps to their representative kernels; it is a ranking model, not a claim that one primitive alone explains an owner's complete cost.

## Primitive kernels

| Kernel                       | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ---------------------------- | ------: | -----------: | -----: | -----: | ------------------------: |
| numeric-scalar-loops         |    36.0 |        175.0 |  4.86x |  139.0 |                        64 |
| typed-array-operations       |    45.0 |        260.0 |  5.78x |  215.0 |                       224 |
| dynamic-array-operations     |    68.0 |        873.0 | 12.84x |  805.0 |               164,960,064 |
| map-operations               |    73.0 |        366.0 |  5.01x |  293.0 |               262,246,464 |
| set-operations               |    43.0 |        135.0 |  3.14x |   92.0 |                98,342,464 |
| stable-shape-properties      |    76.0 |        479.0 |  6.30x |  403.0 |                   948,480 |
| short-lived-records          |    50.0 |        308.0 |  6.16x |  258.0 |                        64 |
| spread-copies                |    52.0 |       1073.0 | 20.63x | 1021.0 |               192,000,144 |
| frozen-records               |    70.0 |        144.0 |  2.06x |   74.0 |               230,400,064 |
| iterator-generator-traversal |    46.0 |        330.0 |  7.17x |  284.0 |               368,640,064 |
| for-of-collections           |    75.0 |        336.0 |  4.48x |  261.0 |                 2,979,152 |
| array-callbacks              |   151.0 |        377.0 |  2.50x |  226.0 |               163,029,312 |
| direct-calls                 |    68.0 |        379.0 |  5.57x |  311.0 |                        64 |
| indirect-calls               |    67.0 |        314.0 |  4.69x |  247.0 |                       480 |
| closure-calls                |    52.0 |        392.0 |  7.54x |  340.0 |                     7,936 |
| string-keys                  |    57.0 |        116.0 |  2.04x |   59.0 |                77,841,968 |
| sorting                      |    48.0 |        139.0 |  2.90x |   91.0 |                43,423,488 |
| low-retention-churn          |    62.0 |        332.0 |  5.35x |  270.0 |                        64 |
| moderate-retention-churn     |    70.0 |        848.0 | 12.11x |  778.0 |             1,800,388,784 |

## Algorithm kernels

| Kernel                   | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ------------------------ | ------: | -----------: | -----: | -----: | ------------------------: |
| pruned-ssa               |    77.0 |        980.0 | 12.73x |  903.0 |               471,603,568 |
| dense-relocation         |    47.0 |        244.0 |  5.19x |  197.0 |                       384 |
| optimizer-queue          |    82.0 |       2275.0 | 27.74x | 2193.0 |                       384 |
| block-parameters         |    44.0 |        429.0 |  9.75x |  385.0 |               231,214,080 |
| cfg-edges                |    44.0 |        239.0 |  5.43x |  195.0 |               212,435,968 |
| immediate-dominators     |    42.0 |        311.0 |  7.40x |  269.0 |                       224 |
| value-kinds              |    60.0 |       2110.0 | 35.17x | 2050.0 |                       544 |
| canonical-roots          |    44.0 |        605.0 | 13.75x |  561.0 |                       352 |
| fact-provenance          |    79.0 |        177.0 |  2.24x |   98.0 |               212,322,448 |
| memory-events            |    60.0 |        554.0 |  9.23x |  494.0 |               186,448,256 |
| memory-versions          |    55.0 |        341.0 |  6.20x |  286.0 |                32,438,944 |
| program-flow-extraction  |    45.0 |        241.0 |  5.36x |  196.0 |               209,846,944 |
| program-flow-convergence |    64.0 |        910.0 | 14.22x |  846.0 |                       384 |
| candidate-ranking        |    44.0 |        142.0 |  3.23x |   98.0 |                36,086,528 |
| core-to-execution        |    58.0 |        576.0 |  9.93x |  518.0 |                10,160,256 |
