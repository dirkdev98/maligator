# Agent Guidelines

## Commands

- `npm run test:smoke` - Optional 20-second warm / 60-second cold fuse; runs first inside larger gates
- `npm run test:check` - Default approximately two-minute developer gate; excludes slow toolchain integration
- `npm run test:full` - Exhaustive fail-fast gate; includes full Test262, so ask before running
- `npm run test:full:report` - Exhaustive completion policy; ask before running
- `npm run test:help` - Show tier policy; add `-- --list` to a tier command to print exact stages
- `npm run type-check` - TypeScript type checking
- `npm run lint` - ESLint with auto-fix
- `npm run lint:ci` - ESLint without auto-fix (CI)
- `npm test` - Vitest watch mode across unit and native projects, not every repository test lane
- `npm test run` - Run both Vitest projects once, not standards/self-host/sanitizer lanes
- `npm run test:unit` - Fast lane: pure-TS compiler tests only (no C build; the watch loop)
- `npm run test:native` - Native lane: build each fixture into an isolate binary/server and drive it
- `npm run test:rust` - Full-only Rust runtime unit lane, including `node-zlib`
- `npm run test:sanitize -- <filename>` - Platform-safe native sanitizer lane (UBSan on macOS, ASan+UBSan elsewhere)
- `npm test -- <filename>` - Run a single test file
- `npm run test:leak` - macOS-only GC leak audit (`leaks`), off by default
- `npm run test262` - Full test262 suite (expensive; ask before running)
- `npm run test262:regressions` - Curated common-case regression manifest vs the committed baseline
- `npm run test262:report` - Complete compiled/normal Test262 report without updating the baseline (full corpus; ask before running)
- `npm run test:wpt:report` - Complete compiled/normal curated WPT report
- `npm run test:wpt:matrix-report` - Complete compiled/interpreted normal/GC-stress WPT report
- `npm run bench` - Consolidated benchmark runner (size / language-vs-V8 / gc / http); `--update` merges selected lanes into the saved snapshot

### Manual milestone scripts (not part of `npm test`)

- `node scripts/eval-phase2-check.ts` - wire-format loader differential
- `node scripts/eval-selfhost-check.ts` - self-hosted compiler differential (slow: AOT-compiles the whole compiler)
- `node scripts/eval-strip-check.ts` - ts-blank-space strip + source-position fidelity

### Test / runtime flags

- Build-time (own build dir): `MAL_ASAN`, `MAL_UBSAN`, `MAL_GC_GENERATIONAL`, `MAL_GC_CONCURRENT`, `MAL_PERF_STATS` (set again at runtime to enable and print the compiled counters).
- Runtime GC/performance instruments (same binary): `MAL_GC_STRESS`, `MAL_GC_VERIFY`, `MAL_GC_OFF`, `MAL_GC_THRESHOLD`, `MAL_GC_MAJOR_EVERY`, `MAL_GC_STATS`, `MAL_HOST_GC`, `MAL_GC_AT_EXIT`, `MAL_GMALLOC`.
- Backend: `MAL_INTERP=1` forces the bytecode interpreter (test262 runner); the native harness takes a `compiled` flag directly.
- Test262 runner: `--filter`, `--manifest <file>`, `--exclude-manifest <file>`, `--variant strict|sloppy`, `--backend compiled|interpreted`, `--mode normal|gc-stress`, `--check`, `--policy bail|complete`, `--canonical`, `--random`.
- WPT runner: repeatable `--test`, `--mode normal|gc-stress`, `--backend compiled|interpreted`, `--policy bail|complete`, and `--canonical`.

## Code Style

- Use TypeScript with strict mode enabled, using erasable syntax only. This allows us to
  directly execute TS files with Node.js. E.g `node ./src/index.ts build entry.ts`.
- Import extensions: `.ts` for TypeScript files
- Use `@lightbase/eslint-config` for linting rules
- Vitest for testing
- Use assertion and type-guard methods that aid with TS inference.
- Follow ECMAScript spec references in comments.

## Local verification

```
# Build an existing focused fixture through the product CLI.
MAL_DEBUG=true node ./src/index.ts build ./tests/local/runtime-mechanics.mjs
```

Use https://tc39.es/ecma262/multipage/ when looking up parts of the spec.

## Importing fix queues

For a fix queue maintained in a separate clone:

- Treat the source clone as read-only; fetch its branch into the primary clone with `git fetch <source-clone> <branch>`.
- Require the primary `main` to have no remote-only commits before starting.
- Track the last imported source hash and select later non-merge commits in first-parent order because cherry-picked hashes differ from source hashes.
- Cherry-pick the explicit source hashes in order, compare the result with `git diff --exit-code <last-source-hash> HEAD`, and scan for stale source-hash references.
- Run focused tests and `npm run test:check` before pushing.

## Working Preferences

- Pre-1.0: freely change any API/internal contract when it improves the design or contracts (engine/host/runtime layering: see `docs/roadmaps/isolate-reactor.md`).

- Prefer root-cause, correct, performant fixes over narrow test-specific workarounds.
- Treat `npm run test:check` as the normal local gate. Put unusually slow unit or subprocess integration tests in `tests/test-suite-unit-full-only.txt`; `tests/toolchain.test.ts` is the current example.
- Keep self-hosted checks early in `test:full`, before broad native and standards matrices.
- Ask for explicit approval before running the full Test262 suite, `test:full`, or `test:full:report`.
- Use targeted single-test or small-batch verification during development.
- Follow `docs/testing.md` when placing tests. If a regression could reasonably belong in more than one lane, ask the user rather than guessing.
- Never use git worktrees.
- When asked to commit, create unsigned local commits and do not push unless explicitly asked.
- When a push is explicitly authorized, host-specific authentication instructions may
  be available in the ignored `AGENTS.local.md`. Never print or persist the GitHub
  token, and do not weaken the explicit-push requirement when using that fallback.
- Work through clusters in phased semantic slices rather than stopping after the first passing case.

## External Subagents

- When the user asks for subagents, use the available external harness, either `opencode run` or `claude -p`, and give each invocation a 30-minute wall-clock limit.
- On macOS, enforce the limit with Perl's alarm wrapper:
  - `perl -e 'alarm shift; exec @ARGV' 1800 opencode run "<prompt>" --auto --session "<session-id>"`
  - `perl -e 'alarm shift; exec @ARGV' 1800 claude -p "<prompt>"`
- The installed OpenCode CLI accepts the prompt as a positional argument; do not use the unsupported `opencode run --prompt` form.
- Give each subagent a complete, self-contained prompt with its scope, whether it may edit files, expected verification, and the exact result it should report.
- Run independent subagents in parallel. Reuse an OpenCode session ID when continuing the same assignment rather than starting over.
- Treat timeout exit status as an incomplete run, inspect the worktree and captured output, and either resume the session or finish the remaining work directly.
- Read the complete captured output when terminal output is truncated, then review all subagent edits and run the relevant verification before considering the assignment complete.
