<img src="website/mascot.webp" alt="The Maligator mascot" width="112" align="right">

# Maligator

An ahead-of-time JavaScript compiler and native runtime. Maligator compiles
JavaScript and erasable TypeScript to C and links it with its runtime into a
standalone executable. Configure language features such as eval and Intl.
Production builds link supported Web APIs and Node.js modules by use.

Maligator is an experimental alpha. Check
[compatibility](https://maligator.ddv.tools/compatibility) before relying on a Web
API, Node.js module, or language feature.

## Install

```shell
npm install --global @maligator/cli@alpha
```

Prebuilt packages cover macOS 15 or newer and glibc-based Linux on arm64 and x64.
The npm launcher needs Node.js 20 or newer; the CLI itself and the executables it
builds do not.

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

The npm platform package includes runners for `run`, `dev`, and `test`. Projects
with a matching configuration and no C bindings can use them without a local
toolchain.

`build --production` compiles C on the build host and uses the packaged Rust
archives when they match the target and configuration. It downloads a pinned Zig
release if it cannot use the host compiler or an existing Zig installation.
`maligator doctor --verbose` reports the selected compiler or planned download.
See [Set up native builds](https://maligator.ddv.tools/guides/native-toolchain)
for local runtime builds and cross-builds.

## Documentation

The [documentation](https://maligator.ddv.tools/docs) has task guides and an API
reference with signatures, defaults, and failure behavior. Good places to start:

- [Develop an application](https://maligator.ddv.tools/guides/development) and
  [test it](https://maligator.ddv.tools/guides/testing).
- [Configure a build](https://maligator.ddv.tools/guides/build-configuration) and
  [build for production](https://maligator.ddv.tools/guides/production).
- [Run tasks in workers](https://maligator.ddv.tools/guides/workers) and
  [serve HTTP](https://maligator.ddv.tools/guides/http).
- [Read and write files](https://maligator.ddv.tools/guides/files).
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
