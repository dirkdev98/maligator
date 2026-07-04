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

## Local verification

```
# Run the compiler on a tmp local file exercising the new feature
MAL_DEBUG=true node ./src/index.ts ./tests/local/tmp2.js
# Take the output and replace the current definitions in `test.c` and run it.
```

Use https://tc39.es/ecma262/multipage/ when looking up parts of the spec.

## Working Preferences

- Pre-1.0: freely change any API/internal contract when it improves the design or contracts (engine/host/runtime layering: see `isolate_todo.md`).

- Prefer root-cause, correct, performant fixes over narrow test-specific workarounds.
- Ask for explicit approval before running full or otherwise expensive Test262 suites.
- Use targeted single-test or small-batch verification during development.
- Never use git worktrees.
- When asked to commit, create unsigned local commits and do not push unless explicitly asked.
- Work through clusters in phased semantic slices rather than stopping after the first passing case.
