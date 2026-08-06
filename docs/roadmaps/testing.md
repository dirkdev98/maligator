# First-class testing

Status: MVP implemented

## Product contract

`maligator test [file-or-directory ...]` discovers `*.test.{js,mjs,ts,mts}` and
`*.spec.{js,mjs,ts,mts}` files, compiles the selected files and their union
dependency graph into one portable VM test image, and executes that image with
the interpreter embedded in the installed Maligator executable. Shared
dependencies are parsed, analyzed, lowered, and initialized once. Test runs
never emit C, select a native toolchain, or invoke a compiler/linker.

The public authoring module is owned by Maligator:

```js
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "maligator:test";
```

This API is intentionally not a compatibility layer for Node, Jest, or Vitest.
The initial lifecycle includes nested suites, synchronous and asynchronous
callbacks/hooks, `skip`, `todo`, `only`, and data-driven `each`. A committed
`only` narrows the run and emits a warning; it is not a hard failure in the MVP.

## Registration protocol

The compiler brackets each test entry's module initialization with an internal
file-boundary protocol. This creates one implicit top-level suite per file, so
root hooks do not leak across files even though all files share a Realm. The
public functions write beneath that suite in a small runner-owned tree. A suite
has a stable registration index, name, parent, four ordered hook lists, child
suites, and tests. A test has a name, callback, registration index, and run mode
(`normal | skip | todo | only`). The public matcher layer only throws structured
assertion errors; it does not decide scheduling or reporting.

The coordinator invokes the internal `run(options)` export after the test module
has evaluated. That boundary is deliberately smaller than the public API so a
future adapter can populate the same suite tree without replacing discovery,
execution, or reporters.

## Runner event protocol

Execution produces ordered events rather than printing directly:

- `run-start` / `run-end`
- `suite-start` / `suite-end`
- `test-start` / `test-pass` / `test-fail` / `test-skip` / `test-todo`
- `hook-fail`
- `diagnostic`

Every event carries a monotonic sequence number. Test and hook events carry a
hierarchical name and duration where applicable. Failures use owned categories:
`assertion`, `test`, `hook`, `timeout`, `module-load`, `syntax`, or
`infrastructure`. The CLI's concise text reporter consumes this event/result
object. JSON, TAP, editor, and CI reporters can consume the same protocol later.

## Discovery and selection

Discovery is recursive for directories and stable by normalized absolute path.
Explicit files are accepted even when their names do not match a convention.
The default path is the current directory. `--run` filters the full hierarchical
test name. Shuffle uses a deterministic seeded PRNG and always reports the seed.
`--repeat` re-executes the registered tests without reloading or recompiling the
image. A cached image containing a requested file can serve a narrower
selection; the internal run protocol filters execution to the requested file
identities. Bail is opt-in; completion is the default.

## Lifecycle

Suites execute depth-first in registration order unless shuffled. `beforeAll`
and `afterAll` bracket the suite's direct tests and nested suites. `beforeEach`
runs outer-to-inner; `afterEach` runs inner-to-outer. A `beforeEach` failure is
reported against its test and suppresses the test callback, while cleanup hooks
still run. A `beforeAll` or `afterAll` failure is a suite hook failure.

Promise-returning callbacks are awaited. A per-callback timeout races async
completion and is categorized separately. The runner clears its timeout when
the callback settles. Resource cancellation is not claimed: the MVP reports
late async activity as a limitation instead of pretending it was isolated.

## Isolation and concurrency

The MVP executes one test image serially in one isolate and one Realm. Test
files have distinct registration/hook suites, but `globalThis`, intrinsic
prototypes, module instances, host state, and pending host resources are
shared. Every selected test module finishes top-level initialization, in stable
graph order, before test callbacks start. Shared application dependencies are
initialized once. The CLI reports this honestly. Per-file Realm execution is a
future option once host installation and resource cleanup can be made
Realm-aware; the image's stable entry identities remain valid across that
change.

Compilation concurrency and execution concurrency are separate coordinator
settings. The MVP keeps execution concurrency at one. Its frontend currently
runs synchronously, so compile concurrency is also one, but serial execution is
not used as a reason to suppress a future compiler-worker pool.

## Cache boundaries

The cache stores serialized VM test artifacts, never a test result. A linked
image has three layers:

1. A base artifact initializes `maligator:test`, application dependencies, host
   modules, and a registry of live module namespace objects.
2. One independently cached registration fragment per test file binds its
   imports through a small facade and registers callbacks inside the implicit
   file suite.
3. A stable runner fragment invokes the internal execution protocol after every
   selected registration fragment has loaded.

VM definitions remain self-contained and position independent:
`mal_vm_splice_definition` rebases their function, global, constant, CommonJS,
and debug tables when loading them into the shared interpreter. The link ABI
between definitions is the toolchain-owned namespace registry on `globalThis`;
it contains no process address, native object handle, or cache-local slot
number.

Named/default imports in a relocatable test fragment are snapshots taken after
the base dependency graph has initialized. This is the intentional fast-test
semantic for stable application APIs. Namespace imports, re-exports, dynamic
imports, `require`, CommonJS test entries, and test-to-test imports retain
ordinary module semantics through the whole-image fallback. Adding a new
fragment strategy does not require changing the public `maligator:test` API.

Cache identity includes:

- the stable sorted test-entry set and synthetic image entry source;
- the content of every transitive on-disk module;
- the `maligator:test` implementation;
- resolved build flags relevant to parsing, linking, and lowering;
- the compiler/runtime version and VM wire version; and
- the TypeScript stripping implementation identity.

A manifest records image entries, base/fragment/runner artifact hashes, plus
dependency paths, sizes, mtimes, and content digests. An unchanged warm run
validates both stat signatures and source digests, then loads wire without
rebuilding the graph. Per-entry aliases allow a narrow selection to reuse an
already-compiled superset base while loading only requested registration
fragments. Any changed content rebuilds the union planning graph and hashes all
reachable modules before publishing affected content-addressed artifacts.
Execution always happens after a cache hit.

One `TestCompilationSession` owns the command's filesystem snapshot, so a shared
dependency is read and hashed once even during failure-containment compilation.
Its explicit `invalidate(path)` operation is the watcher seam: a future file
watcher retains the session, invalidates reported paths, rediscovers affected
entry identities, and requests a new image. A changed test file normally
invalidates one registration fragment; a changed application dependency
invalidates the base while preserving every registration fragment whose source
and import facade are unchanged. Correctness does not depend on mtime-only
invalidation.

Frontend failures are contained by recursively dividing the entry set, allowing
healthy groups to compile and execute. Module-initialization failures use exact
sub-images for the same containment policy rather than repeatedly loading a
failing superset artifact. Successful runs keep the fast single-image path.

Cold, warm, changed-entry, changed-shared-dependency, many-file, and async-heavy
fixtures report discovery, frontend/cache, and execution time separately. The
reproducible exercise is:

```sh
node scripts/test-runner-performance.ts /path/to/maligator
```

It generates 20 small files plus an async-heavy file in a temporary project,
measures each cache case, and removes the project afterward.

The 2026-08-06 local product-build comparisons measured:

| Scenario                   | Per-file graphs | Shared image | Relocatable fragments |
| -------------------------- | --------------: | -----------: | --------------------: |
| Cold, 21 files / 60 tests  |       20,376 ms |     1,412 ms |              1,358 ms |
| Warm unchanged             |           15 ms |         3 ms |                  4 ms |
| One changed selected test  |          950 ms |       912 ms |                 50 ms |
| Changed shared dependency  |       19,257 ms |     1,427 ms |              1,089 ms |
| Warm async-heavy selection |           40 ms |         2 ms |                  2 ms |

The relocatable cold breakdown was 130 ms graph construction, 48 ms semantic
analysis, 1,160 ms compilation/optimization/lowering, 8 ms serialization, and
1 ms execution, publishing 23 artifacts. Changing one test reused the base and
runner artifacts and rebuilt one fragment in 50 ms. Changing the shared
dependency reused 21 test fragments plus the runner and rebuilt only the base
in 1,089 ms. These numbers are revision- and machine-specific; the script is the
contract, not the absolute values. Retained changes remove repeated work rather
than relying on a timing threshold.

## Diagnostics

Matcher failures are Maligator-owned assertion errors with matcher, expected,
received, and a compact structural difference. Error stacks are captured at
`expect(...)`; the reporter removes frames belonging to `maligator:test` when a
user frame remains. Parse and module-resolution errors are reported before
execution, while loaded-module throws are categorized as module-load failures.
Any failure or infrastructure error gives the command a nonzero exit status.

## Deferred capabilities

The MVP does not include watch mode, snapshots, fake timers, mocking, coverage,
browser environments, parallel test workers, process-per-file isolation,
benchmarks, fuzzing, or a plugin system. Asymmetric matchers are intentionally
represented by a tagged protocol so more can be added without changing deep
comparison. Reporter selection and compile/execution concurrency remain explicit
coordinator seams. Relocatable fragments already load only selected test
entries. The whole-image fallback remains for module shapes that need full live
ESM linkage; it initializes every module in a reused superset before filtering
test execution.
