# Working on Maligator

Maligator is an ahead-of-time JavaScript compiler and native runtime. Use current
source, command help, and test manifests to establish behavior. Saved memories,
design documents, and old reports provide context, not proof about the current tree.
[TODO.md](TODO.md) owns unfinished project work. Read topic references when needed:
[contributing](CONTRIBUTING.md) for setup and the repository layout,
[testing](docs/testing.md) for runner details and evidence,
[benchmarking](docs/benchmarking.md) for performance,
[native builds](docs/native-builds.md) for toolchain and cache internals,
[releasing](docs/releasing.md) for the release runbook, and
[website](website/README.md) for documentation generation and previews.

## Scope and authority

- Distinguish investigation from implementation. During design, explain trade-offs
  and a recommendation in prose; ask structured questions only for concrete decisions.
- Complete the requested semantic slice, including relevant verification. Report
  separate discoveries with evidence rather than expanding into unrelated work.
- Inspect the working tree first and preserve unrelated edits. Work in the assigned
  checkout; creating, relocating, or switching worktrees requires an explicit request.
  Remove a worktree you created once its branch is merged.
- Commit and push only when requested, unless the ignored `AGENTS.local.md` sets
  otherwise. Commits are unsigned. Publish, deploy, and other remote execution always
  require explicit authorization. Existing authorization for the same action and scope
  persists; do not ask for it again.
- For an authorized push, check the ignored `AGENTS.local.md` for host-specific
  authentication. Never print or persist credentials.

## Implementation

- Fix defects at the owning layer. Do not hide them with fixture-specific branches,
  disabled checks, unconditional cache clearing, or retry loops.
- Understand and optimize the whole picture instead of trying to micro-change /
  micro-optimize your way out of things.
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
  narrate the code or the edit. Length follows the surprise.
- Refactor confusing code you are changing. Remove stale and redundant comments in
  the edited region; no banner comments or blanket JSDoc.
- Document exports where names and types do not express the contract, especially at
  shared-library boundaries. Test intent belongs in test names and named helpers.
- Keep comments self-contained. TODOs need no ticket; link an upstream issue when it
  explains a workaround that can later be removed.

## Environment and coordination

Run `npm run env:check -- --json` before builds, tests, or benchmarks. It probes
workspace, temporary, Maligator/npm/Cargo cache writes and loopback `listen(0)`;
unit and quality wrappers also need cache leases. Read-only inspection needs none
of these capabilities. Network access and Git writes are separate permissions.

If the probe confirms an `EPERM` or `EACCES` capability failure, correct the sandbox
and rerun the exact command before diagnosing product code. Before heavy work,
inspect CPU activity and `node ./src/index.ts cache status`. Defer conflicting builds,
tests, and benchmarks; never kill another session's task or introduce a global
performance lock. A process from before today that no running session owns is stale,
and stopping it is fine.

## Verification

Keep local verification light; CI runs the heavy checks. While developing, run the
affected unit files and the native or sanitizer fixture that observes the change,
then type-check and lint once after cohesive work. Do not run the whole unit suite,
the canonical gate, full native or sanitizer sweeps, captures, or long benchmarks
locally for extra confidence; push, or ask to, and let CI run them. Use bounded,
one-shot commands: `npm test` and `npm run test:unit` run once by default, so pass
`-- --watch` only when requested.

| Purpose                                    | Command                                 |
| ------------------------------------------ | --------------------------------------- |
| Inspect the normal gate without running it | `npm run test:check -- --plan=json`     |
| Focused unit tests                         | `npm run test:unit -- <file>`           |
| Focused slow unit/integration test         | `npm run test:unit:full-only -- <file>` |
| Focused native behavior                    | `npm run test:native -- <file>`         |
| Native memory/UB checks                    | `npm run test:sanitize -- <file>`       |
| Type checking                              | `npm run type-check`                    |
| Lint and formatting without source edits   | `npm run lint:ci`                       |

Documentation-only changes need formatting, links, and command checks; website
changes also need relevant generation, routes, and behavior. Do not rebuild the
runtime for prose edits.

CI owns acceptance. Every pull request and push runs the canonical check gate; every
push to `main` also runs the native remainder, Extended CI (self-hosted checks, Wasm,
slow unit tests, the primordial inventory) and, once CI passes, the full Test262
corpus. Continue independent work while checks run. Acceptance stays pending until
the required coverage succeeds, and a red run gets fixed before more work lands on
top of it. Without push authority, report what ran locally and what remains for CI
instead of substituting a local gate. Check is a curated gate, not every native
fixture or the full standards corpus; use `test:help`, tier `--list`/`--plan=json`,
the manifests and [CI coverage](docs/testing.md#github-actions) for exact coverage.

Captures run on CI too. The Primordial catalog workflow commits a refreshed catalog
after a push to `main` changes the descriptor graph. Dispatch it with `force` when
authorized to for a change only the macOS runtime installs; see the
[inventory workflow](docs/decisions/static-value-foundations.md#native-inventory-and-coverage).

Follow [test placement](docs/testing.md#test-placement) when adding tests. Ask if the
acceptance boundary could reasonably belong in multiple lanes. Slow unit/subprocess
tests belong in `tests/test-suite-unit-full-only.txt`. For Core changes, use the
[focused optimizer workflow](docs/testing.md#focused-optimizer-verification).

## Standards and baselines

The full Test262 corpus runs only on CI: the Test262 workflow runs it after CI
passes on every push to `main`. Do not run it locally (unfiltered `npm run test262`,
`test262:report`, `test:full`, or `test:full:report`); filtered runs and the
regression manifests remain normal development tools. Reproduce Test262 cases
through its runner so harness includes and variants are honored. Use explicit
`--backend` and `--mode` flags: canonical runners remove ambient runtime overrides
such as `MAL_INTERP`. Keep self-hosted checks early in the full gate.

Test262 checks the resolved HEAD baseline without rewriting it; inspect completeness
and exact `PASSED -> FAILED` transitions, not just totals. The workflow maintains the
`Automated Test262 regressions` issue and commits improvement-only refreshes of
`scripts/test262.json`, so never replace that baseline by hand. An intentional
replacement, such as advancing the pinned corpus, imports a complete CI report with
an authorized `npm run test262:update-baseline -- --from-report`. Updating
`bench/baseline.json` requires an authorized benchmark `--update` through the
benchmark baseline workflow. Neither baseline update is implied by running a check.

## Performance and evidence

Use matched workloads, output parity, source/toolchain identity, and repeated
interleaved pairs for performance conclusions. Keep local measurements to the
comparison a decision needs; complete benchmark families and baseline refreshes run
in their CI workflows. Inspect `--plan=json` before costly work; a single pair or zero
exit code does not establish acceptance. A quick check is one run without warmups,
reported as indicative. Use the [benchmark reference](docs/benchmarking.md) for
commands, budgets, and resume rules.

Report what was exercised, failed, and left unverified. Retain the evidence needed
to review the current change; historical timings and old passes are not current
validation. Cite the retained [run report](docs/testing.md#reports), not the mutable
latest shortcut. Evidence counts only for its recorded source, selection, and
environment; changed source or incomplete coverage cannot establish acceptance.

## Artifact hygiene

- Use one task-scoped `.cache/` directory for retained evidence and OS temporary
  directories with cleanup in `finally` for disposable intermediates. Keep profiles,
  logs, captures, and scratch scripts out of tracked directories.
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
  its location. Never force-add `.cache/` contents or delete another task's artifacts.

## Cleanup and delegation

Audit ownership and activity before deleting artifacts. Remove only explicitly
identified inactive scratch or superseded generated data; preserve source, baselines,
useful failure evidence, and unrelated drafts. The user cache trims itself in the
background; prune it by hand only when asked, previewing with `cache prune --dry-run`
first. Pruning manages the user cache, not repository reports; see
[cache ownership](docs/testing.md#cache-ownership). Never reuse an old deletion list.

When you delegate, give each assignment a complete scope and capture its output. Run
independent assignments in parallel only with non-overlapping edits. Review and verify
their edits before acceptance. Do not inherit old model pins or unrestricted-permission
recipes from saved task history.
