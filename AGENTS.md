# Agent Guidelines

## Commands

- `npm run type-check` - TypeScript type checking
- `npm run lint` - ESLint with auto-fix
- `npm run lint:ci` - ESLint without auto-fix (CI)
- `npm test` - Run all tests with Vitest (unit + native projects)
- `npm test run` - Run all tests once with Vitest
- `npm run test:unit` - Fast lane: pure-TS compiler tests only (no C build; the watch loop)
- `npm run test:native` - Native lane: build each fixture into an isolate binary/server and drive it
- `npm test -- <filename>` - Run a single test file
- `npm run test:leak` - macOS-only GC leak audit (`leaks`), off by default
- `npm run test262` - Full test262 suite (expensive; ask before running)
- `npm run test262:regressions` - Curated common-case regression manifest vs the committed baseline (also runs inside the native lane)
- `npm run bench` - Consolidated benchmark tracker (size / language-vs-V8 / gc / http); `--update` records a baseline entry

### Manual milestone scripts (not part of `npm test`)

- `node scripts/eval-phase2-check.ts` - wire-format loader differential
- `node scripts/eval-selfhost-check.ts` - self-hosted compiler differential (slow: AOT-compiles the whole compiler)
- `node scripts/eval-strip-check.ts` - ts-blank-space strip + source-position fidelity

### Test / runtime flags

- Build-time (own build dir): `MAL_ASAN`, `MAL_UBSAN`, `MAL_GC_GENERATIONAL`, `MAL_GMALLOC`.
- Runtime GC instruments (same binary): `MAL_GC_STRESS`, `MAL_GC_VERIFY`, `MAL_GC_OFF`, `MAL_GC_THRESHOLD`, `MAL_GC_MAJOR_EVERY`, `MAL_GC_STATS`, `MAL_HOST_GC`, `MAL_GC_AT_EXIT`.
- Backend: `MAL_INTERP=1` forces the bytecode interpreter (test262 runner); the native harness takes a `compiled` flag directly.
- test262 runner: `--filter`, `--manifest <file>`, `--variant strict|sloppy`, `--check`, `--random`. Full runs use the fixed throughput settings in `src/test262/constants.ts` and run interpreted preflight before compiled mode.

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
- Ask for explicit approval before running the full Test262 suite.
- Use targeted single-test or small-batch verification during development.
- Never use git worktrees.
- When asked to commit, create unsigned local commits and do not push unless explicitly asked.
- Work through clusters in phased semantic slices rather than stopping after the first passing case.
