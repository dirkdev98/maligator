Write application tests with `maligator:test`. Ordinary `maligator test` interprets a compiled development image and does not invoke a native C compiler or linker.

## Write a test

Create these files in a project with `maligator.build.ts`:

{{example:sum.ts}}

{{example:sum.test.ts}}

```shell
maligator test sum.test.ts
```

The runner reports both tests as passed. It discovers `*.test.{js,mjs,ts,mts}` and `*.spec.{js,mjs,ts,mts}` when given directories or no explicit files. Successful results are never cached: every selected test executes on each run.

## Filter and repeat tests

```shell
maligator test --run "sum adds values"
maligator test --shuffle 42 --repeat 3
maligator test --timeout 10000 --bail
```

`--run` filters hierarchical suite/test names. Selection is stable and serial by default. The callback timeout defaults to 5000 milliseconds. `--shuffle` prints its seed; keep that seed to reproduce the order. `--repeat` reruns the registered suite without recompiling. `--bail` stops after the first failure; ordinary runs complete the selection.

Use `test.skip`, `test.todo`, and `test.only` for temporary selection. Any `.only` skips non-focused tests and prints a warning. Remove focus before sharing the suite.

## Await asynchronous assertions

```typescript
import { expect, test } from "maligator:test";

test("awaits a value", async () => {
	await expect(Promise.resolve({ answer: 42 })).resolves.toEqual({ answer: 42 });
	await expect(Promise.reject(new Error("unavailable"))).rejects.toThrow("unavailable");
});
```

Return or await promises from test and hook callbacks. Await `.resolves` and `.rejects` matchers so the assertion finishes before the test does. Suite callbacks passed to `describe` must be synchronous. See [matchers](/api/test#Matchers) and [hooks](/api/test#beforeEach) for the exact contracts.

## Watch or isolate a suite

```shell
maligator test --watch --status
maligator test --isolate --compile-concurrency 2 --concurrency 2
```

Watch mode retains compiled images and starts a fresh application on each rerun. On POSIX, sending SIGHUP to the printed PID reruns unchanged inputs. Add `--watch-failed` to select previously failing files for those unchanged reruns.

Selected files normally share one application isolate, including module singletons and globals. `--isolate` gives each file separate application state; `--compile-concurrency` and `--concurrency` bound compilation and execution separately. Isolation requires a compatible native runtime policy. The supervisor joins the application and its descendants after every run, including resources tests left open.

`--profile` compiles a production AOT test image for profiling. It cannot be combined with `--watch` or `--isolate` and requires the native toolchain. See [CLI test flags](/api/cli#test).

For tests of the compiler repository itself, follow [Develop Maligator](/guides/contributing).
