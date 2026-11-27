# Maligator lint rules

An [Oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) plugin with rules
for code that Maligator compiles well. Each rule targets a cost the compiler cannot
remove on its own, because removing it would change what the program observes. The
rules are syntax and scope checks; they do not run the compiler.

Enable the plugin and its rules in `.oxlintrc.json`:

```json
{
	"jsPlugins": ["./packages/lint-rules/src/index.ts"],
	"rules": {
		"maligator/monomorphic-objects": "error"
	}
}
```

## Rules

### `maligator/monomorphic-objects`

Reports a key that is added to an object literal's object on some paths only, in a
branch, loop, `catch` or callback. Objects from that literal then get a different
shape per path, so every property site that reads them goes through a multi-shape
cache path, and the compiler can no longer replace the object with its fields.
Initialize the key in the literal, as `undefined` if it has no value yet. The rule
suggests that edit.

The rule skips dynamic keys, literals with a spread, and objects typed as a `Record`
or with an index signature, since those are dictionaries.

Note that the suggestion changes behavior where code tells an absent key from an
`undefined` one, through `in`, `Object.keys` or spreading the object over defaults.
Disable the rule on that line and say why.

## Examples and tests

Every rule has bad and good examples in `tests/examples/<rule>/`, as complete programs
named `<case>.bad.js` and `<case>.good.js`. They document the rule and serve as test
fixtures:

- `tests/examples.test.ts` lints the examples through the Oxlint CLI and expects
  every bad example, and no good one, to be reported.
- `tests/native/<rule>.test.ts` compiles each pair with Maligator and checks that the
  bad form takes the costly runtime path and the good form avoids it. When a compiler
  change removes that cost, this test fails, and the rule should be narrowed or
  removed.
- `tests/<rule>.test.ts` covers what the rule reports and skips, through Oxlint's
  `RuleTester`.

```sh
npm run test:unit -- packages/lint-rules/tests
npm run test:native -- packages/lint-rules/tests/native
```

A native test that reads `MAL_PERF_STATS` counters belongs in
`tests/test-suite-native-perf.txt`, so the stats runtime is built before the test.
