# Core opt4 compiler host-gap analysis

Source: `c12b6aadab7c4f88a3386eb2ee7b46c14ecaaf17`

The kernels replay current compiler operation shapes. They are diagnostic evidence, not product baseline lanes. Node allocation is a V8 sampled-allocation estimate; Maligator allocation and collection deltas are exact runtime counters around the measured kernel. CPU and RSS come from an isolated resource probe, separate from the paired timing samples.

## Diagnosis

- First primitive ratio above 7x: typed-array-operations
- First algorithm ratio above 7x: pruned-ssa
- Top host-gap kernels: optimizer-queue, value-kinds, spread-copies, pruned-ssa, dynamic-array-operations
- Top Maligator allocation kernels: moderate-retention-churn, pruned-ssa, iterator-generator-traversal, map-operations, block-parameters

Modeled positive kernel-gap fractions:

- runtime-collections-properties: 15.1%
- function-closure-dispatch: 4.4%
- iterators-callbacks: 6.7%
- allocation-gc: 23.5%
- typed-arrays-numeric-loops: 44.6%
- compiler-algorithms: 5.7%
- unattributed-execution: 0.0%

These fractions classify the kernel ladder only. Full compiler owner coverage remains authoritative for the total self-host gap.

## Full compiler owners

Artifact: `bench/core-opt4-host-gap-start.json`

- Warm total: 17159.0 ms Node, 188055.2 ms Maligator, 10.96x
- Optimizer attribution: 100.0% Node, 100.0% Maligator
- Host-gap attribution: 100.1%
- Allocation attribution: 100.0%
- Top host-gap owners: other function optimization passes, semantic-to-Core construction, Core verification, program-flow convergence, local value kinds
- Top Maligator allocation owners: emission, semantic-to-Core construction, Core-to-Execution lowering, other function optimization passes, Execution-to-Image lowering
- Slice 3 ranking qualifiers: other function optimization passes, semantic-to-Core construction, Core verification, program-flow convergence, local value kinds, Core-to-Execution lowering, fused local optimization, emission, optimizer orchestration, block-parameter simplification

| Owner                                     | Node ms | Maligator ms |  Ratio |  Gap ms | Maligator allocated bytes | Representative kernels                  |
| ----------------------------------------- | ------: | -----------: | -----: | ------: | ------------------------: | --------------------------------------- |
| other function optimization passes        |  1564.0 |      22785.0 | 14.57x | 21221.0 |             4,745,028,064 | optimizer-queue, candidate-ranking      |
| semantic-to-Core construction             |  1964.0 |      21870.0 | 11.14x | 19906.0 |             6,920,920,336 | pruned-ssa, short-lived-records         |
| Core verification                         |  1225.0 |      18560.0 | 15.15x | 17335.0 |             4,246,260,538 | set-operations, stable-shape-properties |
| program-flow convergence                  |  1269.0 |      15795.0 | 12.45x | 14526.0 |             2,527,256,424 | program-flow-convergence                |
| local value kinds                         |   521.0 |      12208.0 | 23.43x | 11687.0 |             1,054,306,184 | value-kinds                             |
| Core-to-Execution lowering                |  1506.0 |      12351.0 |  8.20x | 10845.0 |             6,386,427,424 | core-to-execution                       |
| fused local optimization                  |   519.0 |      11353.0 | 21.87x | 10834.0 |               688,429,912 | optimizer-queue                         |
| emission                                  |  1315.0 |      10275.0 |  7.81x |  8960.0 |            12,474,674,304 | string-keys, spread-copies              |
| optimizer orchestration                   |   376.0 |       8306.0 | 22.09x |  7930.0 |             1,170,371,874 | unmapped                                |
| block-parameter simplification            |   523.0 |       6359.0 | 12.16x |  5836.0 |             2,404,563,128 | block-parameters                        |
| Execution-to-Image lowering               |  1702.0 |       7100.0 |  4.17x |  5398.0 |             4,681,672,082 | core-to-execution                       |
| forwarding and linear block normalization |   460.0 |       5371.0 | 11.68x |  4911.0 |             2,092,197,784 | optimizer-queue, candidate-ranking      |
| memoryVersions / MemorySSA                |   897.0 |       5359.0 |  5.97x |  4462.0 |             2,209,401,552 | memory-versions                         |
| local fact and provenance construction    |   320.0 |       4352.0 | 13.60x |  4032.0 |             1,455,604,584 | fact-provenance                         |
| CFG edge construction                     |   494.0 |       4392.0 |  8.89x |  3898.0 |             1,897,221,848 | cfg-edges                               |
| construction structural cleanup           |   153.0 |       3279.0 | 21.43x |  3126.0 |               107,145,456 | pruned-ssa, moderate-retention-churn    |
| canonical value roots                     |   232.0 |       3053.0 | 13.16x |  2821.0 |               721,443,288 | canonical-roots                         |
| dense generation barrier                  |   274.0 |       2692.0 |  9.82x |  2418.0 |             1,130,855,312 | dense-relocation                        |
| immediate dominators                      |   246.0 |       2556.0 | 10.39x |  2310.0 |               790,751,440 | immediate-dominators                    |
| specialization discovery                  |   272.0 |       2562.0 |  9.42x |  2290.0 |               418,377,296 | candidate-ranking, closure-calls        |
| semantic analysis                         |   274.0 |       1894.0 |  6.91x |  1620.0 |             1,117,110,736 | unmapped                                |
| control-flow traversal                    |   222.0 |       1709.0 |  7.70x |  1487.0 |               613,442,496 | cfg-edges                               |
| memory event extraction                   |   103.0 |       1456.0 | 14.14x |  1353.0 |               328,892,624 | memory-events                           |
| loops and dominance frontiers             |   163.0 |       1421.0 |  8.72x |  1258.0 |               467,697,936 | unmapped                                |
| cross-call transforms                     |    56.0 |       1231.0 | 21.98x |  1175.0 |               440,402,088 | candidate-ranking, closure-calls        |
| program-flow local extraction             |    56.0 |        667.0 | 11.91x |   611.0 |               169,859,568 | program-flow-extraction, indirect-calls |
| module graph                              |   165.0 |        770.0 |  4.67x |   605.0 |               260,240,390 | unmapped                                |
| specialization selection                  |    14.0 |         66.0 |  4.71x |    52.0 |                         0 | candidate-ranking, closure-calls        |
| optimizer instrumentation                 |    11.0 |         61.0 |  5.55x |    50.0 |                 5,884,224 | unmapped                                |
| output writing                            |    23.0 |         72.0 |  3.13x |    49.0 |                     9,968 | unmapped                                |
| unattributed                              |     0.0 |          0.0 |   n/ax |     0.0 |                         0 | unmapped                                |
| output serialization                      |     0.0 |          0.0 |   n/ax |     0.0 |                         0 | unmapped                                |

Associated positive full-compiler owner-gap fractions:

- runtime-collections-properties: 16.8%
- function-closure-dispatch: 2.0%
- iterators-callbacks: 0.0%
- allocation-gc: 32.5%
- typed-arrays-numeric-loops: 27.0%
- compiler-algorithms: 21.8%
- unattributed-execution: 0.0%

The category association maps measured owner gaps to their representative kernels; it is a ranking model, not a claim that one primitive alone explains an owner's complete cost.

## Primitive kernels

| Kernel                       | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ---------------------------- | ------: | -----------: | -----: | -----: | ------------------------: |
| numeric-scalar-loops         |    68.0 |        325.0 |  4.78x |  257.0 |                        64 |
| typed-array-operations       |    44.0 |        549.0 | 12.48x |  505.0 |                       224 |
| dynamic-array-operations     |    62.0 |        873.0 | 14.08x |  811.0 |               164,960,064 |
| map-operations               |    71.0 |        365.0 |  5.14x |  294.0 |               262,246,464 |
| set-operations               |    42.0 |        136.0 |  3.24x |   94.0 |                98,342,464 |
| stable-shape-properties      |    80.0 |        475.0 |  5.94x |  395.0 |                   948,480 |
| short-lived-records          |    50.0 |        308.0 |  6.16x |  258.0 |                        64 |
| spread-copies                |    51.0 |       1053.0 | 20.65x | 1002.0 |               192,000,144 |
| frozen-records               |    71.0 |        144.0 |  2.03x |   73.0 |               230,400,064 |
| iterator-generator-traversal |    46.0 |        327.0 |  7.11x |  281.0 |               368,640,064 |
| for-of-collections           |    75.0 |        349.0 |  4.65x |  274.0 |                 2,979,152 |
| array-callbacks              |    55.0 |        388.0 |  7.05x |  333.0 |               163,029,312 |
| direct-calls                 |    47.0 |        263.0 |  5.60x |  216.0 |                        64 |
| indirect-calls               |    43.0 |        196.0 |  4.56x |  153.0 |                       480 |
| closure-calls                |    54.0 |        402.0 |  7.44x |  348.0 |                     7,936 |
| string-keys                  |    58.0 |        116.0 |  2.00x |   58.0 |                77,841,968 |
| sorting                      |    47.0 |        143.0 |  3.04x |   96.0 |                43,423,488 |
| low-retention-churn          |    61.0 |        332.0 |  5.44x |  271.0 |                        64 |
| moderate-retention-churn     |    69.0 |        849.0 | 12.30x |  780.0 |             1,800,388,784 |

## Algorithm kernels

| Kernel                   | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ------------------------ | ------: | -----------: | -----: | -----: | ------------------------: |
| pruned-ssa               |    77.0 |        994.0 | 12.91x |  917.0 |               471,603,568 |
| dense-relocation         |    48.0 |        433.0 |  9.02x |  385.0 |                       384 |
| optimizer-queue          |    78.0 |       2376.0 | 30.46x | 2298.0 |                       384 |
| block-parameters         |    46.0 |        451.0 |  9.80x |  405.0 |               247,614,080 |
| cfg-edges                |    44.0 |        241.0 |  5.48x |  197.0 |               212,435,968 |
| immediate-dominators     |    41.0 |        333.0 |  8.12x |  292.0 |                       224 |
| value-kinds              |    60.0 |       2239.0 | 37.32x | 2179.0 |                       544 |
| canonical-roots          |    45.0 |        596.0 | 13.24x |  551.0 |                       352 |
| fact-provenance          |    77.0 |        178.0 |  2.31x |  101.0 |               212,322,448 |
| memory-events            |    58.0 |        549.0 |  9.47x |  491.0 |               186,448,256 |
| memory-versions          |    55.0 |        341.0 |  6.20x |  286.0 |                32,438,944 |
| program-flow-extraction  |    44.0 |        235.0 |  5.34x |  191.0 |               209,846,944 |
| program-flow-convergence |    45.0 |        777.0 | 17.27x |  732.0 |                       384 |
| candidate-ranking        |    44.0 |        143.0 |  3.25x |   99.0 |                36,086,528 |
| core-to-execution        |    58.0 |        589.0 | 10.16x |  531.0 |                10,160,256 |
