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
root for config, entries, and output caches. Asset specifiers resolve from their
declaring modules. The command layer passes absolute installation paths to native
stages so they can find runtime files independently of the application.

The self-hosted CLI embeds the runtime C sources and Rust crate in `runtime`, with a
prebuilt eval compiler in `compilerWire` (`src/product-builder.ts`). It materializes
these resources when the command needs them. A local native link requests the
compiler wire when it enables eval. `npm run selfhost:cli` exercises a copied CLI
outside the checkout without Node.js.

## Packaged runtime

Each npm platform package includes runtime archives and runners for the default
development flavour, with locked primordials and realms disabled. The launcher
passes the platform package's `runtime-libraries` directory to the native CLI and
its compiler workers. Portable keys cover the sources, target and ABI baseline,
native flags, and pinned Zig producer.

The CLI verifies SHA-256 digests before using packaged files. It executes a matching
runner directly. A local development link can import matching archives under its
local cache keys. Production imports the machine-code Rust, Ada and ring archives
using a separate key for the Rust sources and target ABI. The CLI embeds the C
sources so production builds can compile the C archives with the selected
compiler's LTO settings and optimize across the generated application and its
runtime. Linking the packaged machine-code C archives increases the instruction
count and reduces Express throughput.

Missing or mismatched files fall back to local builds. A local build with
`engine.eval: true` builds the eval component from the compiler wire. Use
`MALIGATOR_PREBUILT_RUNTIME_DIR` to test a different runtime directory and
`--verbose` to see which archives a command uses.

## Toolchain discovery

Native builds use the compiler and capability checks shown by `doctor`. `CC` and
`CXX` override compiler selection. When the default C toolchain cannot build a
production executable, the CLI tries Zig and then installs its pinned Zig release
in the user cache. `doctor` reports whether the next build will download Zig.
The installer verifies the archive's pinned SHA-256 before extraction.

Local runtime builds compile translation units with the selected C compiler and
collect them into static archives with `ar`. A prebuilt Rust archive skips Rustup
and Cargo discovery. A local Rust build uses the toolchain selected by
`runtime/rust/rust-toolchain.toml` and compiles the Ada URL parser with C++.

The C toolchain probe requires the C23 keywords, `#embed` and `__builtin_assume`
used by the runtime.

Discovery, normalized feature booleans, build plan, installation roots, environment
snapshot, and cache root are frozen into one `NativeBuildContext`
(`src/native-build-context.ts`). The C archive, Rust archive, and final linker consume
that same context. The final linker returns a typed result containing the executable
path, exact artifact bundle, and context, so callers such as size tracking cannot
accidentally resolve and measure a different build.

Applications that need the event loop link `host_main.c`. It applies the image's
host installers and drives the loop. This includes applications with a Node or Web
personality and applications that use workers or filesystem I/O without one.
Synchronous applications can link the smaller `test262_main.c` driver.

## Cross builds

An explicit `build --target <rust-triple>` cross-builds through Zig. Maligator maps
the Rust triple to Zig's target syntax and
uses `zig cc`, `zig c++`, and `zig ar` for the C runtime, Cargo native dependencies,
and final link; optional production stripping is applied by `zig cc` during that
link. Cross-built outputs live under `.cache/mal-build/<mode>/<rust-triple>/`;
`maligator run` remains a native-host command.

## Build modes

Development builds use `-O2`, keep symbols, and do not use LTO. They are intended for
normal iteration and useful native crash diagnostics.

A development build links the dependency images `run` loads plus one application
image instead of one whole program. Each image gets a relocatable native overlay that
depends only on that image, and the binary splices the embedded images at startup, so
an application edit recompiles only the application's objects. `run` and `dev` split
the application further, into images of a few modules each, so an edit recompiles only
its own image, and the images that import it only when its exported names change.

Images link the way modules do. An image publishes the bindings of the modules later
images import, and the loader aliases each import to that slot while it splices
(`runtime/src/module_links.c`). So an import stays a live binding and a namespace object
is shared between images. An image evaluates only after the images before it have
settled, top-level await included. A dependency edit that keeps its exported names leaves
the application image cached. Note that `require` and `import()` across an image boundary
still compile one whole program. Code does not optimize across images,
so measure throughput separately from whole-program development builds.
Embedded assets and each image's bytes go in units of their own, so
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

## Builtin lookup

Use a literal specifier in a `process.getBuiltinModule` call in your application
source to link that builtin. A computed name can find a builtin already available
in the program. It returns `undefined` when the module is unavailable. Import
the module's default export or add a literal call when a computed name needs it.
The `node:module` API can load fresh builtins through `createRequire`.

## Development runner

`run`, `dev`, and `test` skip toolchain discovery when a packaged runner matches
the configuration and the project has no C bindings. `test --watch` can use the
same runner to host test applications. Mutable primordials need a local runner.
When shipped Rust archives match the host, the local build compiles only C.
The linked-binary cache gives projects
with the same runtime flavour and toolchain one executable. The runner resolves
installers by name so it can use different host and language components in each
image. It links Ada and the C++ runtime so it can load images that parse URLs. Each
image records its own RegExp and eval policy. A runner for `engine.eval: true` also
links the eval compiler. Compiler defines that change native code enter the cache key.

The shared runner loads C bindings from cached shims before it loads any images.
Building a shim needs Clang. Set `CC` to its executable if the CLI cannot find it.
Each shim links its library and supplies an installer to the runner.
Its cache key covers the contract, headers, library sources and files, compiler, and
FFI runtime interface. If a library needs the executable link, Maligator links the
project's libraries together in a local runner. `maligator ffi check` reports the
reason. Executables produced by `build` link their bindings directly.

## Language components

Temporal and the Intl services are compiled into every runtime archive. A program
links one only when the engine policy allows it and the program can reach it: the
compiler lists the component's installer in the image's host manifest
(`src/compiler/frontend/engine-components.ts`), that reference links the component's
own translation unit, and realm initialization installs each selected component
before the primordials lock (`runtime/src/language_components.h`). Runtime eval, a
global object handed to unknown code, and every image of a linked development build
retain all allowed components; a member read by an unknown key retains Temporal and
the services behind the locale-sensitive methods. Without a component, those methods
use the locale-insensitive behaviour ECMA-402 allows. Drivers that load wire images,
such as the development runner, link every component their engine policy allows,
since those images name components only by installer name.

## Engine policy and eval

`engine.regexp` and `engine.eval` leave the C runtime archive unchanged, so every
configuration of a flavour shares one archive. The compiler records the policy in the
image header (`MalEnginePolicy` in `runtime/src/vm.h`), and the isolate started from
that image enforces it. Without RegExp, `%RegExp%` is not installed and every way to
create a RegExp object throws a TypeError. Without eval, eval and the Function
constructors throw an EvalError. The RegExp engine still links by use.

The baked eval compiler is a component of its own (`runtime/src/eval`): an archive of
the compiler wire, its native overlay, and the unit that registers them, keyed by the
runtime archive and the compiler wire. Only `engine.eval: true` links it. Code
compiled at run time carries no host manifest, so that link also names the
normalization engine and, when the policy allows it, the RegExp engine.

## Rust archive

Native builds compile the Rust crate once with every Cargo feature and the release
profile's fat LTO into one codegen unit. Every link passes the linker's
unused-section flag (`-dead_strip` or `--gc-sections`), so a binary keeps only the
Rust functions and data its C runtime references. Disabled Intl services, TLS and
codecs never reach the binary, while one codegen unit keeps shared Rust code from
being duplicated. Where that flag works on ELF targets, runtime C objects compile with
`-ffunction-sections -fdata-sections` too, so section removal works per function
there as Mach-O's per-symbol sections do.

Native builds publish Ada and ring beside the Rust archive. A link from fixed
images selects Ada and its C++ runtime from the application and worker installer
lists. Shared runners and linked development builds that resolve installers by name
include Ada. Ada's static initializers and ring's assembly objects can stay live
once their archives enter the link.

The macOS package uses the C++ runtime supplied by the link driver. Apple Clang
links system libc++ and Zig supplies its own libc++.

Linux prefers LLD when the compiler can use it. GNU ld can require both
components before discarding unused sections, so its fallback links both.
Without the host personality, that fallback uses a static C++ runtime when the
capability probe succeeds. Wasm builds compile only the configured features.

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
`MALIGATOR_CACHE_DIR` replaces `<user-cache>/maligator` as a whole. Cache keys include
relevant source content, producer protocol, normalized feature config, target, the
identity of the tools that produce the artifact, build environment, and exact compile
or Cargo arguments. A C object depends only on the C compiler, so toolchains that
differ in their C++, archive or link tools share compiled objects. Package semver is
recorded as metadata, not used as a blanket invalidation key.

`maligator build --print` writes generated C to stdout and stops before native
compilation, linking, or artifact publication. Add `--production` to inspect the
optimized program. A subsequent build can reuse that frontend cache.

Parallel compiler roots hand off generated artifacts through an owned temporary
directory, keeping their byte size out of worker message budgets. After the workers
join, the parent verifies sizes and digests and restores the images before releasing
the files. Returned images remain usable after the compilation closes.

Normal builds restore cached VM definitions before generated-C emission, skipping
unchanged graph, semantic, optimization, allocation, and lowering work while
preserving native-code metadata. Cache validation includes the resolver's file-kind
and package-identity observations, so newly preferred paths invalidate a warm build
without reparsing an unchanged graph. Owner and worker observations must still agree
when compiled images are published. An ordinary production build can reuse emitted
C for the same compiler images, worker entries, and asset snapshots. Build producers
still run and assets are collected before source reuse, so an asset-only edit reaches
the executable. Generated units and the driver use independently content-addressed
objects, which avoid repeated C compilation. The product CLI writes each root's
generated units before emitting the next root or preparing native runtime artifacts.
Only file identities and unit metadata remain live during runtime preparation.
Development overlays cache each unit's C source separately from its metadata. Total generated output can
exceed the host engine's string limit without serializing one aggregate string
or expanding C source through JSON escaping. A generated unit (including the eval
compiler overlay) is keyed by its expanded body plus the expanded header
declarations that body can reach, so a runtime header edit only recompiles units
that use what changed. Intrinsic slots are declared in every build for the same
reason: eval-enabled feature sets that share a realm layout share one overlay.
Pragmas, emitted definitions, and anything the slicer cannot classify are always
part of the key. Debug builds and large preprocessed inputs stream a hash of the
whole expansion instead. A memo keyed by the raw unit and header contents means a
warm build never preprocesses its units. Embedded bytes (assets, and the
images of a development build) live in header-free units keyed by their text and the
embedded files' content digests. These units are never preprocessed: an expansion
spells each byte out as a C literal, multiplying its processing and storage cost.
An asset or image object is reused until its bytes change.

Definitions are assigned to deterministic, edit-local hash partitions with a soft
scheduling target. An indivisible definition may exceed it. Native functions
above the compilation cost budget retain their bytecode entry; this budget does
not reject valid programs or data. Generated source, cache restoration, printing
and hashing use chunks rather than aggregate strings. A function's
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
preprocessed input, and compilation consumes that captured input. A runtime source
change during preprocessing aborts the build before publishing objects, so concurrent
edits cannot pair a cache key with different compiler input. Feature changes recompile
only translation units whose code changed. The native Rust archive is keyed by its
sources, target, tools and build environment, not by the feature configuration, so
every configuration shares it. Final products stay statically linked and
self-contained. Test/program verdicts and benchmark measurements are always executed
and are never cache entries.

Removing `.cache/mal-build` forces project output materialization without discarding
reusable artifacts. `maligator cache status` and `maligator cache prune --dry-run`
inspect the user cache; `maligator cache clear --all` is an intentional full reset.
Normal identity changes invalidate affected actions automatically.
