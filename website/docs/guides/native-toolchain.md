`maligator build` compiles Maligator's C runtime and Rust crate together with your application, so it needs a native toolchain on the build host. `run`, `dev`, and `test` use the runtime embedded in the distributed CLI for ordinary profiles with Intl disabled and do not need these tools. The executables you build do not need them either.

## Install the requirements

- A C compiler and archive tool with C23 support: Apple clang, clang 19 or newer, or gcc 15 or newer. gcc 14 and older accept `-std=c2x` but lack `#embed`, so `doctor` rejects them.
- Rustup. Maligator builds its runtime with the Rust toolchain pinned by that runtime.
- A C++ compiler and runtime, only when `surface.webPlatform` is enabled.

On macOS, Apple's command-line tools provide the C and C++ compilers:

```shell
xcode-select --install
```

On Linux, install a C23-capable compiler from your distribution. When its default gcc is older than 15, install clang 19 or newer and select it for Maligator. For example, on Ubuntu 26.04:

```shell
sudo apt install clang-21
export CC=clang-21 CXX=clang++-21
```

Install Rust through [Rustup](https://rustup.rs) on both platforms.

## Check the toolchain

```shell
maligator doctor --verbose
```

`doctor` reports resolved paths, versions, C and Rust targets, tested capabilities, and probe-cache status, plus suggested fixes for anything missing. Every native build runs the same checks, so running `doctor` first is optional. `CC` and `CXX` override compiler selection; otherwise tools are resolved strictly from `PATH`.

## Cross-build for another target

Pass a Rust target triple to `build` to cross-compile through [Zig](https://ziglang.org). Supported targets:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `aarch64-unknown-linux-gnu`
- `x86_64-unknown-linux-gnu`

Install Zig on `PATH` (or point `ZIG` at it), add the Rust standard library for the target, and validate both halves before building:

```shell
rustup target add x86_64-unknown-linux-gnu
maligator doctor --target x86_64-unknown-linux-gnu --verbose
maligator build --production --target x86_64-unknown-linux-gnu
```

Zig provides the C and C++ compilers, archive tool, and linker for the target. `maligator run` always targets the build host. Test a cross-built executable on its intended host; see [Build for production](/guides/production#build-for-another-target).
