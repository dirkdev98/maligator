# Maligator

A lean ahead-of-time JavaScript-to-C compiler and runtime. Maligator produces a
standalone native executable and keeps optional engine and host surfaces out of
builds that do not request them.

## Quick Start

Run commands from the project root:

```shell
maligator init
maligator doctor
maligator build
maligator run -- first-argument "two words"
```

`init` creates `maligator.build.ts` without overwriting an existing file. It selects
the first entry that exists from `src/index.ts`, `src/main.ts`, `index.ts`, and
`main.ts`; if none exists, it writes `src/index.ts` as the starting point.

The source-built CLI resolves its runtime tree and eval compiler from its own module
installation, not from the working directory. The distributed product CLI instead
embeds and materializes those resources, so it is self-contained. In both cases the
working directory remains the application project root for config, entries, assets,
and output caches. Compiler installation roots are explicit absolute paths passed into
the command layer; native stages do not infer runtime ownership from the application.

## Commands

```text
maligator init
maligator doctor [--verbose] [--target rust-triple]
maligator build [entry] [--production] [--artifact directory] [--target rust-triple] [--config path]
maligator run [entry] [--config path] [-- args...]
maligator dev [entry] [--config path] [-- args...]
maligator test [path ...] [--run name] [--shuffle [seed]] [--repeat count] [--bail]
```

The working directory is always the project root. Relative entries and `--config`
paths are resolved from it; Maligator does not search ancestor directories. An
explicit entry overrides `config.entry`. Without a config, an explicit entry uses
the conservative product defaults. `build` and `run` fail with an `init` suggestion
when neither source supplies an entry.

`run` compiles to a portable development image and executes it in a fresh VM using
the runtime embedded in the distributed platform CLI. The single-process,
asset-free, Intl-disabled development profile does not require a C or Rust
toolchain. It forwards every
argument after `--` without re-parsing it and propagates the application's exit
status or terminating signal.

`dev` keeps the compiler session alive, watches the application dependency graph,
and restarts a fresh VM after each successful rebuild. Project files are checked
at interactive cadence while dependencies under `node_modules` are checked less
frequently. A compilation error leaves the watcher running so the next edit can
recover. This is process restart, not in-process hot-module replacement.

Use `build --production` and launch the reported binary directly for production.
Adding `--artifact <directory>` creates a deployable artifact and therefore requires
`--production`. The destination must be absent or empty. Its build-owned layout is:

```text
artifact/
├── artifact.json
├── LICENSE
├── SHA256SUMS
└── bin/
    └── <application>
```

The manifest records the Maligator version, Rust target triple, production status,
binary size, and SHA-256 digest. Release tooling may archive this directory but does
not reconstruct its contents.

Use `maligator --help` and `maligator --version` for command help and version output.
Unknown options, missing option values, and extra positional arguments are errors.

## Application tests

`maligator test` is an interpreter-only toolchain path. It discovers
`*.test.{js,mjs,ts,mts}` and `*.spec.{js,mjs,ts,mts}`, loads a shared dependency
base plus independently cached registration fragments, and runs them in the
interpreter already embedded in the Maligator executable. It never emits C or
invokes a native compiler/linker. The content-addressed cache stores frontend
wire artifacts, not successful results; every selected test executes on every
command.

```typescript
import { beforeEach, describe, expect, test } from "maligator:test";
import { createStore } from "./store.ts";

describe("store", () => {
	let store: ReturnType<typeof createStore>;

	beforeEach(() => {
		store = createStore();
	});

	test("returns inserted values", () => {
		store.set("answer", 42);
		expect(store.get("answer")).toBe(42);
	});

	test("loads asynchronously", async () => {
		store.set("answer", 42);
		await expect(store.load("answer")).resolves.toEqual(42);
	});
});
```

The initial API includes nested suites; `beforeAll`, `afterAll`, `beforeEach`, and
`afterEach`; synchronous and async callbacks; `skip`, `todo`, `only`, and `each`;
scalar/structural/throw matchers; `.not`, `.resolves`, `.rejects`; and the
`any`, `anything`, `stringMatching`, `objectContaining`, and `arrayContaining`
asymmetric matchers. A focused `.only` run prints a warning.

Selections are stable and serial by default. `--run` filters hierarchical names,
`--shuffle` reports its reproducible seed, `--repeat` reruns the registered suite
without recompiling, and `--bail` opts out of the default complete policy. The MVP
uses one shared Realm/isolate across files; globals, intrinsic prototypes, host
state, and uncancelled async resources are therefore shared. Per-file Realm
isolation and worker scheduling are deferred rather than simulated.

## Configuration

`maligator.build.ts` is executable, trusted TypeScript configuration. It is stripped
in place, evaluated on every command invocation, and strictly validated after
evaluation. Ordinary locals, functions, conditions, and environment reads are
allowed. The only supported import is `defineBuild` from `@maligator/cli`:

```typescript
import { defineBuild } from "@maligator/cli";

const productionNodeSurface = process.env.MAL_NODE === "1";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "example",
	engine: {
		eval: false,
		realms: false,
		regexp: true,
		intl: {
			enabled: false,
			features: [],
			languages: [],
		},
	},
	host: { scheduler: "single" },
	surface: {
		webPlatform: false,
		node: productionNodeSurface,
		maligator: true,
	},
});
```

The npm package ships TypeScript declarations for this configuration and for
Maligator's runtime globals. Including `maligator.build.ts` in the TypeScript project
loads the global `mal.assets` and `Mal.serve` types. Projects that exclude the build
file can add `@maligator/cli` to `compilerOptions.types` instead. The declarations
describe optional surfaces even when a particular build disables them; the
configuration remains the runtime authority.

All fields are optional. Product defaults are:

| Field                   | Default    | Meaning                                                                                         |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `entry`                 | none       | Project-relative entry module                                                                   |
| `outputName`            | inferred   | Safe single-component executable name                                                           |
| `assets`                | `{}`       | Unconditionally embedded file and directory resources                                           |
| `engine.eval`           | `false`    | Runtime-disabled by default; `true` embeds the compiler; `"compile-check"` rejects visible uses |
| `engine.realms`         | `false`    | Include Realm support                                                                           |
| `engine.regexp`         | `true`     | Include the RegExp engine                                                                       |
| `engine.intl.enabled`   | `false`    | Include Intl and ICU4X data                                                                     |
| `engine.intl.features`  | `[]`       | All Intl services when Intl is enabled; a non-empty list selects services                       |
| `engine.intl.languages` | `[]`       | All locales; locale subsetting is not implemented yet                                           |
| `host.scheduler`        | `"single"` | Host scheduler selection; multiprocessing is reserved                                           |
| `surface.webPlatform`   | `false`    | Include the WinterTC/web host surface                                                           |
| `surface.node`          | `false`    | Include Maligator's curated `node:*` compatibility surface                                      |
| `surface.maligator`     | `true`     | Include the Maligator host surface                                                              |

Supported Intl feature names are `collator`, `number-format`, `date-time-format`,
`plural-rules`, `list-format`, `segmenter`, `display-names`,
`relative-time-format`, and `duration-format`. Unknown fields and values fail rather
than being ignored. A non-empty `engine.intl.languages` currently fails with an
actionable unsupported-feature diagnostic.

Configured assets are captured unconditionally in the native executable after the
trusted configuration has run. File paths resolve from the project root; directory
assets require explicit include patterns (`*`, `?`, and whole-segment `**`):

```typescript
export default defineBuild({
	assets: {
		compilerWire: { type: "file", path: "compiler.malw" },
		runtime: {
			type: "directory",
			path: "runtime",
			include: [
				"host_main.c",
				"test262_main.c",
				"src/**",
				"rust/Cargo.toml",
				"rust/Cargo.lock",
				"rust/rust-toolchain.toml",
				"rust/src/**",
				"rust/include/**",
				"vendor/llhttp/include/**",
				"vendor/llhttp/src/**",
			],
		},
	},
});
```

Every include pattern must match at least one regular file; symlinks and other
non-regular entries are rejected. At runtime, `mal.assets.materialize(name,
{ baseDirectory? })` writes the captured file or tree atomically and returns its
absolute path. `baseDirectory` defaults to the operating-system temporary directory.
The immediate child is `<content-hash>-<asset-format-version>` and a completion
marker makes repeat calls a cheap cache hit. A configured file returns its path
inside that directory; a configured directory returns the directory itself.

Assets require `surface.maligator` (enabled by default). They are native-executable
resources and are intentionally unsupported by portable `--serialize` output.

The output name is selected from `outputName`, then the unscoped portion of
`package.json#name`, then the working-directory basename. Names cannot be empty,
`.`/`..`, or contain path separators.

## Native Toolchain

The distributed CLI runs development images and application tests without these
tools. They are required when producing a standalone native binary with `build`.

Every native build performs the same discovery and capability checks used by
`doctor`; running `doctor` first is optional. Runtime translation units are compiled
directly with `CC` and collected into three static archives with `ar`. Maligator
requires:

- A C compiler and archive tool with real C23 support — the runtime uses the
  `bool`/`true`/`false` keywords (no `<stdbool.h>`), `nullptr`, and `#embed`, so
  Apple clang, clang >= 19, or gcc >= 15 works; gcc <= 14 accepts `-std=c2x` but
  lacks `#embed` and is rejected by the `doctor` C2x probe
- Rustup and the `cargo`/`rustc` selected by `runtime/rust/rust-toolchain.toml`
- A C++ compiler/runtime only when `surface.webPlatform` is enabled

`CC` and `CXX` override compiler selection. Otherwise tools are resolved strictly
from `PATH`. `maligator doctor --verbose` reports resolved paths, versions, C and
Rust targets, tested capabilities, and probe-cache status.

An explicit `build --target <rust-triple>` cross-builds through a detected Zig
installation. The initial supported targets are:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `aarch64-unknown-linux-gnu`
- `x86_64-unknown-linux-gnu`

Maligator maps the Rust triple to Zig's target syntax and consistently uses `zig
cc`, `zig c++`, and `zig ar` for the C runtime, Cargo native dependencies, and final
link; optional production stripping is applied by `zig cc` during that link. Install
the matching Rust standard library first with `rustup target add <rust-triple>`. Use
`maligator doctor --target <rust-triple> --verbose` to validate both halves of the
cross toolchain. Cross-built outputs live under
`.cache/mal-build/<mode>/<rust-triple>/`; `maligator run` remains a native-host
command.

Discovery, normalized feature booleans, build plan, installation roots, environment
snapshot, and cache root are frozen into one `NativeBuildContext`. The C archive,
Rust archive, and final linker consume that same context. The final linker returns a
typed result containing the executable path, exact artifact bundle, and context, so
callers such as size tracking cannot accidentally resolve and measure a different
build.

On macOS, install Apple build tools with `xcode-select --install`. On Linux, install
a C23-capable compiler and select it: on Debian/Ubuntu the stock `build-essential`
(gcc 12) is too old, so `sudo apt install clang-19` and build with
`CC=clang-19 CXX=clang++-19` (or use gcc >= 15 where available). Install Rust through
Rustup, then enter `runtime/rust` and run `rustup show` to install/select the pinned
toolchain.

The distributed self-hosted CLI embeds the runtime C sources, Rust crate, and a
prebuilt eval compiler wire. It materializes those content-addressed assets on
startup, so the copied compiler can run the full native pipeline outside a Maligator
checkout and without Node.js. `npm run selfhost:cli` exercises that transfer path.

## Alpha releases

The initial npm support matrix is macOS and glibc-based Linux on arm64 and x64.
Windows is deferred because the native host/runtime currently depends on POSIX APIs.
The first alpha binaries are unsigned; macOS artifacts are not notarized. Minimum OS
versions will be fixed after the release artifacts have run on the clean-host
validation matrix.

`@maligator/cli` is a small Node.js launcher with exact-version optional dependencies
on these native packages:

- `@maligator/cli-darwin-arm64`
- `@maligator/cli-darwin-x64`
- `@maligator/cli-linux-arm64`
- `@maligator/cli-linux-x64`

There is no source-build fallback. An unsupported host or installation without its
optional platform package fails with an actionable message.

Releases are local during the alpha phase. `package.json` is the version source of
truth; `src/version.ts` is generated and checked before building or publishing.
Every prerelease is published explicitly under the npm `alpha` dist-tag. The release
automation does not attempt to change or remove the registry's `latest` tag.

```shell
# Verify npm authentication before doing the expensive build.
npm whoami

# Prepare the next numeric alpha version.
npm run version:alpha

# Build and pack the default Apple Silicon macOS release.
npm run release:build
npm run release:smoke
npm run release:pack

# Commit the version and release preparation, then publish from a clean worktree.
npm run release:publish -- --confirm "$(node -p "require('./package.json').version")"
```

`release:publish` verifies every selected tarball against `packages.json`, publishes
the platform packages first, and publishes `@maligator/cli` last under the `alpha`
dist-tag. Each publish is a plain synchronous `npm publish` with the terminal's
stdin/stdout/stderr inherited, so enter the OTP directly when npm prompts. Build,
pack, and publish log per-target progress and elapsed time.

`release:build` and `release:pack` default to `aarch64-apple-darwin` so a local
release only builds Apple Silicon macOS. Pass `-- --all-targets` for the complete
matrix or `-- --target <rust-triple>` for one explicit target. Build and pack must
use the same selection. Packing a native-host target also installs the two tarballs
into a clean temporary project and verifies the installed launcher.

Applications with `surface.webPlatform: true` link `host_main.c`, which installs the
web globals and drives the host event loop. Non-web applications retain the lean
synchronous `test262_main.c` driver; the product CLI itself uses `host_main.c` for its
hosted command surface.

## Build Modes

Development builds use `-O2`, keep symbols, and do not use LTO. They are intended
for normal iteration and useful native crash diagnostics.

`maligator build --production` still uses `-O2`, adds compile/archive/link LTO when
the selected toolchain passes the LTO probe, and strips native symbols after linking
when the host strip probe succeeds. Unsupported LTO or stripping emits a warning and
continues with a valid `-O2` executable. Missing required C2x or C++ link capability
is a hard error. Stripping does not remove Maligator's own JavaScript source-position
tables.

## Cache Layout

Maligator keeps reusable inputs separate from project outputs:

```text
.cache/mal-cache/toolchains/    tool identity and capability probes
.cache/mal-cache/build-frontend/ portable normal-build frontend definitions
.cache/mal-cache/generated-c/   compiled generated-C and driver objects
.cache/mal-cache/runtime/       C runtime archives
.cache/mal-cache/rust/          keyed Rust static libraries
.cache/mal-cache/cargo/         Cargo downloads/cache
.cache/mal-cache/compiler-wire/ baked eval compiler definitions
.cache/mal-build/development/   generated C and development executables
.cache/mal-build/production/    generated C and production executables
```

Cache keys include relevant source content, normalized feature config, target,
selected toolchain identity, build environment, and exact compile or Cargo arguments.
Normal builds restore cached VM definitions before generated-C emission, skipping
unchanged graph, semantic, optimization, allocation, and lowering work while
preserving native-code metadata. Generated translation units and the driver are
then compiled to independently content-addressed objects; unchanged objects are
relinked without invoking their C compilation again. Normal output reports
frontend, generated-C, toolchain, and native cache hit/miss status plus the final
executable path. Removing
`.cache/mal-build` forces project output regeneration; removing a specific
`.cache/mal-cache` subtree forces that reusable artifact to be reprobed or rebuilt.

C and Rust artifacts are published only after validation and an atomic completion
manifest. Invalid C archive bundles are quarantined before rebuilding, and incomplete
Rust outputs are rebuilt before their completion manifest is replaced. Generated C
and the final executable remain project outputs, while reusable compiler-wire and
native artifacts remain under the explicitly selected cache root.

## Troubleshooting

- `no entrypoint ... run 'maligator init'`: add `entry` to the config or pass an explicit entry.
- `config file not found`: `--config` is relative to the current project root; no ancestor search occurs.
- `node:* ... surface.node is disabled`: set `surface.node: true` only for programs needing the curated Node surface.
- `eval is disabled`: the default `engine.eval: false` compiles the call site but throws if it executes. Set `true` to embed the runtime compiler, or `"compile-check"` to reject statically visible uses during the build.
- `RegExp is disabled`: remove `engine.regexp: false` or avoid regular expressions.
- `Toolchain is not ready`: run `maligator doctor --verbose`, check `CC`/`CXX`, `PATH`, and the platform-specific installation suggestions.
- A stale or suspect native artifact: remove the relevant directory under `.cache/mal-cache` and rebuild; cache identity changes normally invalidate it automatically.
- A custom self-hosted CLI reports a missing `runtime` or `compilerWire` asset: build it with the source-tree and prebuilt-wire asset set shown above.

## Development

Development requires Node.js 24 or newer, a C/C++ toolchain, and Rustup with the
pinned Rust toolchain.

```shell
npm ci

# Run the Node-hosted product CLI while working on the compiler.
node ./src/index.ts build path/to/entry.ts

# Default developer gate; smoke is its fast initial fuse.
npm run test:check

# Standalone 30-second warm / 60-second cold fuse.
npm run test:smoke

# Exhaustive gates. Ask before running either command: they include full Test262.
npm run test:full
npm run test:full:report

npm run type-check
npm run lint
npm run bench                         # compare only; never updates the baseline
npm run bench -- language --update  # update only the selected baseline lanes

# Complete standards reports without baseline updates. Ask before full Test262.
npm run test262:report
npm run test:wpt:report

# Targeted lanes remain available while developing.
npm run test:unit                 # watch mode
npm test run                     # one-shot unit and native projects
npm run test:native
npm run test:sanitize -- tests/native/example.test.ts
npm run test262:regressions

# Show tier policy and list exact stage commands without executing them.
npm run test:help
npm run test:check -- --list
```

See [`docs/testing.md`](docs/testing.md) for tier contents, fail-fast versus
completion policies, full-matrix coverage, and where new tests belong.

## Structure

- `docs/decisions`: architecture decisions
- `runtime`: C runtime and Rust FFI shim
- `src/compile-core.ts`: host-independent semantic-program to VM-definition compiler core
- `src/compile-program.ts`: module loading and compiler entrypoint orchestration
- `src/native-build-context.ts`, `src/runtime-build.ts`, `src/local-build.ts`: explicit native context, atomic reusable artifacts, and final linking
- `src/cli-commands.ts`: installation-aware command orchestration and web/non-web driver selection
- `src`: remaining compiler, CLI, and build tooling
- `tests`: unit and native integration coverage

ECMAScript reference: [ECMA-262](https://tc39.es/ecma262/multipage/).
