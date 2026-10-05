Run commands from your application project root. Relative entries, config paths, and assets resolve there. No ancestor search occurs. Unknown options, missing values, and unexpected positional arguments are errors. Use `maligator --help` and `maligator --version` to inspect the installed CLI.

## init {#init}

```shell
maligator init
```

Creates `maligator.build.ts` without overwriting it. Chooses the first existing entry among `src/index.ts`, `src/main.ts`, `index.ts`, and `main.ts`; otherwise writes `src/index.ts`. See [Getting started](/guides/getting-started).

## doctor {#doctor}

```shell
maligator doctor [--verbose] [--target rust-triple]
```

Checks native C/C++ and Rust toolchains. `--verbose` includes paths, versions, target capabilities, and probe-cache status. `--target` checks a cross-build target through Zig and Rust. Does not build the application.

## build {#build}

```shell
maligator build [entry] [--config path] [--name name]
  [--production] [--compile-concurrency 1..3]
  [--artifact directory] [--target rust-triple]
  [--profile[=compiler]] [--verbose] [--core-report mode]
```

Compiles a native executable and prints its path. An explicit entry overrides `config.entry`; `--name` overrides `outputName`. Without either name, uses the unscoped package name or project directory. Requires the native toolchain.

| Flag                    | Behavior                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--production`          | Enable production optimization and link-time optimization when supported.                                          |
| `--compile-concurrency` | Production total job limit, integer 1..3. Default is at most 3, bounded by host CPU capacity. Profiling is serial. |
| `--artifact`            | Write a deployable directory; requires production and an absent or empty destination.                              |
| `--target`              | Select a Rust target triple; requires matching C/C++ and Rust tools.                                               |
| `--core-report`         | `phases`, `counters`, or `full` compiler diagnostics.                                                              |
| `--verbose`             | Print build diagnostics.                                                                                           |

Artifacts contain `artifact.json`, `LICENSE`, `SHA256SUMS`, and `bin/<name>`, plus `profile.json` when profiling. See [Build for production](/guides/production).

## run {#run}

```shell
maligator run [entry] [--config path] [--profile[=compiler]] [-- args...]
```

Compiles a portable development image and runs a fresh VM. For supported profiles with Intl disabled, the distributed CLI supplies the specialized runtime without a local native toolchain. Forwards arguments after `--` without parsing them and propagates the application's exit status or terminating signal. A config is optional when an explicit entry supplies the program.

## dev {#dev}

```shell
maligator dev [entry] [--config path] [--status]
  [--profile[=compiler]] [-- args...]
```

Watches dependencies and replaces the application after successful rebuilds. A compile error preserves the watcher and last good application. Every replacement has fresh module instances. `--status` streams generations and resource states. Ctrl+C joins active work. See [Develop an application](/guides/development).

## test {#test}

```shell
maligator test [path ...] [--config path] [--run name]
  [--shuffle [seed]] [--repeat count] [--timeout milliseconds] [--bail]
  [--isolate] [--compile-concurrency count] [--concurrency count]
  [--watch] [--watch-failed] [--status] [--profile[=compiler]]
```

Discovers `*.test.{js,mjs,ts,mts}` and `*.spec.{js,mjs,ts,mts}`. Ordinary runs interpret a development image. Selected files share one application isolate by default; results are not cached. A failing test produces a nonzero exit status.

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

`--isolate` cannot combine with profiling. See [Test an application](/guides/testing) for a complete suite.

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

`status` reports Maligator-owned cache usage. `prune` removes eligible stale, rebuildable entries while preserving live leases and protected recent entries. The default target is 15 GiB and minimum age is 1 day; protections can leave more than the target. Use `--dry-run` to inspect candidates and `--verbose` for each entry. `clear --all` explicitly removes rebuildable cache entries. See [Troubleshooting](/guides/troubleshooting#inspect-cache-usage).

## Diagnostic build options {#diagnostic-build-options}

`build --serialize <file>` writes a portable program image for toolchain diagnostics. It cannot carry configured filesystem assets. Native builds use the compiled backend by default. `build --no-compiled` selects the interpreted native diagnostic backend. `--render-native-c` (alias `--print`) emits C for inspection, and `--dump-core` adds Core diagnostics. These diagnostics are separate from a deployable production artifact.
