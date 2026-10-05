# @maligator/cli

[Maligator](https://github.com/dirkdev98/maligator) is a lean
ahead-of-time JavaScript-to-C compiler and native runtime. It turns a JavaScript or
erasable TypeScript entry point into a standalone native executable.

This package is the npm launcher for the prebuilt Maligator CLI. The project is
pre-1.0; install prereleases through the `alpha` channel.

## Install

Install the current alpha globally:

```shell
npm install --global @maligator/cli@alpha
```

Or keep it in a project and invoke it through `npx`:

```shell
npm install --save-dev @maligator/cli@alpha
npx maligator --version
```

The npm launcher requires Node.js 20 or newer. The native CLI and applications
produced by it do not require Node.js.

## Quick start

From the root of an application project:

```shell
maligator init
maligator doctor
maligator build
maligator run -- first-argument "two words"
```

`maligator init` creates `maligator.build.ts`. If it cannot find an existing entry
point, it also creates `src/index.ts`. `doctor` checks the native build toolchain,
`build` produces a development executable, and `run` compiles a development image and executes it while
forwarding everything after `--` to the application.

Useful commands:

```text
maligator --help
maligator --version
maligator init
maligator doctor [--verbose] [--target rust-triple]
maligator build [entry] [--production] [--artifact directory] [--target rust-triple] [--config path]
maligator run [entry] [--config path] [-- args...]
maligator dev [entry] [--config path] [-- args...]
maligator test [path ...] [--run name] [--shuffle [seed]] [--repeat count] [--bail]
```

Run commands from the project root. Maligator does not search parent directories
for configuration.

`run` and `dev` use compile-time-specialized runtimes embedded in the platform
package for locked or mutable primordials, configured assets, the Web and Node
surfaces, and Realm support when Intl is disabled. Those profiles do not need a local
native toolchain. `dev` retains compiler identities between edits and restarts a fresh
application VM after every successful rebuild. Build failures keep the watcher alive
for recovery on the next edit.

## Documentation

Use the [guides](https://maligator.ddv.tools/guides) for application workflows and
the [API reference](https://maligator.ddv.tools/api) for exact contracts.

- [Getting started](https://maligator.ddv.tools/guides/getting-started)
- [Development](https://maligator.ddv.tools/guides/development) and
  [TypeScript](https://maligator.ddv.tools/guides/typescript)
- [Application testing](https://maligator.ddv.tools/guides/testing)
- [Workers](https://maligator.ddv.tools/guides/workers)
- [Build configuration](https://maligator.ddv.tools/guides/build-configuration)
- [Embedded files](https://maligator.ddv.tools/guides/assets) and
  [HTTP](https://maligator.ddv.tools/guides/http)
- [Production](https://maligator.ddv.tools/guides/production) and
  [profiling](https://maligator.ddv.tools/guides/profiling)
- [CLI commands and flags](https://maligator.ddv.tools/api/cli)

The package ships types for configuration, runtime globals, and public `maligator:`
modules. Include `@maligator/cli` in `compilerOptions.types` when your TypeScript
project excludes the build file. Declarations do not enable optional runtime surfaces;
choose those in `maligator.build.ts`.

Every page has a Markdown counterpart. The
[public symbol index](https://maligator.ddv.tools/reference.json) provides signatures,
defaults, availability, and direct links.

## Build toolchain

`maligator test` and supported `maligator run` profiles use the development runtime
embedded in the platform CLI and do not require a native toolchain. Native `build`
commands—and development runs using Intl—require:

- A C23 compiler and archive tool: Apple clang, clang 19 or newer, or GCC 15 or
  newer
- Rustup with the `cargo` and `rustc` toolchain selected by Maligator
- A C++ compiler/runtime only when `surface.webPlatform` is enabled

On macOS, install Apple command-line tools with `xcode-select --install`. On Linux,
install a recent compiler and set `CC` and `CXX` when it is not your system default.
Run `maligator doctor --verbose` for resolved tool paths, versions, capabilities,
and installation hints. The
[native toolchain guide](https://github.com/dirkdev98/maligator#native-toolchain)
has the full requirements and cross-compilation instructions.

## Alpha support

`0.1.0-alpha.1` provides native packages for macOS and glibc-based Linux on arm64
and x64. Later alpha releases currently default to Apple Silicon macOS; consult the
release notes before upgrading on another host. Windows is not supported.

There is no source-build fallback for the CLI package. The alpha binaries are
unsigned, and macOS binaries are not notarized. APIs, configuration, and supported
hosts may change before 1.0.

Please report problems through the
[Maligator issue tracker](https://github.com/dirkdev98/maligator/issues).
