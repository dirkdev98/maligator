# Compare native microbenchmarks on GitHub Actions

The **Native microbenchmark compare** workflow compares an open PR or repository
ref with the current `main` commit. Both revisions are pinned when the request is
authorized. It uses the same frozen candidate workload and toolchain for both
compilers, checks output against Node, and alternates baseline/candidate timing
pairs on one runner.
Each pair also records a Node timing sample, alternating before and after the
native pair, so the raw report includes repeated Node/Maligator runtime offsets.
All three hosts run with `TZ=UTC`.

## From a pull request

Add a comment containing one command:

```text
/microbench string-search,string-flat-iteration,string-keys
```

Use exact IDs from [the runtime-gap catalog](../bench/runtime-gap/catalog.json).
Select at most 24 comma-separated IDs. Whitespace around commas is allowed;
duplicates, unknown IDs, extra prose, and multiple command lines are rejected.
Cases added by the PR are available because its catalog and fixtures supply the
workloads for both compilers.

A bare `/microbench` runs the existing 13 call, record, allocation, and property
controls. It does not select every catalog entry. Comments use seven pairs and a
40-minute comparison budget including builds. New comments trigger runs; editing
an existing comment does not. A push to the PR does not automatically rerun this
workflow.

The commenter must currently have repository **write**, **maintain**, or **admin**
access. The workflow asks GitHub for current permission rather than relying on
the comment's author association. Reruns also recheck the rerun initiator's access.
The PR must still be open. If its head moves between request resolution and
checkout, the run fails and asks for a new request.

## From the Actions page or CLI

Open **Actions → Native microbenchmark compare → Run workflow**. Leave the workflow
branch on `main`; choose the candidate with exactly one of these inputs:

| Input            | Meaning                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `pr`             | An open PR number, including a fork PR                                                      |
| `ref`            | A branch, tag, or full commit SHA in this repository                                        |
| `cases`          | Comma-separated case IDs; empty uses the 13 default controls                                |
| `pairs`          | Alternating pairs per case, from 3 to 21; default 7                                         |
| `budget_seconds` | Build and measurement budget, from 60 to 3000; default 2400                                 |
| `diagnostics`    | Keep production ELF, symbol companions, assembly, and optional perf counters; default false |

For example, with the GitHub CLI:

```sh
gh workflow run microbench.yml --ref main \
  -f pr=71 \
  -f cases=string-search,string-flat-iteration,string-keys \
  -f pairs=9 -f budget_seconds=2400
```

Or compare a branch:

```sh
gh workflow run microbench.yml --ref main \
  -f ref=perf/string-followups-round2 \
  -f cases=direct-calls,record-array-traversal
```

The workflow has a 65-minute job ceiling covering toolchain/dependency setup,
comparison, summary, and upload. A large selection can exhaust its comparison
budget; select smaller related groups when investigating a regression. Matching
dependency lockfiles and native build plans are required. Changing either causes
an explicit failure rather than a comparison with mismatched dependencies.

## Runtime call probes

These six cases keep the target opaque to the optimizer using a runtime property
name. The sixteen-argument cases resolve their target before warmup and timing;
the receiver case includes method lookup on each call. Argument counts and most
argument values remain known at each call site.

| Case                        | Measured boundary                                                  |
| --------------------------- | ------------------------------------------------------------------ |
| `call-this-two-args`        | Method lookup, `this`, and two positional arguments                |
| `call-fixed-sixteen-args`   | Stable indirect target and sixteen positional arguments            |
| `call-bound-prefix-args`    | Bound `this`, eight bound arguments, and eight supplied arguments  |
| `call-bound-receiver-chain` | Thirty-two receiver-only bind wrappers and one supplied argument   |
| `call-arguments-escape`     | Returning a strict unmapped `arguments` object with sixteen values |
| `call-rest-escape`          | Returning a rest array with the same sixteen values                |

The last two cases read identical runtime-selected endpoints and `length`; their
objects escape the callee, so scalar argument loads and one-use rest forwarding
cannot replace materialization. Binding and target resolution are setup costs.
The receiver and fixed-arity cases have different lookup and receiver work; their
timing difference does not isolate argument count alone.

Run a small parity-checked probe after the environment check:

```sh
npm run bench:performance -- gap \
  --case call-this-two-args --case call-fixed-sixteen-args \
  --case call-bound-prefix-args --case call-arguments-escape --case call-rest-escape \
  --samples 1 --target-node-ms 5 --warmup-blocks 1 --budget-seconds 600 \
  --skip-node-allocation
```

For an optimization comparison, pass these IDs to `native-micro-compare.ts` or
`/microbench`. Validate call retention again for each compiler revision: inspect
the optimized image for an ordinary hot call without an exact or guarded script
target, its emitted C for runtime dispatch, and native disassembly for the retained
dispatch call. A surviving generated function symbol alone does not exclude
inlining. Node's JIT may inline its target; Node supplies the output oracle and a
host comparison, while native call retention establishes this runtime boundary.

## Read the evidence

The Actions run summary shows pinned commits, median baseline and candidate kernel
times, median paired percentage reduction, paired variability (MAD), and the count
of faster pairs. A second table shows the repeated Node median, candidate/Node ratio,
and host gap in milliseconds and nanoseconds per fixture operation. A positive host
gap means the candidate took longer than Node. A positive reduction means the
candidate took less time. A green run means complete matching evidence was produced;
it does not establish a performance win. Inspect pair consistency and magnitude before keeping a change.
The workflow uses main's trusted renderer, so report-format changes on a PR take
effect in Actions after they reach main.

The `microbench-<run-id>-<attempt>` artifact contains `summary.md`, the comparison
plan, `revisions.txt`, environment details, `micro/report.json`, frozen fixtures,
generated C, and child logs. Optional diagnostics also retain ELF files and assembly.
Artifacts last seven days. Summaries and partial artifacts are uploaded after a
failed comparison, and the run remains failed. The summary distinguishes all timing
pairs having completed from later diagnostic failures.

The baseline is the resolved tip of `main`, not a merge base. The existing
label-triggered [Native performance workflow](../.github/workflows/native-performance.yml)
continues to provide parent/cumulative merge-base comparisons. See
[testing documentation](testing.md#bounded-native-runtime-and-compiler-checks)
for local runner commands and details of parity and timing evidence.

## Execution boundary

Only the trusted workflow revision resolves requests and checks permissions.
Candidate code and dependencies run in a separate job with a read-only token,
no persisted checkout credentials, no secrets, and no shared Actions cache access
(`cache-mode: none`). The trusted workflow chooses the pinned native toolchain.
The report is rendered in that same unprivileged job and uploaded to the Actions
run; it does not execute artifact code in a privileged publisher or post PR comments.

The workflow must exist on `main` to receive comments and manual dispatches.
GitHub documents [issue-comment workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment),
[current repository permission lookup](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user),
and [enforced cache access modes](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#controlling-cache-access-with-cache-mode).
