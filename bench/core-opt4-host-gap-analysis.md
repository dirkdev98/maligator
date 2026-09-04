# Core opt4 compiler host-gap analysis

Source: `2a00b5f18656827561854de883ec7074ae68a43f`

The kernels replay current compiler operation shapes. They are diagnostic evidence, not product baseline lanes. Node allocation is a V8 sampled-allocation estimate; Maligator allocation and collection deltas are exact runtime counters around the measured kernel. CPU and RSS come from an isolated resource probe, separate from the paired timing samples.

## Diagnosis

- First primitive ratio above 7x: typed-array-operations
- First algorithm ratio above 7x: pruned-ssa
- Top host-gap kernels: optimizer-queue, value-kinds, spread-copies, dynamic-array-operations, moderate-retention-churn
- Top Maligator allocation kernels: moderate-retention-churn, iterator-generator-traversal, pruned-ssa, map-operations, block-parameters

Modeled positive kernel-gap fractions:

- runtime-collections-properties: 15.2%
- function-closure-dispatch: 6.0%
- iterators-callbacks: 6.7%
- allocation-gc: 23.6%
- typed-arrays-numeric-loops: 45.0%
- compiler-algorithms: 3.5%
- unattributed-execution: 0.0%

These fractions classify the kernel ladder only. Full compiler owner coverage remains authoritative for the total self-host gap.

## Primitive kernels

| Kernel                       | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ---------------------------- | ------: | -----------: | -----: | -----: | ------------------------: |
| numeric-scalar-loops         |    69.0 |        325.0 |  4.71x |  256.0 |                        64 |
| typed-array-operations       |    44.0 |        549.0 | 12.48x |  505.0 |                       224 |
| dynamic-array-operations     |    62.0 |        859.0 | 13.85x |  797.0 |               164,960,064 |
| map-operations               |    71.0 |        358.0 |  5.04x |  287.0 |               262,246,464 |
| set-operations               |    40.0 |        132.0 |  3.30x |   92.0 |                98,342,464 |
| stable-shape-properties      |    75.0 |        466.0 |  6.21x |  391.0 |                   948,480 |
| short-lived-records          |    50.0 |        308.0 |  6.16x |  258.0 |                        64 |
| spread-copies                |    51.0 |       1036.0 | 20.31x |  985.0 |               192,000,144 |
| frozen-records               |    71.0 |        143.0 |  2.01x |   72.0 |               230,400,064 |
| iterator-generator-traversal |    46.0 |        334.0 |  7.26x |  288.0 |               368,640,064 |
| for-of-collections           |    77.0 |        334.0 |  4.34x |  257.0 |                 2,979,152 |
| array-callbacks              |    55.0 |        389.0 |  7.07x |  334.0 |               163,029,312 |
| direct-calls                 |    47.0 |        262.0 |  5.57x |  215.0 |                        64 |
| indirect-calls               |    69.0 |        328.0 |  4.75x |  259.0 |                       480 |
| closure-calls                |    74.0 |        552.0 |  7.46x |  478.0 |                     7,936 |
| string-keys                  |    57.0 |        113.0 |  1.98x |   56.0 |                77,841,968 |
| sorting                      |    47.0 |        142.0 |  3.02x |   95.0 |                43,423,488 |
| low-retention-churn          |    62.0 |        331.0 |  5.34x |  269.0 |                        64 |
| moderate-retention-churn     |    69.0 |        848.0 | 12.29x |  779.0 |             1,800,388,784 |

## Algorithm kernels

| Kernel                   | Node ms | Maligator ms |  Ratio | Gap ms | Maligator allocated bytes |
| ------------------------ | ------: | -----------: | -----: | -----: | ------------------------: |
| pruned-ssa               |    44.0 |        594.0 | 13.50x |  550.0 |               282,962,288 |
| dense-relocation         |    47.0 |        426.0 |  9.06x |  379.0 |                       384 |
| optimizer-queue          |    78.0 |       2378.0 | 30.49x | 2300.0 |                       384 |
| block-parameters         |    46.0 |        454.0 |  9.87x |  408.0 |               247,614,080 |
| cfg-edges                |    44.0 |        239.0 |  5.43x |  195.0 |               212,435,968 |
| immediate-dominators     |    41.0 |        333.0 |  8.12x |  292.0 |                       224 |
| value-kinds              |    59.0 |       2220.0 | 37.63x | 2161.0 |                       544 |
| canonical-roots          |    45.0 |        597.0 | 13.27x |  552.0 |                       352 |
| fact-provenance          |    77.0 |        179.0 |  2.32x |  102.0 |               212,322,448 |
| memory-events            |    58.0 |        547.0 |  9.43x |  489.0 |               186,448,256 |
| memory-versions          |    54.0 |        339.0 |  6.28x |  285.0 |                32,438,944 |
| program-flow-extraction  |    44.0 |        232.0 |  5.27x |  188.0 |               209,846,944 |
| program-flow-convergence |    45.0 |        776.0 | 17.24x |  731.0 |                       384 |
| candidate-ranking        |    44.0 |        143.0 |  3.25x |   99.0 |                36,086,528 |
| core-to-execution        |    57.0 |        588.0 | 10.32x |  531.0 |                10,160,256 |
