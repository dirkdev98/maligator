# eval, Function, and realms roadmap

Indirect/global eval, Function-family constructors, direct lexical eval, realms,
and ShadowRealm evaluation are implemented. This file tracks the residual work.

## Runtime compilation

- [ ] Add a native TypeScript blank-space stripper for runtime eval so deployed
      binaries do not require Node. Re-evaluate current SWC compatibility before
      selecting it over a small span-based implementation.
- [ ] Cache compiled eval/module wire buffers by source and compilation context.
- [ ] Optionally tier hot eval-created functions through native C compilation when a
      toolchain is available; retain interpreter fallback.

## Direct eval

- [ ] Finish EvalDeclarationInstantiation edges for local declaration persistence
      and deletion, non-definable globals, configurable-property updates, and
      strict/sloppy declaration conflicts.
- [ ] Marshal enclosing and arrow lexical bindings, including remaining `arguments`
      behavior, into direct eval.
- [ ] Finish the remaining `new.target`, `super`, and runtime-added-global
      compound/update cases.
- [ ] Clear the residual direct-eval and eval-dependent language failures recorded in
      `scripts/test262.json` without copying their mutable counts here.

## Realms

- [ ] Implement module loading for `ShadowRealm.prototype.importValue` and clear its
      remaining module-loading tests.
- [ ] Fix residual cross-realm correctness cases selected from the committed
      Test262 verdict.
