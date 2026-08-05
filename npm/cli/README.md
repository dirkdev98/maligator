# @maligator/cli

[Maligator](https://github.com/dirkdev98/maligator) is a lean
ahead-of-time JavaScript-to-C compiler and native runtime. It turns a JavaScript or
erasable TypeScript entry point into a standalone native executable.

This package is the npm launcher for the prebuilt Maligator CLI. The project is
pre-1.0; install prereleases through the `alpha` channel.

## Install

Install the current alpha globally:

```shell
npm install --global @maligator/cli@alpha
```

Or keep it in a project and invoke it through `npx`:

```shell
npm install --save-dev @maligator/cli@alpha
npx maligator --version
```

The npm launcher requires Node.js 20 or newer. The native CLI and applications
produced by it do not require Node.js.

## Quick start

From the root of an application project:

```shell
maligator init
maligator doctor
maligator build
maligator run -- first-argument "two words"
```

`maligator init` creates `maligator.build.ts`. If it cannot find an existing entry
point, it also creates `src/index.ts`. `doctor` checks the native build toolchain,
`build` produces a development executable, and `run` builds and launches it while
forwarding everything after `--` to the application.

Useful commands:

```text
maligator --help
maligator --version
maligator init
maligator doctor [--verbose] [--target rust-triple]
maligator build [entry] [--production] [--artifact directory] [--target rust-triple] [--config path]
maligator run [entry] [--config path] [-- args...]
maligator test [path ...] [--run name] [--shuffle [seed]] [--repeat count] [--bail]
```

Run commands from the project root. Maligator does not search parent directories
for configuration.

## Testing

`maligator test` discovers conventional JavaScript and erasable-TypeScript test
files and runs them through Maligator's embedded interpreter. Test runs do not
generate C or invoke the native toolchain. Import the Maligator-owned API from
`maligator:test`:

```typescript
import { describe, expect, test } from "maligator:test";

describe("router", () => {
	test("matches parameters", async () => {
		await expect(Promise.resolve({ id: 42 })).resolves.toMatchObject({
			id: expect.any(Number),
		});
	});
});
```

Use `--run` for hierarchical-name filtering, `--shuffle [seed]` for reproducible
ordering, `--repeat` for repeated execution without recompilation, and `--bail`
to stop after the first failure. Frontend bytecode is cached by source and
transitive dependency content; test results are never cached.

## Production builds

Use production mode for a deployable binary:

```shell
maligator build --production
```

Production builds use optimized native compilation, add LTO when the toolchain
supports it, and strip native symbols when possible. To create a self-contained
artifact directory with a manifest, license, checksum, and binary:

```shell
maligator build --production --artifact dist/my-application
```

The artifact destination must be absent or empty. Launch the reported binary
directly; neither Node.js nor the Maligator CLI is needed at runtime.

## Configuration

`maligator.build.ts` is trusted TypeScript configuration. A small configuration
looks like this:

```typescript
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "my-application",
	engine: {
		eval: false,
		intl: { enabled: false },
	},
	surface: {
		webPlatform: false,
		node: false,
	},
});
```

All fields are optional. Maligator excludes optional engine and host surfaces unless
the configuration requests them. See the
[full configuration reference](https://github.com/dirkdev98/maligator#configuration)
for assets, Intl features, Node compatibility, web-platform support, and target
selection.

## TypeScript

The package includes declarations for `maligator.build.ts` and Maligator's runtime
globals. Keeping the generated build file inside your TypeScript project makes the
types available automatically:

```typescript
const path = mal.assets.materialize("templates", {
	baseDirectory: ".cache/my-application",
});

const server = Mal.serve({
	hostname: "127.0.0.1",
	port: 3000,
	async fetch(request) {
		return new Response(`Hello from ${request.url}`);
	},
});

console.log(path, server.port);
```

`mal` is present when `surface.maligator` is enabled. `Mal` and `Mal.serve` are
present when `surface.webPlatform` is enabled. The declarations describe both
optional surfaces, while `maligator.build.ts` controls which globals exist in the
compiled application.

If your `tsconfig.json` excludes `maligator.build.ts`, load the declarations
explicitly:

```json
{
	"compilerOptions": {
		"types": ["@maligator/cli"]
	}
}
```

## Build toolchain

The compiler CLI is prebuilt, but compiling an application requires:

- A C23 compiler and archive tool: Apple clang, clang 19 or newer, or GCC 15 or
  newer
- Rustup with the `cargo` and `rustc` toolchain selected by Maligator
- A C++ compiler/runtime only when `surface.webPlatform` is enabled

On macOS, install Apple command-line tools with `xcode-select --install`. On Linux,
install a recent compiler and set `CC` and `CXX` when it is not your system default.
Run `maligator doctor --verbose` for resolved tool paths, versions, capabilities,
and installation hints. The
[native toolchain guide](https://github.com/dirkdev98/maligator#native-toolchain)
has the full requirements and cross-compilation instructions.

## Alpha support

`0.1.0-alpha.1` provides native packages for macOS and glibc-based Linux on arm64
and x64. Later alpha releases currently default to Apple Silicon macOS; consult the
release notes before upgrading on another host. Windows is not supported.

There is no source-build fallback for the CLI package. The alpha binaries are
unsigned, and macOS binaries are not notarized. APIs, configuration, and supported
hosts may change before 1.0.

Please report problems through the
[Maligator issue tracker](https://github.com/dirkdev98/maligator/issues).
