Run commands from your application project root. Relative entries and config paths resolve there. Maligator looks for the build config in that directory. [Embedded asset specifiers](/guides/assets) resolve from their declaring modules. Unknown options, missing values, and unexpected positional arguments are errors.

Use `maligator --help` to list commands and `maligator --version` to see the installed version. Put `--help` after a command or subcommand to see its options and defaults, as in `maligator build --help` or `maligator ffi check --help`.

## init {#init}

```shell
maligator init
```

Creates `maligator.build.ts` and uses an existing entry or writes a starter. Sets up missing package and TypeScript options, reports what it created, updated, or skipped, and prints commands to run, watch, and test the project. See [Getting started](/guides/getting-started).

## doctor {#doctor}

```shell
maligator doctor [--verbose] [--target rust-triple]
```

Reports the compiler, planned Zig download, and packaged Rust archive availability for a production build. `--verbose` adds tool paths, versions, target capabilities, and probe-cache status. `--target` selects a cross-build target. See [toolchain setup](/guides/native-toolchain).

## build {#build}

```shell
maligator build [entry] [--config path] [--name name]
  [--production] [--compile-concurrency 1..3]
  [--artifact directory] [--target rust-triple]
  [--profile[=compiler]] [--feedback file] [--verbose] [--core-report mode]
```

Compiles a native executable. Stdout contains the executable path, or the artifact directory when you pass `--artifact`. Progress goes to stderr. An explicit entry overrides `config.entry`, and `--name` overrides `outputName`. Without either name, uses the unscoped package name or project directory. See [toolchain setup](/guides/native-toolchain) for how builds find their compiler and runtime archives.

| Flag                    | Behavior                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--production`          | Enable production optimization and link-time optimization when supported.                                          |
| `--compile-concurrency` | Production total job limit, integer 1..3. Default is at most 3, bounded by host CPU capacity. Profiling is serial. |
| `--artifact`            | Write a deployable directory; requires production and an absent or empty destination.                              |
| `--target`              | Select a cross-build target in Rust triple syntax. Uses Zig for C compilation and linking.                         |
| `--feedback`            | Read a [feedback file](#feedback) recorded by `run`, `dev`, or `test`; requires production.                        |
| `--core-report`         | `phases`, `counters`, or `full` compiler diagnostics.                                                              |
| `--verbose`             | Print build diagnostics.                                                                                           |

Artifacts include the executable in `bin/`, a manifest, checksums, and license files. Profiling adds `profile.jsonl`. See [Build for production](/guides/production).

## run {#run}

```shell
maligator run [entry] [--config path] [--profile[=compiler]] [--feedback file]
  [--verbose] [-- args...]
```

Compiles a development image and runs it in a fresh VM. The npm platform package supplies a toolchain-free runner for matching configurations without C bindings. `run` forwards arguments after `--` and propagates the application's exit status or terminating signal. It reports unsuccessful exits on stderr. A config is optional when you pass the entry explicitly.

## dev {#dev}

```shell
maligator dev [entry] [--config path] [--status]
  [--profile[=compiler]] [--feedback file] [--verbose] [-- args...]
```

Watches dependencies and replaces the application after successful rebuilds. A compile error preserves the watcher and last good application. Every replacement has fresh module instances. `--status` streams generations and resource states. Ctrl+C joins active work. See [Develop an application](/guides/development).

## test {#test}

```shell
maligator test [path ...] [--config path] [--run name]
  [--shuffle [seed]] [--repeat count] [--timeout milliseconds] [--bail]
  [--isolate] [--compile-concurrency count] [--concurrency count]
  [--watch] [--watch-failed] [--status] [--profile[=compiler]]
  [--feedback file] [--verbose]
```

Discovers `*.test.{js,mjs,ts,mts}` and `*.spec.{js,mjs,ts,mts}`. Ordinary runs interpret a development image and can use the packaged runner. Selected files share one application isolate by default. Every selected test runs on each invocation. A failing test produces a nonzero exit status.

| Flag                    | Default and behavior                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `--run`                 | No filter. Match hierarchical suite/test names.                                      |
| `--shuffle`             | Off. Optional positive integer seed; chosen seed is printed.                         |
| `--repeat`              | 1. Positive integer; rerun the registered suite without recompiling.                 |
| `--timeout`             | 5000 ms. Positive integer callback deadline.                                         |
| `--bail`                | Off. Stop on first failure.                                                          |
| `--isolate`             | Off. Fresh application per selected file; requires compatible native runtime policy. |
| `--compile-concurrency` | 1. Positive integer compilation budget.                                              |
| `--concurrency`         | 1. Positive integer execution budget; greater than 1 requires isolation.             |
| `--watch`               | Off. Retain images and rerun in fresh applications; cannot combine with profiling.   |
| `--watch-failed`        | Off. Requires watch; restrict unchanged SIGHUP reruns to failed files.               |
| `--status`              | Off. Requires watch; stream generation and resource states.                          |

`--verbose` shows compiler diagnostics during profiling. `--isolate` cannot combine with profiling. See [Test an application](/guides/testing) for a complete suite.

## --feedback {#feedback}

Available on `run`, `dev`, and `test`, and read by `build --production`. Records what each executed property access saw into a JSON feedback file: the receivers' shapes and heap kind, an inline cache mode such as `inherited`, `dictionary` for receivers that keep their properties in a table, or `megamorphic` once a site saw more than four shapes. Every shape a site saw counts, not only the ones its cache still holds when the program ends. A site also records the functions its loads produced, and a plain call of a variable, parameter or closure records the functions it called: up to four `targets`, named `builtin:<name>` for a built-in such as `builtin:String.prototype.indexOf` or `fn:<origin>:<revision>` for a source function, else `targetsMegamorphic`, also for bound functions and other functions without a portable name. Primitive receivers record their `kind`, such as `string`. Sites are keyed by their source function, callbacks and module top-level code included, and their offset, so a later build can match them while the source is unchanged. Sites that never ran are absent.

Each command records one unit: `run:<entry>`, `dev:<entry>`, or `test:*` for a whole test invocation. Entries and modules are named relative to the project root, the directory of the build config, else the entry's nearest directory with a `package.json`, so a run from a subdirectory records the same unit. Recording a unit replaces its earlier entries and keeps every other unit's, so one file can collect several workloads. The file is deterministic: an identical run writes identical bytes. `dev` re-records its unit when each generation stops. `--feedback` cannot combine with `--profile`, and on `test` not with `--watch` or `--isolate`.

A production build matches the file's functions to the program by source identity and revision, and combines every unit's entries for a site. A function edited since the recording, and every function around it, is skipped, so stale feedback costs speed but never changes behavior. Only the matched entries enter the build's cache identity: a file that matches nothing builds the same program as no file. Targets and call sites, which no optimization reads, don't enter it. `--core-report counters` reports the matched and stale functions and the sites the compiler found.

## --profile {#profile}

Available on `build`, `run`, `dev`, and `test`. Compiles a separate production-optimized diagnostic image. Plain `--profile` captures sampled CPU, charged allocation, and GC evidence; `--profile=compiler` also records exact compiler counters. Both require the native toolchain and remain serial.

`run`, `dev`, and `test` print source-ranked findings and write captures under `.maligator/profiles`. `MALIGATOR_PROFILE_DIRECTORY` selects the parent directory. `build` writes a metadata sidecar beside the binary. See [Profile an application](/guides/profiling).

## cache {#cache}

```shell
maligator cache status
maligator cache prune [--max-gb number] [--min-age-days number]
  [--dry-run] [--verbose]
maligator cache clear --all
```

The cache keeps itself within a budget: after a command, Maligator trims it in the background once it passes 20 GiB, back to 15 GiB. On a volume with at least 200 GiB available to the cache the limit is 100 GiB, trimmed back to 40 GiB. `MALIGATOR_CACHE_MAX_GB` fixes the limit and `MALIGATOR_CACHE_MAINTENANCE=off` turns the background trim off; CI runners (`CI=true`) skip it. Maintenance normally protects entries used within the last hour. Below 10 GiB of free disk space, it can trim below the normal budget and protects the last ten minutes instead. Active command scratch remains protected.

`status` reports Maligator-owned cache usage, the budget and the last trim. `prune` removes eligible stale, rebuildable entries right away. Its default target is the budget's trim-back size and its minimum age is 1 day; protections can leave more than the target. Use `--dry-run` to inspect candidates and `--verbose` for each entry. `clear --all` explicitly removes rebuildable cache entries. See [Troubleshooting](/guides/troubleshooting#inspect-cache-usage).

The user cache lives in `~/Library/Caches/maligator` on macOS and `$XDG_CACHE_HOME/maligator` (default `~/.cache/maligator`) on Linux. `MALIGATOR_CACHE_DIR` replaces that directory. Project outputs live under `.cache/mal-build` in the project root; removing it keeps the reusable user cache.

## ffi inspect {#ffi-inspect}

```shell
maligator ffi inspect <library> [--json] [--config path] [--target rust-triple]
```

Finds a C library declared under `ffi` in the build config, reads its headers with the target's clang, and reports how each declaration maps to JavaScript. Declarations that cannot map list the fact they need, and the report suggests facts that make more of them bind, in contract syntax. Requires clang, or Zig with `--target`.

| Flag       | Behavior                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `--json`   | Print discovery, structured C declarations, accepted facts, mapped signatures, gaps and suggested facts. |
| `--target` | Read the headers for a cross-build target through Zig.                                                   |

The JSON `model` contains the extracted functions, records, typedefs, enums and macros,
including types that cannot bind and system types needed to resolve them. Declaration
tables are arrays. Enum values and integer macro values are decimal strings, preserving
integers that JavaScript numbers cannot represent exactly. Type objects retain their
`kind`, pointer qualifiers and typedef names; `library` distinguishes library types from
transitive system types. The `facts` field carries the accepted contract facts.

Header extraction decodes clang's AST declaration by declaration, so a large included
system header does not require one large string. Source files decode by line and
cached models store declarations separately too. An individual declaration, source
line or documentation block remains subject to the native runtime's string limit.

## ffi types {#ffi-types}

```shell
maligator ffi types [--out path] [--config path] [--target rust-triple]
```

Writes TypeScript declarations for every library under `ffi`: one `declare module "maligator:ffi/<name>"` block each, with the header documentation. The default file is `maligator-ffi.d.ts` in the project root. Builds warn when that file no longer matches the libraries' headers and facts; run `ffi types` again then. The file records a digest of its declarations, so reformatting it does not trigger the warning.

## ffi check {#ffi-check}

```shell
maligator ffi check [library] [--json] [--update] [--out path]
  [--config path] [--target rust-triple] [--probe test-path]
  [--probe-timeout milliseconds]
```

Checks C declarations and accepted facts against `maligator-ffi.lock.json` in the
project root. A missing snapshot or a change exits with status 1 and reports the
differences. Without a library name, checks every configured library and reports
libraries removed from the configuration.

Run `--update` after reviewing the headers and facts to accept the current snapshot.
Commit the lockfile with the contract. Snapshots are separate for each target; updating
one target preserves the others. Naming a library updates only that library. `--out`
selects another lockfile, and `--json` prints the report as JSON.

The snapshot follows the C types used by exports and facts, including typedefs,
record fields, constants and helper declarations. It catches changes such as `short`
becoming `int` even when both map to TypeScript `number`. A type or function fact can
cite header documentation with `evidence: [{ kind: "function", name: "release" }]`.
The check records the cited declaration's cleaned documentation, including documented
members, and shows changes to that text. Citation kinds are `function`, `typedef`,
`struct`, `union`, `enum` and `macro`. Missing declarations or documentation are errors,
including with `--update`.

Uncited comments, source locations and declarations outside the checked surface do
not affect the snapshot. Citations identify text for the contract author to review.
The snapshot describes declarations; application tests exercise the library's behavior.

`--probe test-path` runs the project's selected Maligator tests with native sanitizers:
UBSan on macOS and ASan+UBSan elsewhere. At least one test must pass. With `--update`,
acceptance waits for the probe to succeed and for its configuration, C inputs,
compiled test dependencies and existing lockfile to remain unchanged. Probes run on
the host, so `--target` cannot be combined with `--probe`.

`--probe-timeout` bounds the child process, including a blocking C call; the default
is 30000 milliseconds. Compilation runs before this deadline. A JSON report under
`.cache/ffi-check/` retains the selected sanitizer, input and executable identities,
test summary and captured output. `--json` includes this report and its path.

Header code and configured C sources receive sanitizer flags. Use an instrumented
build of a prebuilt library to check its internals. Run these checks in CI alongside
the application's tests; builds do not run them automatically.

## Diagnostic build options {#diagnostic-build-options}

`build --serialize <file>` writes a portable program image for toolchain diagnostics. Serialization rejects reachable embedded assets and configured C libraries. Native builds use the compiled backend by default. `build --no-compiled` selects the interpreted native diagnostic backend. `--render-native-c` and its alias `--print` emit C for inspection. `--dump-core` adds Core diagnostics.
