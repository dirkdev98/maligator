# Compiler optimization and analysis roadmap

Maligator AOT-compiles optimized IR through generated C. Static call inlining,
scalar replacement, native numeric fusion, guarded property regions, call and
property caches, and a narrow stack-object path are implemented. This roadmap owns
unfinished compiler/runtime optimization work; Test262 corpus build throughput and
artifact size remain in the [Test262 performance roadmap](../../test262-perf-todo.md).

`bench/baseline.json` is the current committed performance snapshot; Git retains its
history. Keep changing measurements out of this document. The current queue reflects compiled
investigations through `e02d78d`. Module-local const helpers eliminate their hot
allocations; partial-return helpers now retain stack materialization when called in a
loop; and opt-in workload counters are compiled out unless `MAL_PERF_STATS=1` was set
at build time.

The latest attribution changes the order of work. Removing a large fraction of
managed allocation from the stack-object lane produced a smaller wall-time gain, so
allocation is not its only limiter. The language lane overwhelmingly takes existing
property-cache hit paths, creates its dynamic normalized records as empty objects,
and retains bounded polymorphic method and exception-heavy call boundaries. Prioritize
hit-path specialization and call/control-flow analysis before new allocation regions.

## Active measurement foundation

- [ ] Split the language lane into loops, objects, arrays, allocation, intrinsics,
      control flow, and application phase metrics while retaining its aggregate
      checksum and wall-time regression signal.
- [ ] Extend the source-aware residual object and partial-escape inline reports into
      structured optimization remarks for every allocation, call, property, and
      boxing site. Preserve a stable identity through inlining and record each
      applied transform or precise rejection reason.
- [ ] Extend the workload-only aggregate allocation, call-cache, and property-cache
      counters to stable source sites, boxing fallbacks, and safepoints. Keep all
      runtime storage and increments behind the build-time `MAL_PERF_STATS` gate and
      collect them only in separately instrumented binaries.
- [ ] Report substitution-stage reasons for calls that eligibility analysis still
      labels inlinable, including inner closures, exception regions, relocation,
      expansion limits, and escape-cost barriers.
- [ ] Record pass-by-pass IR deltas for allocation sites, dynamic calls, boxed
      operations, property helpers, and safepoints. Add bounded optimization
      ablations so benchmark deltas can be assigned to individual transforms.
- [ ] Report cold process time separately from steady-state kernel time. Interleave
      paired Maligator and Node runs, retain sample dispersion, and record the host,
      toolchain, build flags, and runtime configuration used by each baseline.
- [ ] Emit source-derived C symbols and `#line` mappings, with an optional annotated
      disassembly report that relates source, optimized IR, generated C, and machine
      code.

## Active allocation elimination

- [ ] Generalize the implemented hot-loop partial-return inline barrier into an
      allocation-aware inlining cost model that compares the caller clone with the
      standalone callee rather than relying on one partial-escape pattern.
- [ ] Replace function-wide cycle rejection for partial escape with site-local
      lifetime and control-flow proof. Prefer path-sensitive scalar replacement and
      allocation sinking on rare escape edges over constructing a stack object when
      identity is otherwise unobserved.
- [ ] Preserve escape and scalar facts through every cloned IR path or re-run the
      analyses after inlining. Extend the source-aware residual report beyond object
      sites so retained unused helper bodies cannot obscure transformed hot clones.
- [ ] Extend native closed fixed-shape stack objects to further proven local classes.
      Calls, stores, captures, suspension, and dynamic-shape operations remain heap
      escapes until a narrower proof handles them soundly.
- [ ] Materialize only on a guarded fallback for local fixed-shape objects whose sole
      blocker is an inherited watched data-property read. Measure the repeated
      `toString` observations in the stack-object lane before accepting the added
      guard and fallback.

## Queued shape and value analysis

- [ ] Propagate literal and constructor shape provenance through local arrays, phi
      joins, and bounded call results. Use it to version hot loops once and replace
      repeated region guards, static-key comparisons, and cache probes with direct
      known-slot access.
- [ ] Infer and bulk-construct the result shape of object rest/spread normalization
      when source shapes and excluded keys are bounded. Avoid building every
      normalized application record through the empty-object path while retaining a
      generic fallback for dynamic sources.
- [ ] Propagate stable field value classes through proven shapes and stores. Keep
      numeric values unboxed across property arithmetic only behind a sound guard and
      fallback/deoptimization contract.
- [x] Generalize property-key interning beyond the intrinsic atom table. Property
      names now converge on strongly rooted VM-lifetime atoms; heap-owned shapes,
      dictionaries, static constants, and VM-owned inline caches can therefore use
      stable pointer identity without crossing isolate lifetimes. Map/Set keys remain
      in their separate ECMAScript value-key domain.
- [x] Add chain-local validity dependencies for user-defined prototype chains.
      Stable VM-owned IC rows register against the exact prototype objects they
      depend on; rare structural mutations eagerly clear only those rows, while
      inherited slot/table hits retain O(1) guards and unrelated chains stay warm.
- [x] Cache ordinary fresh-property shape transitions. Repeated constructor-style
      stores now apply the immutable old-shape-to-child-shape transition directly;
      exact first-prototype guards plus chain-local eager invalidation preserve
      accessors, read-only inherited data, exotic dispatch, and reparenting semantics.
- [x] Share the VM-scoped megamorphic shaped-property stub between loads and
      existing-slot stores. Cached descriptor attributes prevent read-only load
      entries from becoming store hits, and full-bit hash mixing avoids heap
      size-class address clustering in the direct-mapped table.

## Queued call and control-flow analysis

- [x] Implement bounded polymorphic method inlining. Calls with up to three
      same-name program method bodies retain the observable property load, then use
      exact loaded-callee guards to select an inlined body with the original receiver
      as `this`; unmatched, replaced, accessor-provided, and proxy-provided callees
      retain the generic call fallback.
- [ ] Generalize the module benchmark's TDZ-aware single-assignment callee resolution
      to proven immutable imports, single-assignment `let` bindings, stable closure
      fields, and constructor-derived methods.
- [ ] Specialize higher-order intrinsics when callback identity and iteration
      semantics are stable, prioritizing measured `reduce`, `forEach`, `map`, and
      `sort` call boundaries.
- [ ] Lower local throw/catch regions to ordinary control flow only when effect and
      exception analysis proves the value, handler, and completion ordering cannot
      be observed outside the region. Use the split control-flow phase to establish
      whether this is preferable to extending exception-aware inlining first.

## Queued generated-output work

- [ ] Add a generated-code cost model that weights helper calls, guards, boxing,
      root slots, and safepoints by profile counts or proven loop frequency. Use it
      for inlining, region formation, and specialization decisions.
- [ ] Remove retained helper bodies and function objects only when eval, identity,
      reflection, and reachability analysis prove their absence is unobservable.
- [ ] Generate compiler/runtime opcode plumbing from one descriptor list.

## Acceptance policy

Each optimization needs a focused semantic regression, the relevant benchmark
allocation or dispatch signal, and a wall-time comparison. Keep the curated Test262
regressions and `npm run test:check` green. Prefer root-cause transforms over
fixture-specific patterns, and do not accept a faster median that materially worsens
allocation, tail latency, generated size, or correctness without recording the
tradeoff.

## Triggered work

- Measure region allocation and drop-insertion free lists only after broader stack
  allocation lands; the current allocation-to-wall-time result strengthens the
  requirement for an attributed wall-time win before adding either.
- Revisit loaded-field numeric layout changes after shared fallback/deoptimization
  machinery exists and direct-slot specialization establishes the remaining cost.
- Revisit array-literal scalar replacement and full no-iterator `for-of` only with a
  benchmark not covered by existing iterator-protocol optimizations.
