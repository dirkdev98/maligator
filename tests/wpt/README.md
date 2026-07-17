# Curated WPT metadata

This directory contains documentation and path manifests only. It does not contain
a WPT checkout, copied tests, an executable harness, or claimed results. The first
candidate list is `wave-0.txt`, verified to exist at web-platform-tests/wpt commit
`f0b30d60daf6a64a3b087d66732c54c8e5273dbd` on 17 July 2026.

## Manifest contract

- Paths are repository-relative paths in the pinned upstream WPT checkout.
- Blank lines and lines beginning with `#` are metadata; every other line is one
  exact test path. Globs and directories are forbidden so suite growth is reviewed.
- `.any.js` variants are selected by the future adapter from their `META` globals.
  Maligator initially maps only the server main global; browser windows, service
  workers, and dedicated workers are not silently treated as equivalent.
- WPT resources, `testharness.js`, generated variants, HTTPS, and local HTTP
  endpoints must be supplied by a real upstream-compatible adapter. A test is not
  rewritten merely because the compiler cannot yet parse or host it.
- The manifest is a candidate corpus, not a promise that the files can run today.
  Adding a fake runner that reports file-level pass/fail is explicitly out of scope.

The first list favors portable `.any.js` coverage for currently exposed primitives
and known residuals: abort/events, timers, base64, encoding, Fetch objects, URL, and
performance. W1-W4 should add separate exact-path manifests for Streams/messaging,
bodies/File/FormData, network Fetch/compression/crypto, and global/WebAssembly
closure rather than turning this file into the entire WPT suite.

## Expected failures

Expected failures are recorded only after the real adapter has produced a result at
the pinned WPT revision. The baseline strategy is:

1. Store expectations at **subtest** granularity using exact test path, exact
   subtest name, expected status, owning milestone, reason, and upstream revision.
2. Permit only `FAIL`, `TIMEOUT`, or `CRASH`; absence of a required global is a
   normal `FAIL`, not a skip. A harness/setup failure is never an API expectation.
3. Use `SKIP` only for an ECMA-429-inapplicable global kind or unavailable platform
   facility, with the applicability decision documented in the roadmap. Missing
   Maligator functionality is not inapplicability.
4. Reject directory, file-wide, wildcard, and anonymous expectations unless every
   subtest provably has one root cause. Keep mixed pass/fail files visible.
5. Fail CI on unexpected pass as well as unexpected failure. Removing the defect
   must remove the expectation in the same change; revision bumps require a fresh
   baseline review.
6. Keep compiler failures, harness incompatibilities, engine ECMA-262 failures, API
   failures, native crashes, and leaks as distinct result classes. Run accepted
   candidates normally and under GC stress/verification when timing permits.

Known pre-harness failure clusters are documented in the capability matrix, not
encoded as fictional results. Examples include non-`DOMException` abort/base64/
clone errors, UTF-8-only decoder behavior, Headers normalization/iteration, snapshot
`URL.searchParams`, plain-object Performance, and missing outbound `fetch()`.
