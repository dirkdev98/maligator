# eval, Function, and realms roadmap

Indirect/global eval, Function-family constructors, direct lexical eval, realms,
and ShadowRealm evaluation are implemented. This file tracks the residual work.

## Active correctness

- [ ] Finish EvalDeclarationInstantiation edges for local declaration persistence
      and deletion, non-definable globals, and strict/sloppy declaration conflicts.
- [ ] Fix remaining direct-eval `arguments` and parameter-environment behavior.
- [ ] Finish remaining eval-created and nested `new.target` cases.
- [ ] Preserve direct-eval completion-value identity and write-back semantics.

Select additional eval work from the current failures in `scripts/test262.json`;
do not copy mutable counts into this roadmap.

## Active realm correctness

- [ ] Implement module loading for `ShadowRealm.prototype.importValue` and clear its
      remaining module-loading tests.
- [ ] Fix residual cross-realm correctness cases selected from the committed
      Test262 verdict.

## Queued runtime capabilities

- [ ] Accept erasable TypeScript syntax in runtime eval with a native blank-space
      stripper. Re-evaluate the existing compact stripper before selecting a larger
      dependency.
- [ ] Cache compiled runtime-eval wire buffers by source and compilation context.
- [ ] Optionally tier hot eval-created functions through native C compilation when a
      toolchain is available; retain interpreter fallback.
