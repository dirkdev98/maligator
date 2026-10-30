# Native builds

How `maligator build` turns a compiled program into a native executable, and how its
caches stay correct. Application-facing setup lives in the
[native toolchain guide](https://maligator.ddv.tools/guides/native-toolchain); this
page is for working on the build pipeline itself.

## Installations

The source-built CLI (`node ./src/index.ts`) resolves its runtime tree and eval
compiler from its own module installation, not from the working directory. The
distributed product CLI instead embeds and materializes those resources, so it is
self-contained. In both cases the working directory remains the application project
root for config, entries, assets, and output caches. Compiler installation roots are
explicit absolute paths passed into the command layer; native stages do not infer
runtime ownership from the application.

The distributed self-hosted CLI embeds the runtime C sources, Rust crate, and a
prebuilt eval compiler wire as its `runtime` and `compilerWire` assets
(`src/product-builder.ts`). It materializes those content-addressed assets on
startup, so the copied compiler can run the full native pipeline outside a Maligator
checkout and without Node.js. `npm run selfhost:cli` exercises that transfer path.

## Toolchain discovery

Every native build performs the same discovery and capability checks used by
`doctor`. `CC` and `CXX` override compiler selection; otherwise tools are resolved
strictly from `PATH`. Runtime translation units are compiled directly with `CC` and
collected into three static archives with `ar`. The Rust half is built with the
`cargo`/`rustc` that Rustup selects for `runtime/rust/rust-toolchain.toml`. A C++
compiler/runtime is only required when `surface.webPlatform` is enabled.

The runtime needs real C23: the `bool`/`true`/`false` keywords (no `<stdbool.h>`),
`nullptr`, and `#embed`. gcc 14 and older accept `-std=c2x` but lack `#embed`, so the
`doctor` C2x probe rejects them.

Discovery, normalized feature booleans, build plan, installation roots, environment
snapshot, and cache root are frozen into one `NativeBuildContext`
(`src/native-build-context.ts`). The C archive, Rust archive, and final linker consume
that same context. The final linker returns a typed result containing the executable
path, exact artifact bundle, and context, so callers such as size tracking cannot
accidentally resolve and measure a different build.

Applications that enable `surface.webPlatform` or `surface.node`, or that start
workers, link `host_main.c`, which installs the host globals and drives the host event
loop. Other applications retain the lean synchronous `test262_main.c` driver. The
product CLI itself uses `host_main.c` for its hosted command surface.

## Cross builds

An explicit `build --target <rust-triple>` cross-builds through a detected Zig
installation. Maligator maps the Rust triple to Zig's target syntax and consistently
uses `zig cc`, `zig c++`, and `zig ar` for the C runtime, Cargo native dependencies,
and final link; optional production stripping is applied by `zig cc` during that
link. Cross-built outputs live under `.cache/mal-build/<mode>/<rust-triple>/`;
`maligator run` remains a native-host command.

## Build modes

Development builds use `-O2`, keep symbols, and do not use LTO. They are intended for
normal iteration and useful native crash diagnostics.

A development build links the same ordered images `run` loads instead of one whole
program. Each image gets a relocatable native overlay that depends only on that
image, and the binary splices the embedded images at startup, so an application edit
recompiles only the application's objects.

Images link the way modules do. An image publishes the bindings of the modules later
images import, and the loader aliases each import to that slot while it splices
(`runtime/src/module_links.c`). So an import stays a live binding and a namespace object
is shared between images. An image evaluates only after the images before it have
settled, top-level await included. A dependency edit that keeps its exported names leaves
the application image cached. Note that `require` and `import()` across an image boundary
still compile one whole program. Code does not optimize across images,
which costs a few percent of throughput against a whole-program development
binary. Configured assets and each image's bytes are embedded in units of their own, so
an asset edit and an application edit never recompile each other's objects. A build with
`MALIGATOR_DEVELOPMENT_FRAGMENTS=0` links one whole program instead. Worker roots
always link their whole-program images behind the compiled worker registry.

`maligator build --production` still uses `-O2`, adds compile/archive/link LTO when
the selected toolchain passes the LTO probe, and strips native symbols after linking
when the host strip probe succeeds. ThinLTO links keep a code generation cache under
the Maligator cache through whichever form the linker accepts: `ld64`'s
`-cache_path_lto`, lld's `--thinlto-cache-dir`, or the LLVM gold plugin's `cache-dir`
option that GNU ld and gold use. Unsupported LTO or stripping emits a warning and
continues with a valid `-O2` executable. Missing required C2x or C++ link capability
is a hard error. Stripping does not remove Maligator's own JavaScript source-position
tables.

## Cache layout

Maligator keeps reusable inputs separate from project outputs:

```text
<user-cache>/maligator/v1/actions/       producer/action result manifests
<user-cache>/maligator/v1/blobs/sha256/  immutable content-addressed outputs
<user-cache>/maligator/v1/frontend/      serialized VM definitions
<user-cache>/maligator/v1/thinlto/       the linker's ThinLTO code generation cache
<user-cache>/maligator/v1/toolchains/    tool identity and capability probes
<user-cache>/maligator/v1/work/          disposable compiler/Cargo scratch
<project>/.cache/mal-build/development/  generated C and development executables
<project>/.cache/mal-build/production/   generated C and production executables
```

The user cache follows the platform convention (`~/Library/Caches` on macOS,
`$XDG_CACHE_HOME` or `~/.cache` on Linux, and LocalAppData on Windows);
`MALIGATOR_CACHE_DIR` replaces `<user-cache>/maligator` as a whole. Cache keys include relevant source content, producer protocol,
normalized feature config, target, selected toolchain identity, build environment,
and exact compile or Cargo arguments. Package semver is recorded as metadata, not
used as a blanket invalidation key.

Normal builds restore cached VM definitions before generated-C emission, skipping
unchanged graph, semantic, optimization, allocation, and lowering work while
preserving native-code metadata. Generated translation units and the driver are then
compiled to independently content-addressed objects; unchanged objects are relinked
without invoking their C compilation again. A generated unit (including the eval
compiler overlay) is keyed by its expanded body plus the expanded header
declarations that body can reach, so a runtime header edit only recompiles units
that use what changed. Intrinsic slots are declared in every build for the same
reason: eval-enabled feature sets that share a realm layout share one overlay.
Pragmas, emitted definitions, and anything the slicer cannot classify are always
part of the key, and builds that emit debug line tables key the whole expansion
instead. A memo keyed by the raw unit and header contents means a
warm build never preprocesses its units. Embedded bytes (configured assets, and the
images of a development build) live in header-free units keyed by their text and the
embedded files' content digests. These units are never preprocessed: an expansion
spells each byte out as a C literal, and a few megabytes of data would exceed the
string limit of the engine the product CLI runs on. An asset or image object is
reused until its bytes change.

Definitions are assigned to deterministic, edit-local hash partitions with a 2 MiB
soft target and an 8 MiB hard limit for an indivisible definition. A function's
partition key names its source file relative to the project directory, so a project
compiled from another location keeps its units. Code and data units remain separate,
and worker count affects only scheduling. Application functions (project sources
outside `node_modules`) get their own code units, so an edit to an application
function body leaves the dependency objects cached. Compiled bodies are named after
their partition keys and read every image index (function, global, string, BigInt
and template) from a link table in separate data units, so adding or removing a
function recompiles only the code units that hold the changed functions. Normal
output reports frontend, generated-C, toolchain, and native cache hit/miss status
plus the final executable path.

C and Rust outputs are published as immutable blobs only after compilation succeeds;
an atomic action manifest makes the result visible. Runtime GC stress/verification
flags are execution inputs and reuse the same binary. Build-affecting sanitizer, GC,
feature, backend, optimization, target, and toolchain dimensions get distinct action
keys. Within those dimensions, each runtime C object is keyed by its actual
preprocessed input, so a feature change recompiles only translation units whose code
changed. Feature-specific Rust archives share a serialized Cargo target tree and
therefore reuse unaffected dependency work. Final products stay statically linked and
self-contained. Test/program verdicts and benchmark measurements are always executed
and are never cache entries.

Removing `.cache/mal-build` forces project output materialization without discarding
reusable artifacts. `maligator cache status` and `maligator cache prune --dry-run`
inspect the user cache; `maligator cache clear --all` is an intentional full reset.
Normal identity changes invalidate affected actions automatically.
