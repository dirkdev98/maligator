# Compiler budget follow-up, 2026-09-24

This records the accepted changes and matched measurements from the
`chore/comp-budgets` follow-up on `main`. Times are milliseconds. Each pair ran
nearby in alternating order after one warmup per variant. Generated output was
checked independently of elapsed time. The local host was an Apple M3 Pro with
Node 26.7.0; the `mjq` hash experiment used an isolated Intel i7-8809G worker
with Node 24.21.0. Do not compare absolute times between those hosts.

## Partition hashes during C emission

`2183714e` caches each prepared key's `stablePartitionHash` by 32-bit round
for one ordinary or native-overlay partition operation. The hash inputs,
seeds, bit selection, sorting, and unit IDs are unchanged.

SHA-256 of the serialized translation-unit arrays, including unit IDs, order,
and generated C, matched before and after the change for ordinary
partitioning at target 16,384 (38 units,
`4a88c4159bc1f05e8a7f5461fe41a88b2120e2733ae42c130fdb464f012f68b4`)
and target 2,097,152 (3 units,
`403d80d07edfff83879e03ee709c4e297365517a9eb435b147ce7cc7a0b08687`),
and for native-overlay partitioning at target 30,000 (8 units,
`3bcbb59fef6ddc474ea17b35f8cc1ec21d5ff964c4a174025018164f8abeb404`).
The 150 program-image emission tests passed. The remote full Node comparison
used baseline `ef12d5a0`, candidate `5833107a`, and `mjq` job
`job-20260924T190717-2c0170b289bab122` (`perf.compiler` with
`{"timeout_seconds":3600,"workers":1,"workload":"full","host":"node","pairs":3,"baseline":"ef12d5a0121836849c58dff92590ffa3a1f310df"}`).
Every run emitted 93 units,
95,598,300 code units, and digest
`f3fe05dec3bd79fbda31d3fa147f7b3aa6f19dcdae370e36a984b19c77b41051`.

| Pair | Baseline wall | Cached-hash wall | Baseline emit | Cached-hash emit |
| ---- | ------------: | ---------------: | ------------: | ---------------: |
| 1    |      93,009.1 |         92,091.6 |         8,102 |            7,995 |
| 2    |      92,062.8 |         92,764.0 |         8,418 |            8,187 |
| 3    |      92,551.2 |         92,789.8 |         8,445 |            8,399 |

Mean full Node time was 92,541.1 versus 92,548.5 ms. The pair reductions
were +0.99%, −0.76%, and −0.26%; this does not establish a full compilation
speedup. Emission alone averaged 8,321.7 versus 8,193.7 ms. The cache remains
because it removes repeat hashing with exact C parity and limited per-partition
state; the end-to-end gain is unproven.

The downstream C-compiler control used the same generated C in both labeled
conditions, as required by exact output parity. From a current-source full
compiler emission of 96 translation units using frozen input
`bench/self-compile.mts` (SHA-256
`fe18d5f487867499a846d9a4b815aabfaf8308f436d75851e7eba8e78d690ef4`),
it selected the largest code unit
(`self-compile-code-100101101001.c`, 4,999,110 bytes, SHA-256
`92c9e1dc24ca097c5e053af2c0a50578a202f52b61c26a56de830d2aa609eecb`)
and the largest data unit (`self-compile-data-10111101000011.c`, 2,457,280
bytes, SHA-256
`6b3c737a5694fbb9c712e27aa1f9478833178cc9c3140b5b763e82b8229e49df`).
It used Apple clang 21.0.0, the repository's development C compilation flags
(`-std=c2x -O2 -g0`, no LTO), and toolchain fingerprint
`3eec146f97b85a6c4ae31f80e7128f5f9b96bebaeaf7f97035db65043f2cbd8b`.
Each unit was compiled twice for warmup, followed by three alternating pairs.
Object bytes were compared by SHA-256. This measures the cost of a
representative unchanged C-compilation subset; any difference between labels
is timing noise, since the C inputs are identical.

| Unit | Baseline C compilation, three pairs | Cached-hash label, three pairs | Object SHA-256                                                     |
| ---- | ----------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| Code | 71,630.4 / 73,180.2 / 72,527.0      | 72,468.9 / 72,310.8 / 71,009.5 | `0e42039a5e499055663702c539ef7976f7f6302cb2cc830ea60941ce54c8dfc1` |
| Data | 219.2 / 220.2 / 220.7               | 218.9 / 221.7 / 221.8          | `b7e1fa883ced11b94ce889cd9a7c6821d97bd431a84e328cbac120fac3f8859c` |

The code-unit means were 72,445.9 and 71,929.7 ms; the data-unit means were
220.1 and 220.8 ms. Each unit's eight objects had the same SHA-256.
The hash cache changes the JS-to-C emitter, not this native C phase.

## Fair scheduling

`6c13cc34` makes caller round-robin discovery and candidate selection the
default while preserving priority within each caller, the existing global
limits, IR-size scaling, and local limits. `02d92ed6` retains a benchmark-only
`priority-scheduling` control that restores the previous global ordering from
the same source revision. The Node compilation pairs used `90084c3b`; the
native balanced benchmark and frozen compiler captures used `eaef598d`, which
only refreshes the unrelated primordial inventory. Source, evaluation policy,
and toolchain were held fixed within each comparison.

Fresh Node JS-to-C compilations used `bench/self-compile.mts` with the same
frozen stripped input (SHA-256
`fe18d5f487867499a846d9a4b815aabfaf8308f436d75851e7eba8e78d690ef4`)
in each pair, discarded each generated-C output after
checking its digest, and disabled optimizer instrumentation for timing. C
compilation and linking are excluded from these times.
Each fresh process ran `node bench/self-compile.mts INPUT OUTPUT`; the priority
process set `MAL_CORE_BENCHMARK_ABLATION=priority-scheduling`.

| Input            | Fair wall, three pairs         | Priority wall, three pairs     |   Mean fair saving |
| ---------------- | ------------------------------ | ------------------------------ | -----------------: |
| Full compiler    | 27,762.4 / 27,776.4 / 27,796.3 | 29,638.8 / 29,453.5 / 29,429.6 | 1,728.9 ms (5.86%) |
| Parser           | 1,727.4 / 1,691.9 / 1,706.1    | 1,766.7 / 1,710.5 / 1,706.7    |            19.5 ms |
| Shape provenance | 6,686.6 / 6,641.9 / 6,713.0    | 6,921.5 / 6,892.6 / 6,905.8    |           226.1 ms |

An untimed, fully instrumented compile of the same full input selected 1,009
cross-call transforms with fair scheduling versus 1,411 with priority
scheduling. Direct inlines were 33 versus 142, guarded inlines 954 versus
1,247, and array-predicate inlines 18 versus 22. The plan selected 3,107
versus 3,163 recipes. The fair ordering spends less optimizer work on
expensive inlining across the large compiler, rather than raising a budget.

The production closed-compiled balanced JavaScript benchmark ran three
same-source native pairs with per-phase checksum verification:

`npm run bench -- javascript --compare HEAD --ablate-core-family priority-scheduling --mode closed-compiled --runs 3 --max-pairs 3 --budget-seconds 3600`

| Pair | Fair native wall | Priority native wall |
| ---- | ---------------: | -------------------: |
| 1    |            970.5 |                981.8 |
| 2    |            979.5 |                978.0 |
| 3    |            977.5 |                977.9 |

These native wall times show no repeatable regression. The benchmark's
Maligator/Node ratio varied with its separate Node reference run; it is not a
clean measure of this compiler-policy change. The generated compiler quality
comparison below times binaries built from one frozen source while both
execute the same fixed fair evaluation policy.

The frozen compiler source capture used commit `eaef598d` with source digest
`248f22fa4300909c8051e84b35bf5c6745c7715ccc411cb8e1b29464c7831964`
and input manifest SHA-256
`168a81b95324bf8652093d094c10d11336c7bba56ea87a0eb6e4981faea26250`.
Both native captures used development O2 without LTO and toolchain fingerprint
`3eec146f97b85a6c4ae31f80e7128f5f9b96bebaeaf7f97035db65043f2cbd8b`.
The fair compiler binary was 57,618,096 bytes, SHA-256
`d917aea9bac9e47d5d6349c8941078515464f4aabeb3a2bc5807bcf008534a87`;
the priority binary was 57,595,440 bytes, SHA-256
`3fb22e7f296f954e9af895c418340647cc065e4ca273190824da8bf0145d49c4`.
The compiler builds emitted 96 and 97 C units respectively; these build times
are excluded from the native execution comparison.

The full fixed-policy comparison ran `npm run bench:self-compile-experiment -- compare FAIR_CAPTURE PRIORITY_CAPTURE --output OUTPUT --host native --workload full --pairs 3 --budget-seconds 3600`.
All eight native runs emitted 96 units, 95,371,820 code units, and exactly
matched the frozen Node oracle digest
`587e85cb7c7bed68bcbefb0ea1ab61c155e979ed3a012806528934be872de8aa`.

| Pair | Fair native compiler | Priority native compiler |
| ---- | -------------------: | -----------------------: |
| 1    |            170,665.9 |                170,348.5 |
| 2    |            170,100.8 |                170,133.8 |
| 3    |            170,729.1 |                169,440.3 |

Fair averaged 170,498.6 ms versus priority's 169,974.2 ms. The priority
reductions were +0.186%, −0.019%, and +0.755% (sample standard deviation
0.401 percentage points). The small total difference is not established as a
repeatable native regression. One phase, execution-to-image, was consistently
about 0.37 seconds slower in the fair compiler; that possible quality cost is
included in the decision rather than hidden in the total.

The same frozen captures compiled two smaller inputs with three native pairs
each, again against exact Node oracles:

| Input            | Fair native wall               | Priority native wall           | Output digest                                                      |
| ---------------- | ------------------------------ | ------------------------------ | ------------------------------------------------------------------ |
| Parser           | 5,998.2 / 5,987.6 / 6,025.9    | 6,017.8 / 6,072.6 / 6,100.0    | `2e09b66cc7bc3308cf05939cbabe8953ee84358d9332c4bb47509492fa8759d4` |
| Shape provenance | 33,563.6 / 33,835.1 / 33,593.6 | 33,771.5 / 33,980.3 / 33,938.8 | `a53c3823bfed0943dec3ed8895309d99eca1228fbba4712c5819a3b4aa535ec5` |

Fair averaged 1.0% faster on parser and 0.69% faster on shape provenance.
The full compiler's small priority-favored difference did not recur in these
native controls or the balanced JavaScript wall times. Retain fair scheduling
for its repeatable Node compilation saving and exact semantic parity; keep the
small full-compiler native quality cost visible for future comparisons.

## Guarded direct calls

`08b9b768` adds a benchmark-only ablation that suppresses emission of an
already-selected guarded direct-call recipe without reallocating its budget.
The full self-compile input under fair scheduling selected no guarded direct
calls; the two full native compiler binaries in that preliminary ablation had
the same SHA-256
(`91ad0209c9d1e0b8c756348fb0ec995bc81f6b59d128dd2ae89982dbcb3c3701`).
Its three apparent pair reductions (−0.85%, +0.61%, +6.55%) therefore measure
host spread rather than this transform.

A focused dynamic-call loop selected one guarded plan in both modes and
emitted two guarded calls normally versus one with the plan suppressed. Its
Node output oracle was `205000000000`. Ten fresh Node compilation pairs
averaged 269.0 ms normally versus 268.1 ms ablated, below the run-to-run
spread. The native effect and site counters are reported below.

| Pair | Normal JS-to-C | Ablated JS-to-C |
| ---- | -------------: | --------------: |
| 1    |          273.6 |           266.8 |
| 2    |          265.1 |           266.0 |
| 3    |          265.4 |           267.8 |
| 4    |          268.9 |           267.1 |
| 5    |          264.8 |           265.8 |
| 6    |          265.5 |           266.9 |
| 7    |          268.7 |           268.4 |
| 8    |          271.4 |           269.6 |
| 9    |          266.7 |           267.1 |
| 10   |          279.7 |           275.9 |

The deterministic test source defines `left(value) { return value + 1; }`
and `right(value) { return value + 2; }`, chooses
`Math.random() > 2 ? right : left`, then accumulates
`target(index & 1023)` for 400,000,000 iterations. Its source SHA-256 was
`58235e171d1553ada8d9c03f9c56a5c6ab11a28e9d36a81058c98d0da61251ff`.
Normal and ablated generated-C digests were
`f1bf54fea17fe9ab9ed75df8e6fca2748392176432c0af9ac67d59c77ed719b9`
and `8493e87be7cdb8bba2d116b96edf6a9208b8241c938e24501eb2393668b29aa9`.
The final binaries' SHA-256 values were
`99a0fff8023e6d13e39fa829e8ba2a313a14a1c28a6ab4990fe05bb23a69cef0`
and `0dee0b2454877502d23d394572fd64abff28df478cef734d794aa7c7203c7540`.
They exactly matched the binaries used for seven alternating, uninstrumented
native pairs. Every run printed `205000000000`:

| Pair | Guarded native wall | Ablated native wall |
| ---- | ------------------: | ------------------: |
| 1    |             3,709.4 |             4,147.1 |
| 2    |             3,743.0 |             4,140.2 |
| 3    |             3,711.2 |             4,148.8 |
| 4    |             3,710.2 |             4,135.8 |
| 5    |             3,707.9 |             4,145.0 |
| 6    |             3,709.5 |             4,137.1 |
| 7    |             3,711.2 |             4,247.8 |

The guarded version averaged 3,714.6 ms versus 4,157.4 ms ablated: a 10.64%
matched reduction (0.94 percentage-point sample standard deviation). A
separate temporary counter build of the same selected site recorded
400,000,000 executions, 400,000,000 successes for its first target, zero
second-target successes, and zero generic fallbacks. The count build was not
used for timings. Retain the current guarded-call eligibility; this loop shows
a concrete high-hit-rate benefit, while full self-compilation has no selected
guarded-call sites under the fair default. This evidence does not justify
expanding eligibility. The temporary counter source and binaries are disposable.

## PGO retirement and verification

`90084c3b` removes profile-guided admission, scheduling, hot budgets, training,
merge, CLI, wire, and runtime paths, while preserving diagnostic `--profile`
and ordinary optimizations. [D083](08-profile-guided-and-incremental-optimization.md#d083--2026-09-24--retire-profile-guided-optimization)
records the design decision. Wire version 61, compiler artifact version 85,
frontend schema/pipeline 4, and profile sidecar schema 8 invalidate affected
pre-1.0 artifacts. The audited primordial inventory was refreshed in
`eaef598d` after the first normal gate exposed four expected native-source
hash changes.

Local focused verification passed: 230 Core unit cases, 150 program-image
emission cases, 31 native wire-loader cases, nine native profiling cases, and
22 primordial-catalog cases. `npm run type-check`, `npm run lint:ci`, and the
source-tree-matched `mjq quality` check passed at `eaef598d`.

The first `mjq verify.check` run (`job-20260924T200513-a7b2192c33947384`)
failed on four stale primordial inventory hashes; `eaef598d` refreshed those
audited fixture hashes. The second run
(`job-20260924T201803-46a4715df96f19ff`, four workers) reached the public
API TypeScript consumer test but that subprocess took 5,187 ms against its
5,000 ms timeout under contention; it reported no product assertion failure.
The final run used two workers and the same `eaef598d` source tree, via
`mjq verify.check` job `job-20260924T202325-11a54f55be93ce2e`. It passed
all nine smoke/check stages in 60m 57s; the structured result reports
`combined_gate_passed: true` with matching local type-check and lint evidence
for source tree `73217fcbcf223b55ae3923c1ab92194a181aa4bc`. The fetched
report archive matched SHA-256
`d4862baacea139311503a44e31731eb5ae3df7613969ef4ceb6bab2a61b0d9d2`.
Selected Test262 reports were complete: 7 smoke and 265 check cases passed,
with zero `PASSED -> FAILED` transitions. The WPT complement completed 106
files and 1,541 subtests with zero unexpected results or harness errors.
The normal gate does not cover full Test262 or the entire native fixture set.

## Cache cleanup

Before pruning, `node ./src/index.ts cache status` reported 19.22 GiB total,
16.59 GiB managed, and zero active commands. The supported
`node ./src/index.ts cache prune --dry-run` preview selected 29,245 stale
rebuildable entries totaling 4.22 GiB, with the default one-day minimum age
and 15 GiB target. `node ./src/index.ts cache prune` removed that same set;
the subsequent status reported 15.00 GiB total, 12.38 GiB managed, and zero
active commands. Repository-local task scratch was kept until the final gate
report and raw performance numbers were recorded here, then removed together
with this task's balanced-JavaScript comparison output.
