The npm platform package includes prebuilt development runners and runtime archives.
With locked primordials and realms disabled, `run`, `dev`, and `test` can use the
packaged runner without a local toolchain if the project has no C bindings.
`build --production` compiles C on the build host and uses matching Rust archives
without Rustup, Cargo, or rustc.

## Check the toolchain

```shell
maligator doctor --verbose
```

`doctor` reports the selected C compiler or a planned Zig download. It reports
whether it found matching Rust archives. `--verbose` adds tool paths, versions,
target information, and probe results. `doctor` leaves installation to the build.

## Compiler selection

The production build uses `cc` from `PATH` when it can compile and link the runtime.
Set `CC` and `CXX` to select a specific compiler. On macOS, Apple's command-line
tools provide both compilers. On Linux, install a recent Clang from your distribution.

When the default C toolchain is unavailable or lacks the required compiler features,
a production build uses an existing Zig installation. Set `ZIG` to select its
executable. If Zig is absent, the build downloads the pinned host release, verifies
its checksum and stores it in the Maligator cache. The download uses the system
`curl` and `tar` with xz support. Use `doctor` to see the download destination before
the first build.

## Local runtime builds

Install a C23-capable C compiler and archiver, a C++ compiler, and
[Rustup](https://rustup.rs) to build the runtime locally. The CLI needs these tools
for a source checkout and when the packaged archives do not match the requested
target or runtime configuration. A build with mutable primordials or realms enabled
uses a local runtime. [C bindings](/guides/c-libraries) need a native compiler even
when development uses a packaged runner.

## Cross-build for another target

Pass a Rust target triple to `build` to cross-compile through [Zig](https://ziglang.org).
Maligator supports ARM64 and x86-64 targets on macOS and glibc Linux.

```shell
maligator doctor --target x86_64-unknown-linux-gnu --verbose
maligator build --production --target x86_64-unknown-linux-gnu
```

If the selected platform package matches the build host, a different target can
require a local Rust build. Install the Rust standard library for that target in
the toolchain used by Maligator, or set `MALIGATOR_PREBUILT_RUNTIME_DIR` to a
matching runtime archive directory. Test the executable on the intended host.
