# Maligator TODO

Top-level roadmap. The working docs are the source of truth for detail:
`gc_todo.md` (GC + compiled throughput), `isolate_todo.md` (isolate / reactor /
actors / SMP / GUI / bare-metal), `eval_todo.md` (eval / Function / realms),
`test262-todo.md` (conformance), `test262-perf-todo.md` (ranked suite/compiler
performance work).

## Goal

A lean AOT-compiled JS engine. Priorities, in order:

1. **Performance** — never a JIT, but AOT-fast: whole-program inlining, escape
   analysis, inline caches, precise non-moving generational GC (opt-in concurrent).
2. **Small binary size** — every non-core feature is opt-in; a binary's size is
   proportional to what the program actually uses.
3. **General-purpose usability** — WinterTC (opt-in) + a small curated Node-compat
   subset. Never the full Node/npm suite; binary impact stays proportional.
4. **Explore what's fun** — after more GC / perf / multiprocessing, lean toward
   GUI-embedding and/or bare-metal (not web-stack work).

## Opt-in features (pay for what you use)

Whole-program DCE means a program that never references a feature must not link it
in. `OFF buys` = what dropping the feature gets you.

| Feature            | Mechanism                                     | OFF buys                                                                                |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| eval / Function    | baked self-hosted compiler (`eval_todo.md`)   | drops the baked compiler **and re-enables whole-program DCE** (eval forces retain-all)  |
| Intl               | ICU4X data via Rust                           | biggest single size win — today ~11 MB binaries; also locale-splitting                  |
| RegExp             | regress (Rust staticlib, `-lc++`)             | drops the Rust regex engine                                                             |
| Date / Temporal    | temporal_rs / jiff (Rust)                     | drops tz + calendar data                                                                |
| WinterTC runtime   | fetch/Response/Headers/URL/web globals/timers | drops the web personality (already host-entry-install gated)                            |
| Reactor / host I/O | sockets / timers / TLS / DNS                  | pure-compute programs link no reactor                                                   |
| Actors / SMP       | fibers + schedulers                           | single-context programs skip it                                                         |
| GC generational    | default ON; `MAL_GC_GENERATIONAL=0` opts out  | opt-out drops the card barrier (~1.3% median store tax) for minimal/bare-metal profiles |
| GC concurrent      | `MAL_GC_CONCURRENT`                           | STW-only collector — drops the SATB barrier + incremental-cycle machinery               |
| bytecode overlay   | fallback `MalInstruction` table               | drop for always-compiled/no-bail fns → smaller image                                    |
| debug symbols      | position tables + stack traces                | strip mode = zero overhead                                                              |

- [ ] **Design the feature-configuration DX.** How a user selects the above —
      build profiles / target presets (`--profile bare-metal`) vs. auto-detect from the
      program (a pure-compute CLI needs no reactor/WinterTC) vs. explicit flags. One
      coherent knob surface + docs. Decide the interaction between manual flags and
      automatic reachability (eval-off is the case where they compound). This is also
      where the "is WinterTC excluded from the default binary?" call gets made.
- [ ] **Binary-size gate.** Track `hello-world` + `kitchen-sink` binary bytes per
      commit, the way the test262 gate tracks conformance, so size regressions are
      visible. Prerequisite for the size pass.

## Priority 1 — Performance

- [ ] **Object & array access fast paths — residual.** Guarded regions have landed for
      arrays (dense element) and objects (`p.k`): per-access, plus a consolidated object
      region (one guard per straight-line run + a per-variant `{shape,key,slot}` cache, up to
      N shapes / polymorphic), direct data-slot access with the `completion.kind` throwCheck
      elided. The remaining object residual is the arithmetic ON loaded fields, not the access
      — see numeric unboxing below. (Inline object slots — folding `slots` into MalObject — is
      blocked: MalObject is embedded as the first member of ~20 exotic subtypes, so it can't
      end in a flexible array; see shape.h.)
- [ ] **Chained numeric unboxing / value type-feedback on loads** — the `objects()` /
      chain-heavy residual is the per-op is_number + int32-canonicalizing box on loaded
      (boxed-rep) fields. Two options, both measured LOW-ROI so far and deferred: (a) fuse a
      number-producing arithmetic sub-tree under one leaf-guard into native math + one box —
      but chain code is already ~1.95× vs V8, sound fusion needs def-use over post-regalloc
      register reuse + slow-path duplication, and −0/NaN differential testing; (b) speculate a
      loaded field is a number (type-feedback) and carry it unboxed with a deopt. Revisit only
      with a clearer win or once (b)'s deopt machinery exists for another reason.
- [ ] **String optimizations** — ropes/cons-strings + dependent (slice) strings so
      `+` is O(1)-amortized and substring is zero-copy (GC trace-edge to parent).
      Cons strings and traced dependent storage are implemented; public substring
      producers still need conversion from copying to dependent slices.
- [ ] **String/key interning (atom table)** — pointer-identity key compares, wider
      IC coverage, substrate for faster dict/Map lookup + symbol fast path.
- [ ] **Call-site inlining — residual.** Landed: a polymorphic call-target cache (identity +
      heap-epoch guarded, N ways); guarded inlining of reassignable script-global direct calls
      (`guardFunctionIndex` op + the splice/deopt machinery); and guarded method inlining
      (`obj.m()` inlined behind the same index guard on the proto-resolved callee, `this` =
      receiver). Residual: method inlining's win is bounded by the per-call `loadProperty(recv,
"m")` **proto-chain walk** — proto-method loads aren't IC-cached, and the guard still
      needs the loaded callee. The bigger method win needs a **cached proto-method load** (a
      shape→method IC, which needs prototype-validity cells — none exist yet) so the resolution
      itself is skipped. `enter_compiled` micro-opts (skip the native-frame push when a trace
      can't be observed) are a minor separate lever.
- [ ] **Allocation is the next bottleneck** (~15× vs Node on alloc bench):
  - [ ] Escape analysis → scalar replacement / stack alloc within the root frame
        (extends the built scalar-replacement past the module-inlining baseline).
  - [ ] Region/arena allocation (N.11) + drop-insertion free-lists (N.12).
- [ ] Promise/microtask + suspendable-frame mallocs → pooled (pure alloc-rate win;
      2026-07-10 audit: tiny + deterministically freed, no trigger/footprint concern).
- [ ] **Struct-layout follow-ons** (the memory-density pass otherwise landed):
  - [ ] **`MalInstruction` union pack (24 from 40)** — deferred with the bytecode-overlay
        redesign (see Priority 2): needs the pointer-carrying opcode arms relocated behind
        side-table indices (a wire-format change across emit-c / serialize-vm / vm_load).
  - [ ] **`MalVm` (2888, singleton) / host structs (`MalHttpRequest` 2112)** — scan
        only once the isolate work multiplies `MalVm` instances (one per scheduler thread).
- [ ] Generate ops from a single op-descriptor list (kills the ~6-file opcode path).
- [ ] Effect-summary table for builtins (T7.3) — unlocks functional-style inlining.
- [ ] **Test262/compiler throughput queue** — address the ranked safety,
      algorithmic-compile, generated-code, and measurement tasks in
      `test262-perf-todo.md`.

## Priority 2 — Binary size

- [ ] **Production build mode** — keeps `-O2` (do NOT trade perf for size in prod) but
      strips the symbol table (post-link `strip`, or `-Wl,-x`) off by default only in
      this mode. Measured ~11% (~210 KB) off `minimal`; it drops native symbolication
      (`nm`/`atos`/crash backtraces) but NOT the engine's own JS stack traces (separate
      position tables). Distinct from the size-focused profile below (which trades perf).
      Dev/default builds stay unstripped. `-dead_strip` measured ~1% here (eager
      intrinsic install roots almost everything + Rust is already LTO'd), so it's not
      the lever — compile-time feature gates are.
- [ ] **Enable LTO (`MAL_LTO`) in the production mode** — whole-program inline of the
      emitted TU's calls into the runtime archives; the single biggest speed lever
      measured (language ratio 2.05× → 1.77×). Cost is link time, so it stays
      opt-in / prod-only, not on dev builds.

## Substrate roadmap

### GC (`gc_todo.md`)

- [ ] C2 marker thread + C3 parallel mark workers — deferred until a big-heap
      workload demands them (the C1 incremental collector shipped 2026-07-10 and
      its design accounts for both).
- [ ] Deterministic FFI free at scope end (T4.4, gated behind the escape work).

### Isolate / reactor / actors (`isolate_todo.md`)

- [ ] Phase 2 — Outbound I/O + client `fetch` (WinterTC, opt-in): TCP client sockets,
      DNS via thread-pool, TLS above sockets (rustls/BearSSL, DCE-droppable), client
      `fetch`/`Request`/`Response`. Small single-binary profile + size numbers.
- [ ] Phase 3 — Actors: fiber + mailbox, spawn/send/receive, reduction-budget
      fairness, copy-message + transferables, mailbox rooting, supervision (link/monitor/kill).
- [ ] Phase 4 — SMP: thread-local GC globals (`TODO(SMP)`), one isolate per scheduler
      thread, cross-isolate send (copy + MPSC + wake), work-stealing, per-isolate GC.
- [ ] Phase 5 — GUI embedding: pumped reactor inside a foreign main loop; spike a
      Rust GUI crate (winit/wgpu) via FFI.
- [ ] Phase 6 — Bare-metal / freestanding: no-libc core, poll/ISR backend, fixed-size
      fiber stacks, minimal-core build profile (ties to the opt-in catalog).
- [ ] Validate the x86_64 fiber switch on Linux.
- [ ] Fiber frames after an eval definition-splice: `mal_gc_scan_fiber_exec` traces
      stale cached `function` pointers (see `gc_todo.md` §4) — fix before Phase 3 actors.

### eval / Function (`eval_todo.md`)

- [ ] Runtime native TS stripper (swc StripOnly once serde/icu4x clears) so eval-of-TS
      needs no Node in the deployed binary.
- [ ] Direct-eval Slice 3: enclosing-function locals, caller `this`/`new.target`/
      `arguments`, async-eval-in-default-param cluster.
- [x] Realms: `$262.createRealm` with fresh globals/intrinsics on a shared heap.
- [x] `ShadowRealm` constructor, `evaluate`, and callable boundary wrappers.
- [ ] `ShadowRealm.prototype.importValue` runtime module loading and residual
      cross-realm correctness clusters.

## Priority 3 — General-purpose usability

- [ ] WinterTC surface (opt-in): remaining fetch/Headers bits (`AbortSignal.any`,
      DOMException, `Set-Cookie`, live `url.searchParams`, `request.json()` parse-error);
      WPT harness.

## Conformance (`test262-todo.md`)

- [ ] Cross-cutting feature builds: dynamic `import()` (502), Atomics agents /
      `$262.agent`, and `ShadowRealm.prototype.importValue` module loading.
- [ ] RegExp `@@split`/`@@match`/`@@replace`/`@@search` (unblocks much of String).
- [ ] Class clusters, compound-assignment, for-of, arguments-object, super.
- [ ] Long tail per-area filters — see the doc's ranked list.

## Testing / tooling

- [ ] **Clean up the test suite:** unit/native/lint lanes are green; prune the
      `tests/local/*.js` grab-bag.
- [x] **Quick regression test262 selection** — a small curated subset (a few
      hundred tests across areas) that runs in seconds for a fast pre-commit signal,
      complementing the full gate (~48 min on compiler changes). Keep it in sync with
      the gate's committed verdicts.

## Experiments / someday

- Erlang/OTP-style message passing + cooperative scheduler (converging with Phase 3).
- GUI work (Phase 5).
- Bare-metal (Phase 6).

## Resources / reading

- https://zef-lang.dev/implementation
- https://wren.io/performance.html
- https://benhoyt.com/writings/hash-table-in-c/
- https://github.com/tidwall/hashmap.c
