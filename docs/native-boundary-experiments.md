# Native entry budget and Number boxing experiments

Both experiments were rejected and reverted. The compiler remains at `16e8409d`;
this report retains the findings without raising budgets or changing baselines.
The investigated checkpoint includes the earlier numeric specialization fixes.

## Budget allocation

The current compiler workload has 4,004 functions and discovers 443 eligible native
entries, but admits none. This is budget starvation, not an absence of signatures.
Early transforms consume 1,024 generated-code units. Earlier priority classes in
final specialization consume the remaining 3,072 before native entries compete.
The generated-code cap is binding; estimated compiler work totals 12,503 against
its 32,768-unit cap.

The experiment reserved at most 128 code units and 512 work units for ranked native
entries, retaining all existing aggregate, caller, site, and expansion limits.
It also skipped variant construction when existing consumption already made the
candidate unaffordable, with an explicit diagnostic option to retain discovery.
Neither change is retained independently: their combined result failed acceptance.

The diagnostic pilot admitted seven entries using 121 code units and 226 work
units. It displaced one iterator-result specialization; the remaining space
admitted a different combination of cursor and collection specializations.
The seven entries were `instructionOperand`, `instructionResult`, `consumeOpt`,
`consume`, `fail`, `add`, and `profileCall`.

The emitted compiler contained 447 direct-entry call sites: 80, 36, 43, 77, 59,
44, and 108 respectively. `instructionOperand` kept its offset in a `double`,
removed the negative-offset operand-kind guard, and reused the native offset in
subsequent comparisons. Dynamic per-target invocation counts were not collected.

### Matched compiler execution

Both compiler hosts processed the same frozen, stripped source tree from
`16e8409d`. Each candidate's Node and native outputs matched byte-for-byte in every
sample. Outputs intentionally differ between candidates because their selected
specializations differ. The three full-input pairs ran in alternating candidate
order; each sample used a fresh process. Positive changes mean slower.

| Pair | Node base / candidate | Node change | Native base / candidate | Native change |
| ---- | --------------------- | ----------- | ----------------------- | ------------- |
| 1    | 19.135 / 19.517 s     | +1.99%      | 139.249 / 129.987 s     | -6.65%        |
| 2    | 19.137 / 19.544 s     | +2.13%      | 127.518 / 130.937 s     | +2.68%        |
| 3    | 19.064 / 20.088 s     | +5.37%      | 130.825 / 132.669 s     | +1.41%        |

The median **paired** change was +2.13% on Node and +1.41% natively. The initial
native improvement did not repeat. No stable native speedup is established.

Median phase times further distinguish useful execution from additional work:

| Phase              | Node base / candidate | Native base / candidate |
| ------------------ | --------------------- | ----------------------- |
| Core construction  | 2.072 / 2.056 s       | 14.799 / 14.992 s       |
| Core optimization  | 11.907 / 12.117 s     | 91.935 / 91.234 s       |
| Core to execution  | 1.909 / 2.045 s       | 10.429 / 10.554 s       |
| Execution to image | 1.537 / 1.658 s       | 5.446 / 5.500 s         |
| C emission         | 0.903 / 1.060 s       | 5.819 / 6.272 s         |

Peak RSS varied substantially: Node ranges were 2.209–2.501 GB for the base and
2.104–2.579 GB for the candidate; native ranges were 2.155–2.251 GB and
2.097–2.143 GB. These samples do not establish a repeatable memory improvement.
The initial native pair allocated 61.177 / 61.500 GB cumulatively and performed
370 / 373 collections; allocation is distinct from peak live memory.

### Build and control costs

One production build per candidate used an initially empty native artifact cache,
including actual compilation of all generated C objects and a real link. Cargo
and operating-system caches were otherwise warm. These are single cold-build
observations, not repeated build-speed conclusions.

| Cost                                    | Base                  | Reservation candidate |
| --------------------------------------- | --------------------- | --------------------- |
| Generated C object compilation          | 29.766 s              | 33.912 s              |
| Link                                    | 124.577 s             | 127.257 s             |
| Compilation plus link                   | 154.343 s             | 161.169 s             |
| Complete build                          | 204.586 s             | 211.472 s             |
| Compiler binary size                    | 38,364,512 bytes      | 38,463,920 bytes      |
| C emitted for the frozen compiler input | 63,157,037 characters | 63,542,685 characters |

Five additional interleaved pairs compiled the unmodified `bench/javascript.mjs`.
Node and native compiler execution were neutral: median paired changes +0.02%
and -0.08%. All outputs, including across candidates, had the same SHA-256 digest:
`e50ea522e9cd6f478d93718f3620ecce170e4c64621a6fa172551e8b54d3ed3d`.
This is a compiler control, not an application runtime benchmark. Interpreted
runtime, async, text, and allocation workloads were not separately timed after
the reservation failed the compiler comparison.

## Explicit Number boxing boundaries

The second experiment retained proven Number results in native registers and
inserted ordinary boxed `move` results at supported call/property/global/captured
store boundaries. It required a proven arithmetic consumer, bounded each def-use
walk, and limited surviving Number bridges to eight per function across repeated
proof passes. Unknown kinds, cross-block uses, exceptional block entries, async
functions, and generators were declined. It used existing representations and
move lowering; it added no opcode or ABI.

Three original qualifying sites were traced in the frozen compiler: one in
`#resolveVirtualPhis` and two in `dominatorPredicate`. They are post-increment
traversal counters. The implementation also admitted qualifying data-property
writes. The counter C changed from an encoded intermediate decoded again for the
increment to one native value encoded separately at the store. Register moves
and some edge blocks disappeared, while generic store checks remained.

An isolated workload copied the actual `dominatorPredicate` implementation,
constructed a 2,048-node tree 128 times, and checked the resulting predicates.
Its entry came from a command-line argument. The dominator function used its
canonical entry in both builds; the returned predicate had the same native entry
in both. No inlining or specialization was disabled to manufacture the comparison.
Every run returned checksum `30848`.

After warmup, seven alternating pairs measured 114.295 / 119.494 ms median elapsed
time, with a **+4.71% median paired slowdown**. Every pair was slower, ranging
from +1.84% to +7.82%. Generated C shrank from 75,398 to 75,231 bytes; both binaries
were 2,456,528 bytes. The dominator symbol's code span shrank by 108 bytes. Smaller
C and fewer representation conversions did not produce a useful runtime result.

The experiment stopped at this isolated pilot. A full compiler build/comparison
and additional interpreted, async, text, or allocation timing controls were not
run for this rejected candidate. No compiler throughput improvement is claimed.

## Verification and retained evidence

The reservation passed 48 focused unit tests and the existing two direct-entry
ABI tests, including compiled/interpreted execution, GC stress, and observed
native-entry hits in that fixture. The boxing experiment passed 55 focused unit
tests and type checking. Its native fixture passed on both backends with GC
stress, covering signed zero, NaN, retained objects, throwing calls and setters,
and Number contextual entries alongside canonical string/object calls. Tests
also checked conservative admission and the persistent bridge limit.

Neither candidate received a full normal gate, sanitizer run, or Wasm/explorer
validation before rejection. Those remain required before reusing either patch.
The final `npm run test:check` passed all 11 stages on the restored compiler in
2 minutes 18 seconds: 1,508 unit tests, 44 native tests, 60 sanitizer tests, and
the selected Test262 and WPT lanes. One existing native test was skipped.
The complete gate report and log are retained as `final-gate.json` and
`final-gate.log` in the evidence directory below.

Raw evidence and reproducer sources remain in `.cache/native-boundary/`:

- `reservation-full.patch`, `boxing.patch`, and `boxing-reproducer/` preserve the
  exact attempted changes and the additional semantic fixture.
- `baseline-discovery.json`, `reserve128-discovery.json`, `emitted-calls.json`,
  `bridge-compiler-audit.json`, and `bridge-compiler-after.json` retain discovery.
- `source/` and `source-manifest.json` preserve the common compiler input.
- `build.mjs`, `run-compiler.mjs`, and `measure-compiler.mjs` reproduce the builds
  and measurements; `{base,head}-pilot/build.json` record invocations, cache events,
  native commands, resource measurements, and phase costs.
- `reservation-summary.json`, `compiler-measurements.json`, and
  `application-measurements.json` retain summaries and raw samples. The initial
  pair is in the individual `*-compiler-pilot.json` files. Corresponding stdout,
  stderr, resource records, and emitted C are retained beside them.
- `prepare-dominator.mjs`, `dominator-pilot.mjs`, `measure-dominator.mjs`, and
  `dominator-measurements.json` reproduce the isolated pilot. `bridge-1009.diff`,
  `bridge-1051.diff`, and `dominator-{base,head}.asm` retain C and machine-code evidence.

The runs used Node 26.7.0 on the Apple-arm64 host, AC power, and production native
build settings with ThinLTO. Environment probes and cache checks found no competing
Maligator commands. Ordinary desktop background activity remained present.
No benchmark or Test262 baseline was rewritten, and nothing was pushed.

## Calibration implication

Recalibrate cost accounting and selection value before increasing the caps.
`directEntryCandidates` currently charges `max(8, callee instruction count)` and
that cost plus the callee's value capacity. Its benefit estimate scales with
weighted call sites, but its code/work costs do not scale with rewritten callers.
The 121-unit reservation produced seven entries and 447 rewritten sites, with a
net increase of 385,648 C characters including displaced work. This is a concrete
reason to measure caller expansion and lowering costs rather than interpreting
budget units as physical code size or elapsed work.

A subsequent calibration should first account for those costs and verify dynamic
entry usage, then compare a small set of budget allocations/caps using matched
Node/native compiler execution, real cold compile/link cost, and runtime controls.
The current evidence does not justify raising either cap or retaining either
optimization attempted here. Candidates 3–6 were not implemented.
