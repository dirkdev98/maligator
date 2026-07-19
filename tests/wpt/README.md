# Curated WPT runner

`npm run test:wpt` runs the small server-runtime-relevant corpus in
`curated.json` through Maligator's native web-platform host. Results are retained
at subtest granularity and written to `.cache/wpt/results.json`. The command exits
non-zero for a harness error, missing subtest, unexpected failure, or unexpected
pass.

The corpus is pinned to web-platform-tests/wpt revision
`f0b30d60daf6a64a3b087d66732c54c8e5273dbd`. A minimal fixture tree containing
only the selected, unmodified upstream files is committed under `fixtures/wpt/`;
each file's SHA-256 is part of `curated.json`. This keeps normal repository tests
self-contained without vendoring a WPT checkout.

To use an external checkout, set `WPT_ROOT` to its repository root:

```sh
WPT_ROOT=/path/to/wpt npm run test:wpt
```

The checkout must be clean enough for `git rev-parse HEAD` to return the exact
pinned revision. Selected files are still checked against their manifest hashes.
No network fetch is performed by the runner.

`harness.ts` supplies the synchronous and promise testharness primitives needed
by this curated slice and emits one `WPT_RESULT` JSON record per subtest followed
by one `WPT_HARNESS` record. It does not emulate window or worker globals. The
adapter deliberately creates a server-main variant instead of selecting an
upstream generated Window or Worker variant; therefore every selected source,
including sources with `META: global`, must be reviewed as global-agnostic.

Expected failures live in `expectations.json`. Every entry names an exact test
path and subtest, one of `FAIL`, `TIMEOUT`, or `CRASH`, the owning milestone, a
reason, and the same upstream revision. File-wide entries, wildcards, skips, and
harness/setup failures are not accepted. A stale expectation is an unexpected
pass and fails the run.

`wave-0.txt` remains the broader reviewed candidate list. `curated.json` is the
first executable subset; adding a path requires reviewing its dependencies,
global applicability, fixture hash, GC-stress suitability, and adapter API use.
