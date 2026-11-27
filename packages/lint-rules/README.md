# Maligator lint rules

An [Oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) plugin with rules
for code that Maligator compiles well. Each rule targets a cost the compiler cannot
remove on its own, because removing it would change what the program observes. The
rules are syntax and scope checks; they do not run the compiler.

Extend the recommended preset in `.oxlintrc.json`:

```json
{
	"extends": ["./packages/lint-rules/recommended.json"]
}
```

The preset enables the plugin's rules and these Oxlint rules:

- `no-eval`, `no-new-func` and `no-extend-native`. The default closed-world build
  rejects what they report: runtime eval throws, and built-in objects are locked. The
  open-world build that allows them gives up the optimizations that rely on locked
  built-ins and known source.
- `prefer-rest-params`. Any use of `arguments` beyond its length, a constant index or
  forwarding it allocates the object on every call and keeps the function from being
  inlined.
- `unicorn/prefer-global-this`. A free `global` links the complete `process`
  implementation, and `self` and `window` keep unused built-ins in the image.

## Rules

The shape rules reason about records: locals created from an object literal without a
spread. They skip dynamic keys and objects typed as a `Record` or with an index
signature, since those are dictionaries, and objects they cannot see created.

### `maligator/monomorphic-objects`

Reports a key that is added to a record on some paths only, in a branch, loop,
`catch` or callback. Records from that literal then get a different shape per path,
so every property site that reads them goes through a multi-shape cache path, and the
compiler can no longer replace the object with its fields. Initialize the key in the
literal, as `undefined` if it has no value yet. The rule suggests that edit.

### `maligator/no-delete-property`

Reports `delete` of a key that other keys of a record follow. The runtime rebuilds the
object's shape without the key and moves the later keys to lower slots, so code that
reads them meets two layouts. Deleting the last key leaves the other slots in place,
and the compiler handles that case. Assign `undefined` instead, which the rule
suggests.

Note that both suggestions change behavior where code tells an absent key from an
`undefined` one, through `in`, `Object.keys` or spreading the object over defaults.
Disable the rule on that line and say why.

### `maligator/no-dynamic-global-access`

Reports a use of `globalThis` or `global` other than a member access with a fixed key,
`typeof`, or an `===`/`!==` comparison: a computed key, an alias, destructuring, `in`,
or passing the global object on. The compiler links a host installer, such as
`process`, `Buffer` or the timers, only for the globals a program reads by name; such
a use keeps every installer in the image. Type assertions are erased first, so
`(globalThis as Globals).count` is a named read.

## Writing rules

Write rules with `createOnce`, which Oxlint calls once per run instead of once per
file. Keep per-file state in a `before` hook.

## Examples and tests

Every rule has bad and good examples in `tests/examples/<rule>/`, as complete programs
named `<case>.bad.js` and `<case>.good.js`. They document the rule and serve as test
fixtures:

- `tests/examples.test.ts` lints the examples through the Oxlint CLI and expects
  every bad example, and no good one, to be reported.
- `tests/native/examples.test.ts` compiles each pair with the default closed-world
  build and checks that the bad form pays the rule's cost and the good form does not:
  readers that miss their shape cache, or host installers the program never reads.
  When a compiler change removes that cost, this test fails, and the rule should be
  narrowed or removed.
- `tests/<rule>.test.ts` covers what the rule reports and skips, through Oxlint's
  `RuleTester`.

```sh
npm run test:unit -- packages/lint-rules/tests
npm run test:native -- packages/lint-rules/tests/native
```

A native test that reads `MAL_PERF_STATS` counters belongs in
`tests/test-suite-native-perf.txt`, so the stats runtime is built before the test.
