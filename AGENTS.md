# Agent Guidelines

## Commands

- `npm run type-check` - TypeScript type checking
- `npm run lint` - ESLint with auto-fix
- `npm run lint:ci` - ESLint without auto-fix (CI)
- `npm test` - Run all tests with Vitest
- `npm test -- <filename>` - Run single test file (e.g., `npm test -- data-types.test.ts`)

## Code Style

- Use TypeScript with strict mode enabled, using erasable syntax only. This allows us to
  directly execute TS files with node. E.g `node ./src/index.ts`.
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

## Agents

AI / LLM Agents may be used to assist with test writing and review tasks. Be extremely
concise in your responses. Sacrifice grammar for the sake of concision.

Use https://tc39.es/ecma262/multipage/ when looking up parts of the spec.

### Code Modification Policy:

- **FORBIDDEN**: Agents must NEVER modify the source implementation (code in \*.ts files
  that are not \*.test.ts)
- **ALLOWED**: Agents may ONLY modify test files (\*.test.ts), or add TODO-comments to
  source files (\*.ts)
- **REQUIRED**: When agents identify issues or improvements in source code, they MUST
  document them as TODO comments in the relevant source files (\*.ts). When agents
  identify new patterns, they must add them to AGENTS.md. When agents identify improved
  architectural choices, they must add them to TODO.md

### Suggestion Format:

When suggesting improvements, agents should:

1. Describe the issue clearly, while keeping it brief
2. Propose a specific solution
3. Include references to files and symbols
4. Reference relevant ECMAScript specifications when applicable
5. Mark suggestions with timestamp and agent identifier

### Workflow:

1. Analyze code and identify potential improvements
2. If the improvement is test-related, implement it directly in test files
3. If the improvement is implementation-related, determine if it is an architectural
   improvement or code improvement / bug fix. Architectural improvements should be added
   as a suggestion to TODO.md, code improvements and bug fixes should be added as a
   TODO-comment in the source code. Don't skip the tests because a bug exist. Keep the
   failing test if you are sure that the test is expecting the right behavior.
4. Suggest updating these instructions when new patterns emerge
