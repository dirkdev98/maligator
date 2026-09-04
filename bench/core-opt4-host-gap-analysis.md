# Core opt4 compiler host-gap analysis

Source: `c9e6c1d8c3807238b4a5f259345550914fb89a6d`

The kernels replay current compiler operation shapes. They are diagnostic evidence, not product baseline lanes. Node allocation is a V8 sampled-allocation estimate; Maligator allocation and collection deltas are exact runtime counters around the measured kernel. CPU and RSS come from an isolated resource probe, separate from the paired timing samples.

## Diagnosis

- First primitive ratio above 7x: typed-array-operations
- First algorithm ratio above 7x: pruned-ssa
- Top host-gap kernels: optimizer-queue, value-kinds, program-flow-convergence, spread-copies, pruned-ssa
- Top Maligator allocation kernels: moderate-retention-churn, pruned-ssa, iterator-generator-traversal, block-parameters, frozen-records

Modeled positive kernel-gap fractions:

- runtime-collections-properties: 14.3%
- function-closure-dispatch: 5.2%
- iterators-callbacks: 6.1%
- allocation-gc: 21.9%
- typed-arrays-numeric-loops: 46.9%
- compiler-algorithms: 5.6%
- unattributed-execution: 0.0%

These fractions classify the kernel ladder only. Full compiler owner coverage remains authoritative for the total self-host gap.

## Primitive kernels

| Kernel | Node ms | Maligator ms | Ratio | Gap ms | Maligator allocated bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| numeric-scalar-loops | 69.0 | 326.0 | 4.72x | 257.0 | 64 |
| typed-array-operations | 44.0 | 551.0 | 12.52x | 507.0 | 224 |
| dynamic-array-operations | 62.0 | 860.0 | 13.87x | 798.0 | 164,960,064 |
| map-operations | 51.0 | 252.0 | 4.94x | 201.0 | 183,572,544 |
| set-operations | 42.0 | 131.0 | 3.12x | 89.0 | 98,342,464 |
| stable-shape-properties | 76.0 | 473.0 | 6.22x | 397.0 | 948,480 |
| short-lived-records | 50.0 | 309.0 | 6.18x | 259.0 | 64 |
| spread-copies | 50.0 | 1040.0 | 20.80x | 990.0 | 192,000,144 |
| frozen-records | 71.0 | 144.0 | 2.03x | 73.0 | 230,400,064 |
| iterator-generator-traversal | 46.0 | 322.0 | 7.00x | 276.0 | 368,640,064 |
| for-of-collections | 52.0 | 229.0 | 4.40x | 177.0 | 2,115,152 |
| array-callbacks | 55.0 | 388.0 | 7.05x | 333.0 | 163,029,312 |
| direct-calls | 47.0 | 264.0 | 5.62x | 217.0 | 64 |
| indirect-calls | 42.0 | 197.0 | 4.69x | 155.0 | 480 |
| closure-calls | 75.0 | 548.0 | 7.31x | 473.0 | 7,936 |
| string-keys | 57.0 | 111.0 | 1.95x | 54.0 | 77,841,968 |
| sorting | 47.0 | 139.0 | 2.96x | 92.0 | 43,423,488 |
| low-retention-churn | 62.0 | 331.0 | 5.34x | 269.0 | 64 |
| moderate-retention-churn | 50.0 | 588.0 | 11.76x | 538.0 | 1,284,194,480 |

## Algorithm kernels

| Kernel | Node ms | Maligator ms | Ratio | Gap ms | Maligator allocated bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| pruned-ssa | 78.0 | 987.0 | 12.65x | 909.0 | 471,603,568 |
| dense-relocation | 48.0 | 432.0 | 9.00x | 384.0 | 384 |
| optimizer-queue | 77.0 | 2387.0 | 31.00x | 2310.0 | 384 |
| block-parameters | 43.0 | 419.0 | 9.74x | 376.0 | 231,214,080 |
| cfg-edges | 44.0 | 241.0 | 5.48x | 197.0 | 212,435,968 |
| immediate-dominators | 41.0 | 337.0 | 8.22x | 296.0 | 224 |
| value-kinds | 60.0 | 2234.0 | 37.23x | 2174.0 | 544 |
| canonical-roots | 43.0 | 605.0 | 14.07x | 562.0 | 352 |
| fact-provenance | 76.0 | 177.0 | 2.33x | 101.0 | 212,322,448 |
| memory-events | 60.0 | 541.0 | 9.02x | 481.0 | 186,448,256 |
| memory-versions | 55.0 | 337.0 | 6.13x | 282.0 | 32,438,944 |
| program-flow-extraction | 44.0 | 233.0 | 5.30x | 189.0 | 209,846,944 |
| program-flow-convergence | 67.0 | 1129.0 | 16.85x | 1062.0 | 384 |
| candidate-ranking | 44.0 | 142.0 | 3.23x | 98.0 | 36,086,528 |
| core-to-execution | 58.0 | 596.0 | 10.28x | 538.0 | 10,160,256 |
