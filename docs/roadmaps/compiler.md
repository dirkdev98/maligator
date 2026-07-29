# Compiler optimization and analysis roadmap

Maligator AOT-compiles optimized IR through generated C. Static call inlining,
scalar replacement, native numeric fusion, guarded property regions, call and
property caches, and a narrow stack-object path are implemented. This roadmap owns
unfinished compiler/runtime optimization work; Test262 corpus build throughput and
artifact size remain in the [Test262 performance roadmap](../../test262-perf-todo.md).

`bench/baseline.json` is the sole committed source for performance history. Keep
changing measurements out of this document. The initial queue below comes from a
focused compiled benchmark investigation at `c03a40f`: module-local const helpers
reached zero collections, while residual object allocation and fast-path overhead
remained material in the stack-object and language lanes.

## Active measurement foundation

- [ ] Split the language lane into loops, objects, arrays, allocation, intrinsics,
      control flow, and application phase metrics while retaining its aggregate
      checksum and wall-time regression signal.
- [ ] Emit structured optimization remarks for allocation, call, property, and
      boxing sites. Give each site a stable source location and identity through
      inlining, and record the applied transform or precise rejection reason.
- [ ] Attribute heap allocations, materializations, calls, property-cache paths,
      boxing fallbacks, and safepoints to those site identities. Reset counters after
      runtime initialization and collect them in separately instrumented binaries.
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

- [ ] Make inlining preserve or improve escape decisions. In particular, do not turn
      `bench/stack-object.js`'s rare partial return into a heap allocation on every
      loop iteration when the standalone callee can use stack state and materialize
      only the escaping result.
- [ ] Replace function-wide cycle rejection for partial escape with site-local
      lifetime and control-flow proof. Prefer path-sensitive scalar replacement and
      allocation sinking on rare escape edges over constructing a stack object when
      identity is otherwise unobserved.
- [ ] Re-run escape and scalar analyses after inlining, or preserve equivalent facts
      on cloned IR, and include transformed clones rather than retained unused
      helper bodies in optimization diagnostics.
- [ ] Extend native closed fixed-shape stack objects to further proven local classes.
      Calls, stores, captures, suspension, and dynamic-shape operations remain heap
      escapes until a narrower proof handles them soundly.

## Queued shape and value analysis

- [ ] Propagate literal and constructor shape provenance through local arrays, phi
      joins, and bounded call results. Use it to version hot loops once and replace
      repeated region guards, static-key comparisons, and cache probes with direct
      known-slot access.
- [ ] Propagate stable field value classes through proven shapes and stores. Keep
      numeric values unboxed across property arithmetic only behind a sound guard and
      fallback/deoptimization contract.
- [ ] Generalize property-key interning beyond the intrinsic atom table. Define
      lifetime and GC policy before relying on pointer identity in shapes,
      dictionaries, Maps, or inline caches.
- [ ] Add validity/version cells for user-defined prototype chains, then extend
      inherited-value caching beyond watched built-in chains and measure realistic
      method-call improvement.

## Queued call and control-flow analysis

- [ ] Implement bounded polymorphic method inlining. Compile a guarded CFG for a
      small constructor/shape-derived target set, such as the three `quote` methods
      in the language benchmark, while preserving a generic fallback.
- [ ] Generalize the module benchmark's TDZ-aware single-assignment callee resolution
      to proven immutable imports, single-assignment `let` bindings, stable closure
      fields, and constructor-derived methods.
- [ ] Specialize higher-order intrinsics when callback identity and iteration
      semantics are stable, prioritizing measured `reduce`, `forEach`, `map`, and
      `sort` call boundaries.
- [ ] Lower local throw/catch regions to ordinary control flow only when effect and
      exception analysis proves the value, handler, and completion ordering cannot
      be observed outside the region.

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
  allocation lands; add neither without an attributed allocation-rate or wall-time
  win.
- Revisit loaded-field numeric layout changes after shared fallback/deoptimization
  machinery exists and direct-slot specialization establishes the remaining cost.
- Revisit array-literal scalar replacement and full no-iterator `for-of` only with a
  benchmark not covered by existing iterator-protocol optimizations.
