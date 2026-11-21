`maligator build --production` uses a C compiler and archive tool on the build host.
The platform package supplies the Rust runtime archives for the default flavour.
`run`, `dev` and `test` can use a packaged development runner when the project
configuration matches. The finished executable needs only its runtime libraries.

## Check the toolchain

```shell
maligator doctor --verbose
```

`doctor` shows the C compiler that production builds will use, the target, the
capabilities it tested and whether the Rust runtime comes from the platform package.
Install a C++ compiler and [Rustup](https://rustup.rs) if the build needs to compile
the Rust runtime locally.

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

## Cross-build for another target

Pass a Rust target triple to `build` to cross-compile through [Zig](https://ziglang.org).
Maligator supports ARM64 and x86-64 targets on macOS and glibc Linux.

```shell
maligator doctor --target x86_64-unknown-linux-gnu --verbose
maligator build --production --target x86_64-unknown-linux-gnu
```

Install the Rust standard library for the target if its runtime archive must build
locally. Test the executable on the intended host. See
[Build for production](/guides/production#build-for-another-target).
