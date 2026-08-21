# Maligator roadmap

This is the sole project roadmap. It contains unfinished work only; completed work
belongs in commits, tests, generated reports, and benchmark baselines.

Each task has one owning section. Cross-cutting dependencies may be mentioned, but
the work itself is not duplicated.

## Current priorities

1. Validate the direct Core IR pipeline and its Core-to-target contracts.
2. Establish a strong common SSA optimization foundation and use it to recover
   performance.
3. Exploit Maligator's world knowledge, explicit effects, precise roots, shapes, and
   AOT source closure through generic analyses.
4. Stabilize alpha releases and recoverable resource handling.
5. Advance ECMAScript, WinterTC, Node, and ecosystem correctness.
6. Pursue actors, SMP, embedding, and freestanding targets after the active runtime
   foundations are ready.

## Development experience and stability

Cache failures are product or environment failures, not inconveniences to bypass.
Fix incorrect cache identity, invalidation, corruption, leasing, or recovery at the
owning layer; never hide them with unconditional cache clearing, retry loops, disabled
tests, or scenario-specific fallbacks.

Keep AGENTS.md and the environment probe synchronized with the capabilities normal
development actually needs: workspace and temporary writes, Maligator, npm, and Cargo
cache writes, loopback listen(0), CPU/activity inspection, and any newly introduced
resource. Treat EPERM and EACCES as sandbox failures when the probe confirms that
diagnosis, update the instructions or sandbox, and rerun the exact command instead of
changing Maligator behavior.

Tests should primarily exercise observable behavior and real cross-layer integration.
Use structural assertions only for an explicit compiler, verifier, wire-format, or ABI
contract; do not freeze instruction order, register numbers, private helper layout,
exact generated C text, or other replaceable implementation details.

Representative validation commands are:

    npm run env:check -- --json
    npm run test:smoke
    npm run test:check

Use focused tests while developing, the smoke tier as a quick repository-wide signal,
and test:check as the normal local gate. Full Test262, test:full, and test:full:report
remain approval-only.

# Compiler and Core IR

## Core IR contract

Core SSA is the only optimizing middle end for development, testing, interpreted
execution, native execution, and production builds. Internal formats use a hard
cut-over: schema changes invalidate cached artifacts rather than introducing adapters
or compatibility paths.

Core owns all multi-instruction optimization decisions and their proof obligations.
Target lowering may validate and consume Core decisions, while VM and C emission
perform only local lowering from explicit target metadata.

Performance recovery should come from standard SSA, dataflow, effect, representation,
and whole-program optimizations. Do not maintain a queue of retired optimizer patterns
to restore; generic passes may naturally rediscover their useful results.

## World-knowledge ladder

| Level             | Available knowledge                                                                   | Intended result                                                             |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Universal         | Ordinary open JavaScript semantics                                                    | Local SSA, escape, representation, shape, and effect optimization           |
| Epoch-guarded     | A recorded identity, shape, or semantic condition remains valid for an epoch          | One guard, unchecked operations, and an explicit generic twin               |
| Proof-specialized | Local identity, consumer, escape, effect, or representation facts narrow an operation | Direct lowering, scalar replacement, and bounded materialization            |
| Authority-closed  | Primordials and host authority are locked although runtime source may remain open     | Primordial identities become invariants and mutation fallbacks disappear    |
| Source-closed     | All source and externally callable entry points are known                             | Whole-program reachability, cross-call specialization, and output reduction |

These levels are cumulative facts consumed by one optimizer, not separate pipelines.
Runtime eval may remove source closure without invalidating authority closure.

## Fact-driven optimization

Prefer consuming facts already available in Core. Extend an analysis only together
with the optimization that consumes the additional precision. Keep mutable-world
performance neutral or better while specializing locked builds.

- [ ] Consume existing bounded callee sets and effect summaries for direct or guarded
      dispatch, guarded inlining, and motion across non-mutating calls.

- [ ] Consume existing return-representation and return-provenance summaries to
      propagate unboxed values, eliminate boxing and roots, and preserve returned
      allocation identity.

- [ ] Consume existing allocation-layout, own-cell, containment, and escape facts for
      property-load elimination, memory forwarding, dead-allocation elimination,
      allocation sinking, and initial scalar replacement.

- [ ] Consume existing guarded-region admission and authority-closure facts to admit
      eligible regions once and remove redundant guards, fallback paths, property
      loads, and helper calls.

- [ ] Consume existing source-closure, root-reason, and reachability facts to remove
      provably unreachable function bodies and function objects.

- [ ] Extend bounded callee discovery through remaining import, lexical,
      constructor-derived, stable-field, and call-result paths; immediately consume
      new finite target sets in dispatch, inlining, effect analysis, and reachability.

- [ ] Extend representation constraints through parameters, arguments, block
      arguments, clones, joins, and materialization; immediately consume them for
      unboxing, ABI specialization, box elimination, and reduced rooting.

- [ ] Collect shape and value-class provenance across allocations, block arguments,
      call results, and stores; immediately consume it for property specialization,
      redundant-check elimination, alias refinement, and memory optimization.

- [ ] Extend escape and containment facts across inlining, joins, exceptions, and
      suspension; immediately consume them for scalar replacement, stack allocation,
      allocation sinking, and dead-store elimination.

- [ ] Extend interprocedural summaries with identity, shape, value-class, allocation,
      throw, and suspension facts one dimension at a time; consume each addition in
      the call-site optimizations that motivated it.

- [ ] Collect local exception-flow facts for values, handlers, completion order, stack
      observation, and effects; consume them to lower equivalent local throw and catch
      regions to ordinary control flow.

- [ ] Complete module, export, publication, eval, reflection, Realm, host,
      retained-identity, and open-edge reachability modeling; immediately consume the
      closed graph to remove unreachable functions, helpers, metadata, and disabled
      feature support.

- [ ] Collect precise safepoint liveness and consume it to minimize root placement and
      shorten rooted lifetimes while remaining correct for hidden allocations,
      exceptional exits, and every GC mode.

- [ ] Collect generated-code cost facts for helper calls, guards, boxing, root slots,
      safepoints, duplication, loop frequency, downstream C compilation, and binary
      size; consume them to gate region versioning, guarded dispatch, inlining, PRE,
      specialization, and cloning.

## Compiler infrastructure

- [ ] Generate compiler, VM, runtime opcode, builtin, effect, and constraint plumbing
      from shared descriptor sources. Adding an operation must not leave lowering, GC,
      or runtime declarations inconsistent.

## Compiler measurement and diagnostics

- [ ] Split the language benchmark into loops, objects, arrays, allocation,
      intrinsics, control flow, and application phases while retaining its aggregate
      checksum. Use smaller lanes for attribution and the aggregate for regressions.

- [ ] Report cold process time separately from warmed kernel time and retain sample
      dispersion. Record host, toolchain, flags, world policy, eval policy, and runtime
      configuration with each baseline.

- [ ] Track frontend, analysis, optimization, register allocation, emission,
      downstream C compilation, linking, generated C size, binary size, and peak build
      memory. Runtime improvements must not make compilation impractical.

- [ ] Emit source-derived C symbols and line mappings with an optional report relating
      source, facts, optimized Core, target instructions, generated C, and disassembly.
      Compiler remarks must describe the final emitted path accurately.

## Compiler acceptance policy

Every optimization requires focused semantic coverage, optimized-Core validation, the
relevant allocation or dispatch signal, and repeated representative timings with
matching checksums. Keep control workloads neutral and record material size or
compilation tradeoffs.

World-sensitive work requires locked and mutable coverage, strict and sloppy mutation
behavior, eval and cross-Realm cases, safe invalidation, and evidence that
authority-closed guards and fallbacks were actually removed.

# Release and product readiness

## Cross-platform native binaries

- [ ] Validate and document minimum supported macOS and glibc-based Linux versions for
      arm64 and x64 artifacts. Windows remains deferred until deliberately selected.

- [ ] Build the product CLI natively for every supported target in CI. Keep
      target-specific runtime and archive inputs attributable in the artifact manifest.

- [ ] Run the release smoke test against every artifact, including a clean host with
      only documented toolchains. Exercise installation, diagnostics, project creation,
      production building, and execution outside the repository.

## Release operations

- [ ] Move publishing to a tag-driven GitHub workflow using npm trusted publishing.
      Keep prereleases on SemVer alpha versions and the npm alpha dist-tag.

- [ ] Run npm run test:full:report for release candidates and resolve or record every
      result. This gate and the full Test262 corpus remain approval-only.

- [ ] Define a failed-release procedure that stops the workflow, deprecates broken
      versions, fixes forward, and publishes a new alpha. Never reuse a published
      version.

# Runtime safety and allocation

- [ ] Complete recoverable allocation failure for CELL, RAW, LOS, GC-internal,
      runtime-helper, and direct-native allocations. OOM must remain catchable without
      corruption, lost roots, recursive failure, or partial observable objects.

- [ ] Deterministically release nonescaping RegExp and ICU handles at compiled scope
      end once ownership analysis proves their lifetime. Retain finalization for every
      uncertain path.

- [ ] Implement or explicitly reject host.scheduler: multiprocessing based on its
      relationship to isolates, actors, process lifetime, and resource limits. Do not
      leave a selectable configuration with undefined semantics.

- [ ] Add Intl locale subsetting with deterministic configuration and cache identity.
      Missing data must follow an explicit failure or fallback policy.

# ECMAScript correctness

## Modules and agents

- [ ] Finish dynamic-import resolution, import attributes, evaluation order, and error
      ordering. Cover compiled, interpreted, and runtime-loading paths.

- [ ] Implement import-defer syntax and semantics. Integrate it with linking,
      evaluation state, cycles, and failure propagation.

- [ ] Implement AbstractModuleSource and source-phase imports. Preserve module identity
      and host loading boundaries across cached and uncached compilation.

- [ ] Add $262.agent and multi-agent Atomics behavior. Define worker lifetime, shared
      memory, synchronization, cleanup, and harness failure reporting first.

## Active correctness clusters

- [ ] Fix remaining RegExp @@replace protocol and coercion cases. Prefer shared
      replacement semantics over case-specific branches.

- [ ] Fix remaining arguments-object indexed-property creation, legacy caller, and
      parameter-expression behavior. Cover strict, sloppy, mapped, and unmapped forms.

- [ ] Work class, compound-assignment, super, Proxy, and iterator-helper failures in
      descending shared-root-cause order. Keep each repaired cluster in the curated
      regression manifest.

- [ ] Complete script-global environment-record behavior across separately evaluated
      scripts. Preserve declaration conflicts, deletability, global-object interaction,
      and lexical bindings.

- [ ] Preserve iterator [[Done]] semantics in positional destructuring. Keep abrupt
      completion and iterator closing correct around exhausted iterators.

## Engine capabilities

- [ ] Replace the fixed 128-bit BigInt representation with arbitrary-precision digits.
      Remove width approximations from arithmetic, parsing, formatting, comparison,
      typed operations, and serialization.

- [ ] Implement Unicode case mapping beyond the ASCII fallback. Use versioned data and
      cover context-sensitive and multi-code-point mappings.

- [ ] Work Intl from generated failure clusters covering supported values, locale
      options, NumberFormat, DateTimeFormat, and interval collapsing. Keep data
      availability distinct from algorithmic correctness.

- [ ] Generate a ranked failure-cluster report from scripts/test262.json. Use it rather
      than mutable hand-maintained counts to select correctness work.

# Eval, Function, and Realms

## Eval correctness

- [ ] Finish EvalDeclarationInstantiation behavior for persistence, deletion,
      non-definable globals, and strict or sloppy conflicts. Cover every relevant
      environment kind.

- [ ] Complete direct-eval arguments and parameter-environment behavior. Preserve
      mapped parameters, parameter expressions, shadowing, and strict-mode differences.

- [ ] Complete eval-created and nested new.target behavior. Keep direct eval connected
      to the correct active function or constructor without exposing it indirectly.

- [ ] Preserve direct-eval completion-value identity and lexical write-back semantics.
      Cover abrupt completion and object identity as well as primitives.

## Realm correctness and runtime capabilities

- [ ] Implement module loading for ShadowRealm.prototype.importValue. Preserve
      wrapping, rejection, module identity, and cross-Realm error semantics.

- [ ] Fix residual cross-Realm cases selected from the committed Test262 verdict.
      Distinguish semantic builtin identity from exact per-Realm object identity.

- [ ] Accept erasable TypeScript syntax in runtime eval using a native
      blank-space-preserving stripper. Re-evaluate the compact implementation before
      selecting a larger dependency.

- [ ] Cache compiled runtime-eval wire buffers by source and compilation context.
      Include world policy, Realm, host capabilities, and format identity.

- [ ] Optionally tier hot eval-created functions through native C compilation when a
      toolchain is available. Preserve interpreter fallback.

# Host architecture and transport

The accepted ownership, streaming, cancellation, and event-loop contract is
docs/decisions/03-wave-0-host-architecture.md. Engine objects own language semantics,
API adapters own their public surfaces, and the host owns DNS, sockets, TLS, clocks,
entropy, cancellation, and reactor completions.

## Active host work

- [ ] Finish H1 with Happy Eyeballs racing, bounded teardown for resolvers stuck in
      getaddrinfo, a public one-turn pump, embedder access to the wake source, and
      runtime-owned timer state.

- [ ] Finish H2 hard limits, pipelining, and parser fuzzing around shared llhttp and
      streaming servers. Cover fragmentation, backpressure, cancellation, malformed
      input, and cleanup.

- [ ] Finish H3 connection pooling and the neutral streaming HTTP/1 client used by
      WinterTC fetch and Node adapters. Keep decompression policy above the host layer.

- [ ] Finish H4 sanitizer, fuzz, leak, symbol-size, and benchmark gates for optional
      Rustls. Keep TLS cancellation and teardown correct under GC stress and partial
      connection failure.

# WinterTC web platform

The target is the complete ECMA-429 server surface except WebAssembly. Mal.serve
remains a Maligator extension and does not count as global fetch conformance.

## W1: semantic substrate and streaming boundary

- [ ] Complete DOMException stack, descriptors, serialization, Web IDL behavior, and
      integration into stream and fetch errors. Use shared exception construction.

- [ ] Complete AbortController and AbortSignal coercions, dependent-signal lifetime,
      and cancellation integration. Expand applicable WPT once fetch shares the path.

- [ ] Define global exception and rejection reporting, including reportError,
      microtask failures, and exactly-once uncaught reporting. Choose the ECMA-429
      server-global mechanism explicitly.

- [ ] Complete residual byte-stream BYOB, descriptor, error, cancellation, and
      TransformStream semantics. Keep active Streams WPT slices green under normal and
      GC-stress execution.

- [ ] Bridge host llhttp headers and bodies to Web Streams without exposing parser
      buffers or socket ownership. Backpressure, EOF, abort, failure, and teardown each
      need one completion path.

## W2: bytes, bodies, URLs, and transforms

- [ ] Complete BodyInit validation, arbitrary stream bodies, asynchronous consumption,
      BYOB, tee, and remaining Request and Response properties. Preserve single-use and
      cancellation behavior.

- [ ] Implement Blob storage and streaming, File metadata, ordered FormData, multipart
      parsing and serialization, URL-encoded extraction, and Body.formData. Give native
      backing objects correct tracing and finalization.

- [ ] Complete Headers guards, Web IDL record conversion, descriptors, and
      Proxy-sensitive behavior. Expand applicable WPT with outbound fetch.

- [ ] Complete URL and URLSearchParams Web IDL behavior and broader WPT, then implement
      URLPattern. Connect object URLs after Blob lifetime and revocation are defined.

- [ ] Add remaining TextDecoder labels and Web IDL details, then implement encoding
      streams over TransformStream. Use versioned encoding data and incremental state.

- [ ] Add compression streams over a DCE-friendly backend. Cover format selection,
      chunking, flushing, errors, cancellation, and native-state cleanup.

## W3: fetch and crypto

- [ ] Implement global fetch over shared streaming HTTP and optional TLS after H3 and
      H4 are ready. Cover redirects, aborts, streamed bodies, limits, errors, and
      finalization without a private HTTP stack.

- [ ] Define server-runtime origin, credentials, cache, default User-Agent, and
      decompression policies. Document intentional Fetch divergences.

- [ ] Complete Crypto, CryptoKey, and SubtleCrypto with audited primitives and exact
      WebCrypto errors. Keep entropy at the engine-neutral host boundary.

## W4: compatibility closure

- [ ] Complete Console, timers, Performance, base64, global aliases, and remaining
      descriptors. Keep clocks and timer state isolate-owned.

- [ ] Complete EventTarget, event subclasses, MessageChannel, and MessagePort. Include
      listener options, entanglement, transfer, task delivery, reentrancy, and lifetime.

- [ ] Complete structured cloning for DataView, Blob, File, MessagePort transfer,
      active platform objects, properties, and Realm boundaries. Reuse compatible
      rules for actors.

- [ ] Expand to every applicable pinned ECMA-429 WPT and remove stale expected
      failures. Publish WebAssembly as the sole intentional exception.

# Node and ecosystem compatibility

- [ ] Complete package.json exports wildcard matching, null targets, validation, and
      remaining modern Node resolution. Test the general resolver rather than pinned
      dependency paths.

- [ ] Complete observable node:http and node:net behavior beyond Express and
      postgres.js. Add socket APIs, Agent reuse, validation, lifecycle, cancellation,
      and error ordering over shared transport.

- [ ] Close measured Express performance gaps without regressing fixture behavior or
      bare-server throughput. Profile before selecting compiler or runtime work.

- [ ] Exercise postgres.js logical replication, prepared transactions, negotiated TLS,
      and primary or standby selection against a dedicated topology. Keep
      topology-dependent tests separate from the deterministic local baseline.

# Testing, profiling, and developer tooling

## Product profiling

- [ ] Add repeat, warmup, or minimum-duration handling for short profiled commands and
      a CLI for rendering existing captures. Document interval overrides as expert
      diagnostics requiring overhead revalidation.

- [ ] Add real help and unknown-option handling to scripts/bench.ts. Informational or
      invalid invocations must exit before builds or benchmarks begin.

- [ ] Improve paired-benchmark turnaround with adaptive progress and explicit
      maximum-pair or inconclusive outcomes. Keep elapsed-time and throughput policies
      distinct.

- [ ] Harden the authenticated Claude and Fable review harness with a small read-only
      smoke, bounded cleanup, and explicit external-disclosure approval. Never expose
      or persist authentication material.

## First-class testing

- [ ] Add watch mode, snapshots, fake timers, and mocking when their semantics can
      remain deterministic in compiled and interpreted tests. Keep the unit loop fast.

- [ ] Add coverage, browser environments, parallel workers, and process-per-file
      isolation independently. Define cache, port, temporary-directory, and
      failure-reporting behavior for each.

- [ ] Add benchmark, fuzzing, and test-plugin support after stable extension points
      exist. Plugins must not silently broaden sandbox, host, or network capabilities.

## Test262 throughput

- [ ] Capture and analyze a current cold compiled-suite profile without updating the
      verdict baseline. Re-rank work from current phase, RSS, object-size, and link
      evidence.

- [ ] Evaluate resumable static call tables and adopt them only if they materially
      reduce generated C or object size. Preserve resumability, identity, and debugging.

- [ ] Merge additional byte-identical immutable helpers, constants, and debug tables
      without merging JavaScript identity or mutable state. Report size and compile-time
      effects.

- [ ] Measure lower literal-template thresholds on medium definitions and select a cost
      model rather than fixture-specific cutoffs. Include runtime allocation, output
      size, and compilation time.

- [ ] Use worker controls and batch reports to measure C compilation and link
      contention. Limit concurrent links only when attribution confirms contention.

- [ ] Add bounded targeted profiling flags for timeout, RSS, CPU, GC statistics, and
      phase markers. Require a filter or manifest and retain both watchdog deadlines.

# Actors, SMP, and embedding

## Actors

- [ ] Build rooted actor mailboxes and spawn, send, and receive semantics on fibers.
      Define message ordering, actor lifetime, roots, and teardown first.

- [ ] Integrate reduction-budget scheduling and prove a tight-loop actor cannot starve
      peers. Keep host completions and microtasks fairly observable.

- [ ] Copy actor messages with structured-clone semantics and support transferables.
      Preserve the no-cross-heap-pointer rule required by SMP.

- [ ] Add links, monitors, kill, cancellation, and deterministic teardown. Specify
      failure propagation without bypassing exception reporting.

## SMP

- [ ] Move fiber, scheduler, GC, root, hook, clock, and host state from process globals
      into thread-local or isolate-owned structures. Preserve the single-isolate path.

- [ ] Run one isolate and scheduler per OS thread. Keep heaps and language objects
      isolated unless data is explicitly cloned or transferred.

- [ ] Implement cross-isolate send as copy plus MPSC enqueue and backend wake. Make
      queue ownership and shutdown races explicit.

- [ ] Add work stealing only for work without isolate-local pointers. Measure fairness
      and cache effects before enabling it by default.

- [ ] Verify independent per-isolate collection without cross-heap pointers or global
      stop-the-world coordination. Stress simultaneous collection, messaging,
      cancellation, and shutdown.

- [ ] Validate the x86_64 fiber switch on Linux. Retain ABI and sanitizer coverage.

## Embedding and freestanding targets

- [ ] Expose the H1 one-turn pump and wake source through a stable embedding API.
      Permit foreign GUI loops to retain event-loop ownership.

- [ ] Drive a Rust GUI stack through the FFI as an embedding experiment. Validate
      lifecycle, wakeups, callbacks, rendering-loop integration, and shutdown.

- [ ] Build scheduler, reactor, and GC core without libc over a fixed arena. Make
      unsupported dynamic facilities fail explicitly.

- [ ] Add a poll or ISR backend and fixed-size fiber stacks for constrained targets.
      Keep backend selection separate from JavaScript semantics.

- [ ] Define a minimal-core profile omitting unused bytecode, Intl data, web APIs, and
      host modules. Verify omitted personalities do not remain linked indirectly.

# Triggered work

These are not active tasks and become actionable only when their condition is
observed.

- Add concurrent marker or parallel GC workers only when a realistic large-heap
  workload shows mutator marking is a leading cost.
- Move compiled-call arguments through a separately rootable seam only if a rooting
  audit supports exact live-across-safepoint frames.
- Elide SATB barriers only if concurrent GC becomes the default and a realistic
  store-heavy workload makes the barrier material.
- Revisit MalVm and host-structure layout when multiple VMs or isolates are active in
  one process.
- Choose segmented, guarded, or fixed fiber stacks when measured actor density makes
  the current policy limiting.
- Consider separate actor heaps only if idle actor density becomes a measured
  constraint; preserve copy-message semantics meanwhile.
- Add io_uring only after epoll validates the completion-oriented reactor interface.
- Reconsider timezone-offset caching only if Date profiling makes it a top-five
  self-time contributor.
