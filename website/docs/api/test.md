Import tests and assertions from `maligator:test`; run them with `maligator test`. Tests and hooks may return promises, which the runner awaits. `describe` callbacks register suites synchronously and cannot return promises.

{{example:sum.ts}}

{{example:sum.test.ts}}

Run `maligator test sum.test.ts`. See [Test an application](/guides/testing) for discovery, selection, watch, timeouts, and isolation.

Assertions throw on mismatch. Promise matchers return promises; await them. Hooks follow suite nesting, and cleanup hooks are still attempted after a failing test. `.only` focuses selection and emits a warning. The reference below includes every supported matcher; it does not imply support for other testing libraries' APIs.
