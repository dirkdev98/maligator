# Test262 performance roadmap

Capture a new cold full-suite baseline before re-ranking generated-code work; the
previous profile predates shared-helper emission. Artifact manifests already retain
per-entry code statistics, and strict and sloppy runs retain separate reports.
Recoverable allocation failure is owned by the [GC roadmap](docs/roadmaps/gc.md).

## Active measurement

- [ ] Capture and analyze a current cold compiled-suite profile without updating the
      committed verdict baseline.

## Queued generated-code work

- [ ] Evaluate resumable static call tables; add them only if they materially reduce
      generated C or object size.
- [ ] Extend existing shared-helper definition merging to other byte-identical
      immutable bodies, constants, and debug tables without merging JavaScript
      identity or mutable state.
- [ ] Measure lower literal-template thresholds on medium definitions and use a cost
      model rather than fixture-specific rules.

## Queued profiling and scheduling

- [ ] Use existing worker-count controls and batch reports to measure C compile/link
      contention; limit concurrent links only if attribution confirms contention.
- [ ] Add bounded targeted profiling flags, valid only with `--filter` or
      `--manifest`, for timeout, RSS, CPU, GC statistics, and phase markers. Keep the
      normal watchdog and an outer kill deadline.

## Triggered work

- Reconsider exact timezone-offset caching only if Date profiling makes offset
  lookup a top-five self-time contributor.
