# Working on Maligator

Maligator is an ahead-of-time JavaScript compiler and native runtime. Use current
source, command help, and test manifests to establish behavior. Saved memories,
design documents, and old reports provide context, not proof about the current tree.
[TODO.md](TODO.md) owns unfinished project work; [docs/testing.md](docs/testing.md)
owns detailed test selection, runner flags, and evidence formats.

## Scope and authority

- Distinguish investigation from implementation. During design, explain trade-offs
  and a recommendation in prose; ask structured questions only for concrete decisions.
- Complete the requested semantic slice, including relevant verification. Report
  separate discoveries with evidence rather than expanding into unrelated work.
- Inspect the working tree first and preserve unrelated edits. Work in the assigned
  checkout; creating, removing, pruning, relocating, or switching worktrees requires
  an explicit request.
- Commit only when requested, using unsigned local commits. Push, publish, deploy,
  and remote execution require explicit authorization. Existing authorization for
  the same action and scope persists; do not ask for it again.
- For an authorized push, check the ignored `AGENTS.local.md` for host-specific
  authentication. Never print or persist credentials.

## Implementation

- Fix defects at the owning layer. Do not hide them with fixture-specific branches,
  disabled checks, unconditional cache clearing, or retry loops.
- JavaScript semantics and compiler invariants take priority over passing one case.
  Trace the actual fact, effect, control-flow, and representation contracts before
  changing an optimization. Use the [ECMAScript specification](https://tc39.es/ecma262/multipage/)
  for language semantics.
- Internal compatibility is unnecessary before 1.0. Migrate callers together and
  invalidate affected cache/schema identities instead of adding legacy readers,
  adapters, or parallel representations. Public API changes are allowed when they
  improve the design; update their documentation and consumers.
- Use strict TypeScript with erasable syntax and `.ts` import extensions. Prefer
  assertions and type guards that preserve type inference. Follow the configured
  ESLint and formatting rules.
- Test observable behavior and real integration. Structural assertions belong to
  explicit compiler, verifier, wire-format, or ABI contracts; avoid tautologies and
  tests that freeze incidental instruction order, register numbers, or generated text.

## Comments

- Explain an invariant, constraint, non-obvious choice, or deliberate hazard. Do not
  narrate the code or the edit. One line is the default; length follows the surprise.
- Refactor confusing code you are changing. Remove stale and redundant comments in
  the edited region; no banner comments or blanket JSDoc.
- Document exports where names and types do not express the contract, especially at
  shared-library boundaries. Test intent belongs in test names and named helpers.
- Keep comments self-contained. TODOs need no ticket; link an upstream issue when it
  explains a workaround that can later be removed.

## Environment and coordination

Establish the session's execution environment with `npm run env:check -- --json`
before builds, tests, or benchmarks. It needs permission to write the workspace,
temporary directory, Maligator user cache, npm cache, and
Cargo cache, and to bind loopback `listen(0)`. Read-only inspection does not need
those capabilities. Download/network access and Git writes are separate permissions.
Unit and quality wrappers also attempt to write cache leases; do not assume that a
TypeScript-only command needs no user-cache access.

If the probe confirms an `EPERM` or `EACCES` capability failure, correct the sandbox
and rerun the exact command before diagnosing product code. Before heavy work,
inspect CPU activity and `node ./src/index.ts cache status`. Defer conflicting builds,
tests, and benchmarks; never kill another task or introduce a global performance lock.

## Verification

Use bounded, one-shot commands while developing. `npm test` and `npm run test:unit`
can enter watch mode; use that only when requested.

| Purpose                                    | Command                                       |
| ------------------------------------------ | --------------------------------------------- |
| Inspect the normal gate without running it | `npm run test:check -- --plan=json`           |
| Focused unit tests                         | `npm run test:unit -- --run <file>`           |
| Focused slow unit/integration test         | `npm run test:unit:full-only -- --run <file>` |
| Focused native behavior                    | `npm run test:native -- <file>`               |
| Native memory/UB checks                    | `npm run test:sanitize -- <file>`             |
| Type checking                              | `npm run type-check`                          |
| Lint and formatting without source edits   | `npm run lint:ci`                             |
| Normal developer gate                      | `npm run test:check`                          |

`test:check` includes smoke and the selected native, sanitizer, and standards lanes.
It does not cover every native fixture or the full standards corpus. Use focused
tests during implementation, then run it after code changes; repeat only when later
changes, failures, or unresolved concerns justify it. For documentation-only cleanup,
check formatting, links, and command accuracy without rebuilding the runtime.
Use `npm run test:help`, tier `--list`/`--plan=json`, and the manifests for exact coverage
and time budgets; durations depend on the host and cache state.

Follow [test placement](docs/testing.md#test-placement) when adding tests. Ask if the
acceptance boundary could reasonably belong in multiple lanes. Slow unit/subprocess
tests belong in `tests/test-suite-unit-full-only.txt`. For Core changes, use the
[focused optimizer workflow](docs/testing.md#focused-optimizer-verification).
`MAL_DEBUG=true node ./src/index.ts build <fixture>` enables per-pass Core diagnostics.
Reproduce Test262 cases through its runner so harness includes and variants are honored.

## Standards and baselines

Full Test262, `test:full`, and `test:full:report` require explicit authorization;
filtered tests and small manifests remain normal development tools. Keep self-hosted
checks early in the full gate. Use explicit `--backend` and `--mode` flags: canonical
runners remove ambient runtime overrides such as `MAL_INTERP`.

`npm run test262` and `npm run test262:report` check against the resolved HEAD baseline
without rewriting it. `--baseline <file>` selects an explicit comparison input.
Inspect completeness and exact `PASSED -> FAILED` transitions, not just totals.
Replacing `scripts/test262.json` requires an authorized
`npm run test262:update-baseline`; updating `bench/baseline.json` requires an authorized
benchmark `--update`. Neither baseline update is implied by running a check.

## Performance and evidence

The benchmark families are `javascript`, `http`, and `self-compile`; default runs
select the first two and `--full` selects all three. Keep Node-hosted compiler DX
measurements (`npm run bench:dx -- --source`) distinct from AOT self-compile measurements.

Use matched workloads, output parity/checksums, source/toolchain identity, and repeated
interleaved pairs for performance conclusions. Inspect `--plan=json` before a costly
comparison: even `--runs 1` includes warmup and can include cold and diagnostic work.
For comparisons, use `--compare <ref> --budget-seconds <seconds>` and retain the printed
run directory. Exit 2 means failed or incomplete; exit 1 flags a classified regression.
A single pair or a zero exit code does not establish stable performance acceptance.
Resume only with matching source/options/host, after a fresh environment check.

Report what was exercised, failed, and left unverified. Retain the evidence needed
to review the current change; historical timings and old passes are not current
validation. Copy a gate report into the current run directory when needed because
`report-<tier>.json` is overwritten.

## Artifact hygiene

- Keep generated profiles, benchmark outputs, logs, captures, and scratch scripts
  out of tracked directories. Use one task-scoped directory under `.cache/` for
  evidence that must survive the command; use an OS temporary directory with
  cleanup in `finally` for disposable intermediates.
- Tool defaults must write reports under `.cache/`, create their output directories,
  and print the resulting paths. Read comparison inputs explicitly; never silently
  adopt an old experiment output as a baseline. Baseline replacement remains an
  explicit action.
- Do not commit experiment journals, rejected-candidate reports, slice snapshots,
  or one-off profiling scripts. Keep reusable tools in `scripts/`, regression
  coverage in `tests/`, unfinished work in `TODO.md`, and lasting design decisions
  in `docs/decisions/`. Remove scratch helpers when their investigation ends.
- Before finishing a task, remove its disposable builds and superseded outputs.
  Retain only evidence supporting the result or an unresolved failure, and report
  its location. An ignored `.cache/` directory is not a permanent archive; never
  force-add its contents. Do not delete another task's artifacts.

## Cleanup and delegation

Audit ownership and activity before deleting artifacts. Remove only explicitly
identified inactive scratch or superseded generated data; preserve source, baselines,
useful failure evidence, and unrelated drafts. Use `cache prune --dry-run` before
supported cache pruning, and respect live leases. The default target is 15 GiB;
family minimums and recent-entry protection can leave more than that. This command
manages the user cache, not repository `.cache/` reports. Never reuse an old deletion
list.

Delegate only when requested. Use the requested available external harness, give each
assignment a complete scope and a 30-minute wall-clock limit, and capture its output.
Run independent assignments in parallel only with non-overlapping edits. Treat a
timeout as incomplete; inspect outputs and processes, review edits, and verify them
before acceptance. Do not inherit old model pins or unrestricted-permission recipes
from saved task history.
