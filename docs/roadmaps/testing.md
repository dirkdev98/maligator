# First-class testing

Status: MVP implementation roadmap

## Product contract

`maligator test [file-or-directory ...]` discovers `*.test.{js,mjs,ts,mts}` and
`*.spec.{js,mjs,ts,mts}` files, compiles each selected file and its dependency
graph to portable VM wire, and executes that wire with the interpreter embedded
in the installed Maligator executable. Test runs never emit C, select a native
toolchain, or invoke a compiler/linker.

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

The public functions write a small runner-owned suite tree. A suite has a stable
registration index, name, parent, four ordered hook lists, child suites, and
tests. A test has a name, callback, registration index, and run mode
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
file. Bail is opt-in; completion is the default.

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

The MVP executes test files serially in one isolate and one Realm. Each file is
compiled as a distinct module graph with its own registration module instance,
but `globalThis`, intrinsic prototypes, host state, and pending host resources
are shared. The CLI reports this honestly. Per-file Realm execution is the next
isolation step once host installation and resource cleanup can be made
Realm-aware.

Compilation concurrency and execution concurrency are separate coordinator
settings. The MVP keeps execution concurrency at one. Its frontend currently
runs synchronously, so compile concurrency is also one, but serial execution is
not used as a reason to suppress a future compiler-worker pool.

## Cache boundaries

The cache stores serialized VM input, never a test result. Its identity includes:

- test entry path and synthetic entry source;
- the content of every transitive on-disk module;
- the `maligator:test` implementation;
- resolved build flags relevant to parsing, linking, and lowering;
- the compiler/runtime version and VM wire version; and
- the TypeScript stripping implementation identity.

A small per-entry manifest records dependency paths, sizes, mtimes, and content
digests. An unchanged warm run validates stat signatures and loads wire without
rebuilding the graph. Any changed signature rebuilds the graph and hashes all
reachable content before publishing a new content-addressed artifact. Execution
always happens after a cache hit.

Cold, warm, changed-entry, changed-shared-dependency, many-file, and async-heavy
fixtures report discovery, frontend/cache, and execution time separately.

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
coordinator seams.
