# Curated WPT runner

`npm run test:wpt` runs the small server-runtime-relevant corpus in
`curated.json` through Maligator's native web-platform host. Schema-2 results
are written to `.cache/wpt/results.json` with explicit path, variant, backend,
mode, harness status, subtest ID, resolved name, and occurrence dimensions. The
command exits non-zero for a harness/setup error, malformed or incomplete
transport, missing subtest, stale expectation, unexpected failure, or
unexpected pass.

The repository smoke and check tiers run deterministic compiled/normal
partitions of this corpus. The full tier adds compiled GC verification and both
interpreted modes. See [`docs/testing.md`](../../docs/testing.md) for tier and
test-placement policy.

The corpus is pinned to web-platform-tests/wpt revision
`f0b30d60daf6a64a3b087d66732c54c8e5273dbd`. A minimal fixture tree containing
only selected, unmodified upstream files and support scripts is committed under
`fixtures/wpt/`. `curated.json` pins the SHA-256 of every test and every
`META: script` include. It also records the source's exact initial contiguous
`// META:` declaration block; metadata drift fails before native builds begin.

To use an external checkout, set `WPT_ROOT` to its repository root:

```sh
WPT_ROOT=/path/to/wpt npm run test:wpt
```

The checkout's `git rev-parse HEAD` must be the exact pinned revision. Selected
source and support files are still checked against their manifest hashes. No
network fetch is performed by the runner, and an existing results report is not
removed during argument, manifest, or checkout validation.

Repeat `--test` to select exact curated paths. Selection retains manifest order:

```sh
npm run test:wpt -- --test url/urlsearchparams-delete.any.js
```

By default, each test runs its manifest-declared `modes` with only the compiled
backend. Repeat `--mode` or `--backend` to select deterministic subsets or a
backend matrix:

```sh
npm run test:wpt -- \
  --test url/urlsearchparams-delete.any.js \
  --mode normal \
  --backend compiled \
  --backend interpreted
```

Accepted modes are `normal` and `gc-stress`; accepted backends are `compiled`
and `interpreted`. An explicitly requested mode that a selected manifest entry
does not declare is an error. Interpreted executions use the same native host
with `buildNativeBinary({ compiled: false })`.

`--policy bail` stops after the first unexpected execution and writes a partial
report. `--policy complete` is the default for the leaf runner and always writes
the complete selected report. `npm run test:wpt:report` is the canonical
compiled/normal coverage command. `npm run test:wpt:matrix-report` explicitly
requests normal and GC-stress modes on compiled and interpreted backends. Both
report commands use the committed pinned fixture and ignore ambient test/build
dimensions; direct `npm run test:wpt` invocations retain `WPT_ROOT` support.

The adapter parses repeated `META: variant` and `META: script` declarations.
With no variant declaration it runs the empty variant; with no global declaration
it records the upstream `.any.js` defaults (`window,dedicatedworker`). Each variant
receives a deterministic `location.pathname`, `location.search`, and `location.hash`,
plus `self = globalThis`. Static support scripts execute between the adapter and test
source in metadata declaration order. Query-bearing and generated support resources
are rejected because the byte-pinned runner cannot reproduce WPT server transforms.

Every curated entry explicitly declares `target: "server-main"`. This is a
reviewed applicability contract, not a claim that the host is a Window or any
kind of Worker. Upstream `META: global` declarations are pinned for drift
detection but do not change that target or install browser-global emulation.

Expected failures in `expectations.json` match exactly on path, variant,
backend, mode, resolved subtest name, and one-based occurrence. Each entry also
records one of `FAIL`, `TIMEOUT`, or `CRASH`, the owning milestone, reason, and
upstream revision. Wildcards, skips, file-wide entries, and schema-1 inputs are
not accepted. Harness/setup errors are always runner failures and cannot be
expected.

`harness.ts` intentionally implements only the testharness primitives required
by this curated server-main slice. It uses pinned testharness default-name
suffixes for unnamed tests, preserves duplicate explicit names with occurrence
numbers while reporting the upstream harness error, and correlates
`WPT_START`/`WPT_RESULT` records by numeric ID. It does not attempt full browser
harness emulation.

`wave-0.txt` remains the broader reviewed candidate list. Adding a curated path
requires reviewing server-main applicability, metadata and support dependencies,
fixture hashes, declared modes, variant behavior, and adapter API use.
