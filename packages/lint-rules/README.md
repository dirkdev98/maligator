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

The preset enables the plugin's rules and three Oxlint rules: `no-eval`,
`no-new-func` and `no-extend-native`. The default closed-world build rejects what they
report: runtime eval throws, and built-in objects are locked. The open-world build that
allows them gives up the optimizations that rely on locked built-ins and known source.

## Rules

The rules reason about records: locals created from an object literal without a
spread, and class instances. They skip dynamic keys and objects typed as a `Record` or
with an index signature, since those are dictionaries, and objects they cannot see
created.

### `maligator/monomorphic-objects`

Reports a key that is added to a record on some paths only, in a branch, loop,
`catch` or callback. Records from that literal then get a different shape per path,
so every property site that reads them goes through a multi-shape cache path, and the
compiler can no longer replace the object with its fields. Initialize the key in the
literal, as `undefined` if it has no value yet. The rule suggests that edit.

### `maligator/no-delete-property`

Reports `delete` of a fixed key from a record or from `this` in a class. The runtime
rebuilds the object's shape without the key, and after enough such shapes it turns
the object into a dictionary. Assign `undefined` instead, which the rule suggests, or
leave the key out when the object is created.

Note that both suggestions change behavior where code tells an absent key from an
`undefined` one, through `in`, `Object.keys` or spreading the object over defaults.
Disable the rule on that line and say why.

## Writing rules

Write rules with `createOnce`, which Oxlint calls once per run instead of once per
file. Keep per-file state in a `before` hook.

## Examples and tests

Every rule has bad and good examples in `tests/examples/<rule>/`, as complete programs
named `<case>.bad.js` and `<case>.good.js`. They document the rule and serve as test
fixtures:

- `tests/examples.test.ts` lints the examples through the Oxlint CLI and expects
  every bad example, and no good one, to be reported.
- `tests/native/examples.test.ts` compiles each pair with Maligator and checks that
  readers of the bad form miss their shape cache and readers of the good form do not.
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
