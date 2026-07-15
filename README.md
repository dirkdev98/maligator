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

Until compiler assets are packaged with `Mal.embed`, the source-built CLI expects
the Maligator checkout's repository-relative `runtime/` and `src/` assets to be
available from the working directory. The self-host integration runs from this
checkout for that reason. This restriction will be removed when compiler assets
become self-contained.

## Commands

```text
maligator init
maligator doctor [--verbose]
maligator build [entry] [--production] [--config path]
maligator run [entry] [--config path] [-- args...]
```

The working directory is always the project root. Relative entries and `--config`
paths are resolved from it; Maligator does not search ancestor directories. An
explicit entry overrides `config.entry`. Without a config, an explicit entry uses
the conservative product defaults. `build` and `run` fail with an `init` suggestion
when neither source supplies an entry.

`run` builds in development mode, forwards every argument after `--` without
re-parsing it, and propagates the executable's exit status or terminating signal.
Use `build --production` and launch the reported binary directly for production.

Use `maligator --help` and `maligator --version` for command help and version output.
Unknown options, missing option values, and extra positional arguments are errors.

## Configuration

`maligator.build.ts` is executable, trusted TypeScript configuration. It is stripped
in place, evaluated on every command invocation, and strictly validated after
evaluation. Ordinary locals, functions, conditions, and environment reads are
allowed. The only supported import is `defineBuild` from `maligator`:

```typescript
import { defineBuild } from "maligator";

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

All fields are optional. Product defaults are:

| Field                   | Default    | Meaning                                                                   |
| ----------------------- | ---------- | ------------------------------------------------------------------------- |
| `entry`                 | none       | Project-relative entry module                                             |
| `outputName`            | inferred   | Safe single-component executable name                                     |
| `assets`                | `{}`       | Unconditionally embedded file and directory resources                     |
| `engine.eval`           | `false`    | Include `eval`, `Function`, and the baked compiler                        |
| `engine.realms`         | `false`    | Include Realm support                                                     |
| `engine.regexp`         | `true`     | Include the RegExp engine                                                 |
| `engine.intl.enabled`   | `false`    | Include Intl and ICU4X data                                               |
| `engine.intl.features`  | `[]`       | All Intl services when Intl is enabled; a non-empty list selects services |
| `engine.intl.languages` | `[]`       | All locales; locale subsetting is not implemented yet                     |
| `host.scheduler`        | `"single"` | Host scheduler selection; multiprocessing is reserved                     |
| `surface.webPlatform`   | `false`    | Include the WinterTC/web host surface                                     |
| `surface.node`          | `false`    | Include Maligator's curated `node:*` compatibility surface                |
| `surface.maligator`     | `true`     | Include the Maligator host surface                                        |

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
		compilerWire: { type: "file", path: "runtime/src/compiler.malw" },
		runtime: {
			type: "directory",
			path: "runtime",
			include: [
				"CMakeLists.txt",
				"src/**",
				"rust/Cargo.toml",
				"rust/Cargo.lock",
				"rust/rust-toolchain.toml",
				"rust/src/**",
				"rust/include/**",
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

Every native build performs the same discovery and capability checks used by
`doctor`; running `doctor` first is optional. Maligator requires:

- CMake
- A C compiler and archive tool with C2x compile/link support
- Rustup and the `cargo`/`rustc` selected by `runtime/rust/rust-toolchain.toml`
- A C++ compiler/runtime only when `surface.webPlatform` is enabled

`CC` and `CXX` override compiler selection. Otherwise tools are resolved strictly
from `PATH`. `maligator doctor --verbose` reports resolved paths, versions, C and
Rust targets, tested capabilities, and probe-cache status.

On macOS, install Apple build tools with `xcode-select --install` and CMake with
Homebrew if needed. On Debian/Ubuntu, install `build-essential` and `cmake`; on
Fedora/RHEL, install `gcc`, `gcc-c++`, `binutils`, and `cmake`. Install Rust through
Rustup, then enter `runtime/rust` and run `rustup show` to install/select the pinned
toolchain.

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
.cache/mal-cache/runtime/       C runtime archives
.cache/mal-cache/rust/          keyed Rust static libraries
.cache/mal-cache/cargo/         Cargo downloads/cache
.cache/mal-cache/compiler-wire/ baked eval compiler definitions
.cache/mal-build/development/   generated C and development executables
.cache/mal-build/production/    generated C and production executables
```

Cache keys include relevant source content, resolved feature config, build mode,
target, selected toolchain identity, and supported flags. Normal output reports
toolchain and cache hit/miss status plus the final executable path. Removing
`.cache/mal-build` forces project output regeneration; removing a specific
`.cache/mal-cache` subtree forces that reusable artifact to be reprobed or rebuilt.

## Troubleshooting

- `no entrypoint ... run 'maligator init'`: add `entry` to the config or pass an explicit entry.
- `config file not found`: `--config` is relative to the current project root; no ancestor search occurs.
- `node:* ... surface.node is disabled`: set `surface.node: true` only for programs needing the curated Node surface.
- `eval is disabled`: set `engine.eval: true`; this increases binary size and disables whole-program dead-code elimination around dynamic code.
- `RegExp is disabled`: remove `engine.regexp: false` or avoid regular expressions.
- `Toolchain is not ready`: run `maligator doctor --verbose`, check `CC`/`CXX`, `PATH`, and the platform-specific installation suggestions.
- A stale or suspect native artifact: remove the relevant directory under `.cache/mal-cache` and rebuild; cache identity changes normally invalidate it automatically.
- A pre-embed source-built CLI cannot find `runtime/CMakeLists.txt` or compiler sources: run from a Maligator checkout containing the repository-relative assets described above.

## Development

```shell
npm install

# Run the Node-hosted product CLI while working on the compiler.
node ./src/index.ts build path/to/entry.ts

# Tests (unit = pure TypeScript; native = linked isolate binaries).
npm test run
npm run test:unit
npm run test:native

# Product CLI self-host integration with Node removed from PATH.
npm run selfhost:cli

npm run type-check
npm run lint
npm run bench

# Curated Test262 regressions; the full suite is intentionally expensive.
npm run test262:regressions
npm run test262
```

## Structure

- `docs/decisions`: architecture decisions
- `runtime`: C runtime and Rust FFI shim
- `src`: compiler, CLI, and build tooling
- `tests`: unit and native integration coverage

ECMAScript reference: [ECMA-262](https://tc39.es/ecma262/multipage/).
