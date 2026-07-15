# Test262 correctness roadmap

`scripts/test262.json` is the sole committed source for verdicts and counts. Select
work from its current failures; do not copy per-filter totals into this document.

## Cross-cutting features

- [ ] Finish dynamic import beyond implemented literal module loading: computed and
      runtime resolution, attributes, source/defer forms, and evaluation/error order.
- [ ] Implement `AbstractModuleSource` support required by source-phase imports.
- [ ] Add `$262.agent` and multi-agent Atomics behavior. Core Atomics and
      SharedArrayBuffer are already implemented.

`ShadowRealm.prototype.importValue` is owned by the
[`eval` and realms roadmap](eval-realms.md).

## Correctness clusters

- [ ] Fix the remaining RegExp `@@replace` protocol/coercion cases. `@@split`,
      `@@match`, and `@@search` are complete in the committed baseline.
- [ ] Finish mapped sloppy arguments aliasing and remaining arguments-object cases.
- [ ] Work the current class, compound-assignment, `for-of`, `super`, Proxy, and
      iterator-helper clusters in descending shared-root-cause order.
- [ ] Fix the remaining script-global environment-record behavior across separately
      evaluated scripts.
- [ ] Preserve iterator `[[Done]]` semantics in positional destructuring edge cases.
- [ ] Replace the 128-bit BigInt backing with arbitrary-precision digits and remove
      width approximations.
- [ ] Implement Unicode case mapping beyond the current ASCII-only fallback.
- [ ] Finish Intl residuals: ICU-backed supported-value enumeration, locale option
      handling, NumberFormat styles, DateTimeFormat component options, and interval
      collapsing.
- [ ] Preserve bound functions' initial display name independently of their
      configurable public `name` property.
- [ ] Sweep nearly-complete builtins only from a generated current failure list;
      remove a target as soon as its filter is green.

## Process

- [ ] Generate a ranked failure-cluster report from `scripts/test262.json` so the
      correctness queue does not require a manually maintained count table.

Keep focused filters and the curated regression manifest green while working. Run
the full Test262 suite only with explicit approval.
