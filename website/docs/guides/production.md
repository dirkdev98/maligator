Build a native executable with production optimizations, then launch the reported path directly. The runtime is included; the target machine does not need Node.js or your source tree.

## Check the build host

```shell
maligator doctor --verbose
maligator build --production
```

Native compilation needs a C/C++ compiler and Rust. `doctor` reports resolved paths, versions, target capabilities, and probe-cache status. On macOS, install Apple build tools with `xcode-select --install`; see the [repository toolchain instructions](https://github.com/dirkdev98/maligator#native-toolchain) for the complete host setup.

The output name comes from `outputName`, the unscoped package name, or the project directory. Production binaries are placed under the project build cache; use the path the command prints rather than guessing its cache identity.

## Create a deployable artifact

```shell
maligator build --production --artifact dist/my-app
```

The destination must be absent or empty. The result contains:

```text
my-app/
  artifact.json
  LICENSE
  SHA256SUMS
  bin/
    <application>
```

`artifact.json` records version, target, production status, size, and SHA-256 identity. Copy or archive the complete directory. If profiling was requested, `profile.json` is also included.

Configuration environment reads happen at build time. Runtime arguments and environment values belong to the launched application; they do not change the captured [execution context](/api/process#execution).

## Build for another target

```shell
maligator doctor --target x86_64-unknown-linux-gnu --verbose
maligator build --production --target x86_64-unknown-linux-gnu
```

Cross-builds use detected Zig tools for C/C++ and the matching Rust target for the runtime. Install and validate both halves. A target triple does not guarantee that every target host, operating-system version, or optional runtime feature is supported; test the artifact on its intended host.

## Bound worker-image compilation

Production builds overlap the owning compiler with up to two worker-image compilers, bounded by the host CPU budget. `--compile-concurrency 1` selects serial compilation; values `2` or `3` lower the total job limit. Applications without worker roots and cache hits start no helpers. This flag requires `--production`; profiling stays serial.

Retain source, config, Maligator version, and toolchain identity with your release. Output caching avoids repeated work but does not establish byte-for-byte reproducibility across toolchains. Use [profiling](/guides/profiling) for performance evidence and [CLI build options](/api/cli#build) for exact flags.
