# Engine-only WebAssembly

Maligator can build a synchronous engine reactor for `wasm32-wasip1`, using WASI SDK
34.0 and the Rust toolchain pinned in `runtime/rust/rust-toolchain.toml`.
This is the compiler host used by the website explorer. The ordinary native CLI's
macOS/Linux executable targets remain separate.

Install [WASI SDK](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34),
set `WASI_SDK_PATH` to its extracted directory, and install the pinned Rust target:

```sh
export WASI_SDK_PATH=/path/to/wasi-sdk-34.0-your-platform
cd runtime/rust
rustup target add wasm32-wasip1
```

The C compiler must use LLVM 23 or newer. Earlier LLVM versions can exhaust memory
in the WebAssembly irreducible-control-flow pass when compiling the Explorer's
large generated functions; LLVM 23 includes the
[reachability fix](https://github.com/llvm/llvm-project/commit/0a76568db07ec7f5469aa189e10283980e609ef6).
The SDK release is pinned together with its runtime notices in
`runtime/vendor/wasi-sdk/COPYRIGHT`, since its binary archives omit those files.

From the repository root, after the environment and activity checks in `AGENTS.md`:

```sh
npm run wasm:doctor
npm run wasm:build
```

The doctor compiles and runs a small C23 reactor. The build emits
`.cache/wasm/explorer.wasm` and its identity manifest. `--entry`, `--config` and
`--output` select another embedding entry, build config and output path. For example:

```sh
npm run wasm:build -- --entry example.mts --output .cache/wasm/example.wasm
```

The default host profile has locked primordials and RegExp enabled. Eval, realms,
Intl, Temporal, web/Node/Maligator host surfaces and embedded assets must be disabled.
Unsupported host configurations fail before compilation. Snippet compilation settings
are independent: the compiler can describe native programs with capabilities that
its own engine host does not install.

The build shares the normal compiler, feature derivation, cache leases and verified
artifact store. Its source, C object, archive, Rust library and link stages have
separate producer identities. Source generation includes the entrypoint, module
goals and resolved edges, compiler implementation and resolved parser bundle.
Equivalent checkouts share generated C; programs using `import.meta` or CommonJS
retain their observable module paths in the identity.

C objects include their source, headers and generated `.inc` files, normalized
runtime paths, command flags and toolchain identity. A change to one runtime C
body does not invalidate every other object. Linking keys include the ordered
input digests and complete link recipe. Changes to logging or timeouts do not
invalidate these artifacts; changes to output behavior not expressed by the recipe
require a stage protocol bump.

Compatible Rust feature builds reuse a locked Cargo target under `work/wasm-rust`.
The target identity includes Rust sources, manifests, toolchain and build options;
each feature selection publishes its own immutable library. Build worker counts
do not affect artifact identity. Successful action scratch is removed, while failed
builds retain command logs under `work/wasm`. No source patching is used.
The default maximum linear memory is 256 MiB, including a 16 MiB C stack. General
stackful scheduling, native process APIs and Wasm threads are unsupported.

## Embedding ABI, version 1

Instantiate the module with WASI preview-1 imports and initialize its reactor before
calling `mal_wasm_init`. Browser consumers bundle a WASI shim; Node checks use
`node:wasi`. Filesystem preopens are unnecessary. The TypeScript `WasmEngine` in
`src/wasm-embedding.ts` handles allocation, memory-view refresh, output ownership,
status decoding and disposal.

An entry installs named functions on `globalThis`. Each call accepts one UTF-8 string
argument and returns a value converted to a UTF-8 string. The explorer uses JSON at
this boundary and does not execute submitted programs.

| Export                                                | Contract                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `mal_wasm_abi_version()`                              | Returns 1.                                                                                                    |
| `mal_wasm_init()`                                     | Executes the compiled entry once; returns status.                                                             |
| `malloc(bytes)`, `free(pointer)`                      | Caller-owned input buffers in linear memory.                                                                  |
| `mal_wasm_call(name, nameLength, input, inputLength)` | Calls the named global with a string; returns an engine-owned output pointer.                                 |
| `mal_wasm_output_length()`                            | Output byte length, without a trailing NUL.                                                                   |
| `mal_wasm_status()`                                   | 0 success, 1 JavaScript exception, 2 invalid state/diagnostic conversion failure, 3 allocation or size limit. |
| `mal_wasm_release()`                                  | Frees output; the next call also releases the previous output.                                                |
| `mal_wasm_collection_count()`                         | Collection counter when runtime GC statistics are enabled.                                                    |
| `mal_wasm_dispose()`                                  | Releases output and VM state.                                                                                 |

Inputs must point to valid, caller-allocated buffers until the call returns. Names
are 1–256 bytes, input is at most 512 KiB, and output is at most 8 MiB. The explorer
separately limits source to 64 KiB before JSON encoding. Refresh all typed-array views
after allocation or calls because memory growth can detach earlier views. Copy the
output before releasing it. A trap or unrecoverable allocation failure requires a
fresh instance; the browser obtains one by replacing its worker. Recoverable JavaScript
exceptions leave the engine usable for subsequent calls.

Runtime portability preserves the main fiber's GC roots and lifecycle while omitting
native stack switching. Optional process-CPU profiling, POSIX signal controls and
page-release hints are unavailable. Normal GC, stress collection and verification
remain active. The tests exercise errors, recovery, limits and actual collections.

## Website compiler explorer

`npm run site:build` builds the compiler reactor, bundles the browser UI and worker,
and embeds their assets into the standalone website binary. It requires the pinned
Wasm toolchain described above. The compiler's 35.5 MB Wasm module is embedded only
as its roughly 4 MB Brotli representation. Asset URLs include content hashes and
use immutable caching, strong validators, and `application/wasm` with
`Content-Encoding: br`. The native server only serves assets named in its embedded
manifest. The browser needs HTTPS or localhost and Brotli support.

Run the binary path printed by the build with `SITE_HOST=127.0.0.1 PORT=3000`, then
open `http://127.0.0.1:3000/explorer`. Compilation uses the same compiler pipeline as
`npm run explore:outputs`; snippets are neither executed nor sent to the server.
All eleven examples use the editable-source path. The worker exposes no filesystem
preopens, network callbacks, or host runtime surfaces. Enabling a snippet's build
settings changes compiler policy and generated output; it does not enable imports
or those features in the compiler's own runtime.

The page retains up to eight results within a conservative 16 MiB cache budget,
keyed by exact source, normalized configuration, schema, and compiler identity.
Source is limited to 64 KiB UTF-8 and serialized output to 8 MiB. Loading has a
30-second deadline; compilation has a 10-second deadline. Cancellation or timeout
terminates the worker. Its Wasm memory is capped at 256 MiB; completed workers are
recycled at 128 MiB or after five idle minutes. The compiled module and result cache
can survive worker recycling. Output panes render at most 300 lines per page;
copy/download actions use the complete selected stage.

After `npm run wasm:build`, `npm run wasm:check` compares complete serialized stage
outputs against the Node-hosted compiler for every builtin and additional policy,
error-recovery, Unicode, and medium-size cases. `npm run wasm:check -- --stress`
repeats them with GC verification and counted collections. Reports are written to
`.cache/explorer-parity.json` and `.cache/explorer-parity-stress.json`. Browser
lifecycle and HTTP-policy tests are ordinary unit tests; the reactor ABI integration
is in the full-only unit lane and can be selected directly. Full Test262 and full
gates remain separate checks.

The homepage's server size is the actual executable length minus every embedded
asset payload listed by the build configuration, including the compressed Wasm,
HTML, scripts, styles, and license notices. Asset descriptors, alignment, and the
serving implementation remain part of the server size. `website/site-meta.json`
retains both the complete binary length and the excluded asset-byte total.

The explorer strips erasable TypeScript automatically before parsing. Paste JavaScript
or TypeScript into the same editor; both follow the same five compiler stages. Types
are not checked, and enums or parameter properties requiring JavaScript generation
are rejected. Type-only imports disappear; runtime imports remain unavailable in the
single-file explorer. Source downloads use `.ts`, which also accepts JavaScript.
