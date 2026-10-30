<img src="website/mascot.webp" alt="The Maligator mascot" width="112" align="right">

# Maligator

An ahead-of-time JavaScript compiler and native runtime. Maligator compiles
JavaScript and erasable TypeScript to C and links it with its runtime into a
standalone executable. Engine features and host APIs are selected per build, so a
program that does not ask for `eval`, Intl, or the Node.js surface does not carry
them.

Maligator is an experimental alpha. Check
[compatibility](https://maligator.ddv.tools/compatibility) before relying on a Web
API, Node.js module, or language feature.

## Install

```shell
npm install --global @maligator/cli@alpha
```

Prebuilt packages cover macOS and glibc-based Linux on arm64 and x64. The npm launcher
needs Node.js 20 or newer; the CLI itself and the executables it builds do not.

## Quick start

From the root of an application project:

```shell
maligator init
maligator run
maligator build --production
```

`init` creates `maligator.build.ts` and, when no entry point exists yet, a starter
`src/index.ts`. `run` compiles a development image and executes it. `build` produces
a native executable and prints its path. See
[Getting started](https://maligator.ddv.tools/guides/getting-started) for the full
walkthrough.

## Native toolchain

`run` and `test` use the runtime embedded in the CLI for ordinary configurations.
Native builds compile the runtime on your machine and need:

- A C compiler and archive tool with C23 support: Apple clang, clang 19 or newer, or
  gcc 15 or newer.
- Rustup, for the Rust toolchain pinned by the runtime.
- A C++ compiler, only when `surface.webPlatform` is enabled.

`maligator doctor --verbose` checks all of it.
[Set up native builds](https://maligator.ddv.tools/guides/native-toolchain) covers
installation per host and cross-builds through Zig.

## Status

What works today:

- Standalone native executables, with optional embedded files and an HTTP server.
- A runtime shaped per build: eval, Realms, RegExp, Temporal, Intl, Web APIs, and a
  curated Node.js surface are each opt-in or opt-out.
- Isolated workers with shared memory, transferable ports, and task pools.
- The [Compatibility page](https://maligator.ddv.tools/compatibility) reports Test262
  coverage from the committed baseline.

What does not, yet:

- Real project use has only just started and keeps exposing rough edges.
- The Node.js surface is curated, not complete.
- Some paths are quick; ordinary constructs can still be much slower.
- Windows is not supported, and the alpha binaries are unsigned and not notarized.

## Documentation

The [documentation](https://maligator.ddv.tools/docs) has task guides and an API
reference with signatures, defaults, and failure behavior. Good places to start:

- [Develop an application](https://maligator.ddv.tools/guides/development) and
  [test it](https://maligator.ddv.tools/guides/testing).
- [Configure a build](https://maligator.ddv.tools/guides/build-configuration) and
  [build for production](https://maligator.ddv.tools/guides/production).
- [Run tasks in workers](https://maligator.ddv.tools/guides/workers) and
  [serve HTTP](https://maligator.ddv.tools/guides/http).
- [Troubleshooting](https://maligator.ddv.tools/guides/troubleshooting) and the
  [CLI reference](https://maligator.ddv.tools/api/cli).

Every page has a Markdown copy, and the
[public symbol index](https://maligator.ddv.tools/reference.json) lists every symbol
with its signature and availability.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up the checkout, running the
compiler from source, and verifying a change. Coding agents follow
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
