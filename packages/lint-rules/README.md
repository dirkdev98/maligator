# Maligator lint rules

An [Oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) plugin with rules
for code that Maligator compiles well. Each rule targets a cost the compiler cannot
remove on its own, or a capability the default closed-world build leaves out, because
removing the cost would change what the program observes. The rules are syntax and
scope checks; they do not run the compiler.

Extend the recommended preset in `.oxlintrc.json`:

```json
{
	"extends": ["./packages/lint-rules/recommended.json"]
}
```

The preset enables Oxlint's default plugins plus `import`, the plugin's default rules,
and these Oxlint rules:

- `no-eval`, `no-new-func` and `no-extend-native`. The default closed-world build
  rejects what they report: runtime eval throws, and built-in objects are locked. The
  open-world build that allows them gives up the optimizations that rely on locked
  built-ins and known source.
- `import/no-dynamic-require` for `require()` and `import()`. A computed `require`
  throws at runtime, and a computed `import()` can only load modules the file also
  imports by a literal name.
- `no-restricted-imports` for `vm` and `node:vm`. The default build cannot compile code
  at runtime, and `vm` contexts need `engine.realms`.
- `prefer-rest-params`. Any use of `arguments` beyond its length, a constant index or
  forwarding it allocates the object on every call and keeps the function from being
  inlined.
- `unicorn/prefer-global-this`. A free `global` links the complete `process`
  implementation, and `self` and `window` keep unused built-ins in the image.

## Default rules

The record rules check locals created from an object literal without a spread. They
skip dynamic keys, dictionaries typed as a `Record` or with an index signature, and
objects they cannot see created.

### `maligator/monomorphic-instances`

- **Reports** a public key first assigned in an instance method, accessor or callback,
  or on some constructor paths only. Fields and keys initialized by a base class are
  already accounted for. The rule skips computed writes and classes whose base it
  cannot resolve in the file.
- **Why:** instances that gain different keys have different shapes, so a property
  read that sees those instances has to handle multiple shapes at the same site.
- **Instead,** declare the key as a class field, such as `estimated;`. The rule
  suggests that edit.
- **Fine when** callers rely on a missing key, such as checking its presence with
  `in` or enumerating keys with `Object.keys`. Disable the rule at the write and
  say why.

### `maligator/monomorphic-objects`

- **Reports** a key added to a record on some paths only: in a branch, loop, `catch`
  or callback.
- **Why:** records from that literal get a different shape per path, so every
  property site that reads them goes through a multi-shape cache path, and the
  compiler can no longer replace the object with its fields.
- **Instead,** initialize the key in the literal, as `undefined` if it has no value
  yet. The rule suggests that edit.
- **Fine when** code tells an absent key from an `undefined` one, through `in`,
  `Object.keys` or spreading the object over defaults. Disable the rule on that line
  and say why.

### `maligator/no-delete-property`

- **Reports** `delete` of a key that other keys of a record follow.
- **Why:** the runtime rebuilds the object's shape without the key and moves the later
  keys to lower slots, so code that reads them meets two layouts. Deleting the last
  key leaves the other slots in place, and the compiler handles that case.
- **Instead,** assign `undefined`, which the rule suggests.
- **Fine when** the key must really be absent, as above.

### `maligator/no-dynamic-global-access`

- **Reports** a use of `globalThis` or `global` other than a member access with a fixed
  key, `typeof`, or an `===`/`!==` comparison: a computed key, an alias,
  destructuring, `in`, or passing the global object on.
- **Why:** the compiler links a host installer, such as `process`, `Buffer` or the
  timers, only for the globals a program reads by name. Such a use keeps every
  installer in the image.
- **Instead,** read each global by name. Type assertions are erased first, so
  `(globalThis as Globals).count` is a named read.
- **Fine when** the code runs under Node or in a browser, not in a Maligator build.

### `maligator/no-function-source`

- **Reports** `Function.prototype.toString`, and converting a function or class this
  file defines to a string: `fn.toString()`, `String(fn)`, a template literal, or `+`
  with a string. A parameter or an import may hold anything, so the rule skips those.
- **Why:** Maligator keeps no source text, so every function, user code included,
  converts to `function name() { [native code] }`. Code that parses parameter names
  or tells classes from functions by their source silently takes another path.
- **Instead,** pass that information explicitly, such as a list of dependency names
  next to the function.
- **Fine when** the string only reaches a `console` call; the rule does not report
  that.

### `maligator/no-primordial-mutation`

- **Reports** an assignment, update or `delete` on a built-in global or a path from it,
  such as `Math.clamp = clamp`, and the same change through `Object.defineProperty`,
  `Object.assign`, `Reflect.set` and similar calls. It reports what the build's
  locked-primordial warning reports, which allows Node's `Error.prepareStackTrace` and
  `Error.stackTraceLimit` hooks.
- **Why:** the default build locks built-ins, so these writes throw a `TypeError` at
  runtime, while the build only warns. Oxlint's `no-extend-native` covers
  `X.prototype` writes only.
- **Instead,** export your own function from a module, or wrap the built-in in one.
- **Fine when** the build sets `engine.primordials: "mutable"` to patch built-ins on
  purpose.

### `maligator/strict-commonjs`

- **Reports** a CommonJS file that does not start with `"use strict"`: a `.cjs` or
  `.cts` file, or a file without `import` or `export` that reads `require`, `module`
  or `exports`.
- **Why:** one sloppy file costs the whole program. Its functions can reach the global
  object through `this`, so the build keeps every installer that object could reach,
  including the complete `process` implementation, and stops trimming unused
  built-ins.
- **Instead,** add `"use strict"` at the top, which the rule suggests, or write an ES
  module.
- **Fine when** the file relies on sloppy-mode behavior, such as `with` or writes that
  fail silently.

## Opt-in rules

These rules are not in the preset: their pattern is often fine, and they report it
more often than a default rule should.

### `maligator/prefer-map`

- **Reports** an object created as `{}` or `Object.create(null)` that is both written
  and read, or tested with `in`, through keys computed at runtime.
- **Why:** each new key gives the object a new shape, and the heap keeps every shape it
  has created, with its key, until the program exits. When the keys come from data,
  such as words, ids or URLs, the heap grows with the data.
- **Instead,** use a `Map` or `Set`, and convert with `Object.fromEntries` where the
  result must be a plain object.
- **Fine when** the keys come from a fixed set in the code, such as option names or
  statistics categories.

### `oxc/no-accumulating-spread`

An Oxlint rule; enable it in your own configuration.

- **Reports** spreading an accumulator into a new object or array on every step of a
  `reduce` or loop, such as `({ ...acc, [x.id]: x })`.
- **Why:** each step copies everything accumulated so far and creates a new object, so
  the work grows with the square of the input, and each copy gets a new shape.
- **Instead,** mutate one accumulator created before the loop, or use a `Map`.
- **Fine when** the loop updates a record with a fixed set of keys, which copies a
  bounded number of keys per step.

## Writing rules

Write rules with `createOnce`, which Oxlint calls once per run instead of once per
file. Keep per-file state in a `before` hook.

## Examples and tests

Every rule has bad and good examples in `tests/examples/<rule>/`, as complete programs
named `<case>.bad.<ext>` and `<case>.good.<ext>`. They document the rule and serve as
test fixtures:

- `tests/examples.test.ts` lints the examples through the Oxlint CLI and expects
  every bad example, and no good one, to be reported.
- `tests/native/examples.test.ts` compiles each pair with the default closed-world
  build and checks that the good form behaves like Node and the bad form pays the
  rule's cost: readers that miss their shape cache, shapes that grow with the data,
  installers the program never reads, an error the default build raises, or output
  that differs from Node. When a compiler change removes that cost, this test fails,
  and the rule should be narrowed or removed.
- `tests/<rule>.test.ts` covers what the rule reports and skips, through Oxlint's
  `RuleTester`.

```sh
npm run test:unit -- packages/lint-rules/tests
npm run test:native -- packages/lint-rules/tests/native
```

A native test that reads `MAL_PERF_STATS` counters belongs in
`tests/test-suite-native-perf.txt`, so the stats runtime is built before the test.
