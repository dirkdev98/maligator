# Test262 correctness roadmap

`scripts/test262.json` is the sole committed source for verdicts and counts. Select
correctness work from its current failures; do not copy per-filter totals into this
document.

## Queued cross-cutting features

- [ ] Finish dynamic import runtime resolution, attributes, and evaluation/error
      order beyond implemented literal module loading.
- [ ] Implement import-defer forms.
- [ ] Implement `AbstractModuleSource` support required by source-phase imports.
- [ ] Add `$262.agent` and multi-agent Atomics behavior. Core Atomics and
      SharedArrayBuffer are already implemented.

`ShadowRealm.prototype.importValue` is owned by the
[`eval` and realms roadmap](eval-realms.md).

## Active correctness clusters

- [ ] Fix the remaining RegExp `@@replace` protocol/coercion cases. `@@split`,
      `@@match`, and `@@search` are complete in the committed baseline.
- [ ] Fix remaining arguments-object own-index creation, legacy caller, and
      parameter-expression cases.
- [ ] Work the current class, compound-assignment, `super`, Proxy, and iterator-helper
      clusters in descending shared-root-cause order.
- [ ] Fix the remaining script-global environment-record behavior across separately
      evaluated scripts.
- [ ] Preserve iterator `[[Done]]` semantics in positional destructuring edge cases.

Sweep nearly complete builtins only from current `scripts/test262.json` failures and
remove a target as soon as its filter is green.

## Queued engine capabilities

- [ ] Replace the 128-bit BigInt backing with arbitrary-precision digits and remove
      width approximations.
- [ ] Implement Unicode case mapping beyond the current ASCII-only fallback.
- [ ] Work Intl from generated current failure clusters, including supported-value
      enumeration, locale options, NumberFormat styles, DateTimeFormat components,
      and interval collapsing.

## Active process work

- [ ] Generate a ranked failure-cluster report from `scripts/test262.json` so the
      correctness queue does not require a manually maintained count table.

Keep focused filters and the curated regression manifest green while working. Run
the full Test262 suite only with explicit approval.
