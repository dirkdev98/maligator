# Agent Guidelines

## Commands

- `npm run type-check` - TypeScript type checking
- `npm run lint` - ESLint with auto-fix
- `npm run lint:ci` - ESLint without auto-fix (CI)
- `npm test` - Run all tests with Vitest
- `npm test run` - Run all tests once with Vitest
- `npm test -- <filename>` - Run single test file (e.g., `npm test -- data-types.test.ts`)

## Code Style

- Use TypeScript with strict mode enabled, using erasable syntax only. This allows us to
  directly execute TS files with Node.js. E.g `node ./src/index.ts`.
- Import extensions: `.ts` for TypeScript files
- Use `@lightbase/eslint-config` for linting rules
- Vitest for testing
- Use assertion and type-guard methods that aid with TS inference.
- Follow ECMAScript spec references in comments.

## Testing

- Test files: `<filename>.test.ts` alongside source files
- Don't nest inside `describe`-blocks
- Don't use test hooks like `beforeAll` and `afterEach`
- Let a test case only test a single behavior
- Use grammatically correct test names to describe the case
- Make sure that the order of tests as they appear in the file follows the order of the
  code that they test
- Use `test.for()` for parameterized tests where it makes sense, but don't overuse them.
  All `test.for()` tests MUST use placeholders in their test names. Use named placeholders
  (e.g., `$input`, `$value`, `$expected`) for object-based parameters, or printf-style
  formatting (e.g., `%s`, `%o`, `%d`) for simple array parameters. The test name must be
  descriptive with the parameters included (e.g.,
  `number multiply case: $x * $y = $expected`)
- Test both positive and negative cases systematically. For each function, test expected
  successful behavior alongside error conditions and type mismatches (e.g., test both
  `assertIsUndefined passes for undefined value` and
  `assertIsUndefined throws for $type values`)
- Emulate scenario's via `node -pe` to check what the expected result would be when in
  doubt. For example `node -pe "7 & 8"`

## Policy

- You are allowed be used to help with writing tests.
- You should NOT be used to implement features A-Z. Do not even try to.
- You may be used to as a Stackoverflow kinda resource, but smarter.
- You may be used as a code review tool.
- You may be used to assist with tedious and repetitive refactoring.

Use https://tc39.es/ecma262/multipage/ when looking up parts of the spec.
