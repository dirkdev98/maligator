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
import { beforeEach, describe, expect, test } from "maligator:test";
import { createRouter, RouteError, type Router } from "./router.ts";

describe("router", () => {
	let router: Router;

	beforeEach(() => {
		router = createRouter();
	});

	test("matches parameters", async () => {
		await expect(router.match("/users/42")).resolves.toMatchObject({
			id: expect.any(Number),
		});
	});

	test("rejects malformed parameters", async () => {
		await expect(router.match("/users/nope")).rejects.toThrow(RouteError);
	});
});
```

By default, discovery includes `*.test.js`, `*.test.mjs`, `*.test.ts`,
`*.test.mts`, and the corresponding `*.spec.*` names. Pass files, directories,
or both:

```shell
maligator test
maligator test src/router
maligator test src/router/router.test.ts
maligator test --run "router > parameters"
maligator test --shuffle
maligator test --shuffle 18492
maligator test --repeat 10
maligator test --bail
```

`--run` filters hierarchical suite and test names. `--shuffle [seed]` changes
execution order reproducibly and always prints the seed. `--repeat` executes the
selected tests again while reusing unchanged compilation artifacts. The default
policy completes the selected suite; `--bail` stops scheduling after the first
failure.

The authoring API includes nested `describe` suites, `beforeAll`, `afterAll`,
`beforeEach`, `afterEach`, synchronous and promise-returning callbacks,
`test.skip`, `test.todo`, `test.only`, and `test.each`. A committed `.only`
focuses execution and prints a warning. Matchers include identity, structural
equality, truthiness, containment, length, string/regular-expression matching,
partial-object matching, throwing, `.not`, `.resolves`, `.rejects`, and the
`expect.any`, `expect.anything`, `expect.stringMatching`,
`expect.objectContaining`, and `expect.arrayContaining` asymmetric helpers.
Maligator owns this API and does not claim Jest, Vitest, or `node:test`
compatibility.

Test files currently execute serially in one Realm. Registration and lifecycle
state are separated by test file, but globals, prototypes, imported module
singletons, host state, and asynchronous work left running by a test can be
shared. Do not rely on process-per-file isolation.

Frontend bytecode is content-addressed by source, transitive dependencies,
resolved module identities, relevant build configuration, and compiler/runtime
format versions. A warm run restores a shared base plus independently cached
test-file registration fragments. Test results are never cached: every selected
test executes on every invocation.

The package ships documented declarations for `maligator:test`. Projects whose
TypeScript configuration does not include `maligator.build.ts` should load the
package declarations explicitly:

```json
{
	"compilerOptions": {
		"types": ["@maligator/cli"]
	}
}
```

## Build cache

Normal `maligator build`, `maligator run`, and `maligator test` commands share a
content-addressed portable VM definition store. On a valid hit, Maligator skips
parsing, module-graph construction, semantic analysis, optimization, register
allocation, and VM lowering. For the single-process, asset-free, Intl-disabled
development profile, `run` executes the restored definition with the isolated
runtime embedded in the platform CLI; it does not generate C or invoke a native
toolchain. Normal and production `build` commands emit
native translation units from the same restored definition. Those units and the native driver are
compiled into independently content-addressed objects, so unchanged objects can
be relinked without repeating C compilation. The final link still runs, and
native runtime and Rust archives remain separately content-addressed.

Build cache invalidation includes source and transitive dependency content,
package-resolution metadata, relevant configuration, the TypeScript erasure
frontend, and compiler/wire versions. Generated-object identity additionally
includes the exact C source, source identity, native headers/runtime artifact,
compiler/toolchain, target, flags, and build environment. Compiler diagnostic
dump flags deliberately recompile the frontend because they require live
semantic and IR objects.

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

`maligator test` and supported `maligator run` profiles use the development runtime
embedded in the platform CLI and do not require a native toolchain. Native `build`
commands—and development runs using bundled assets, Intl, or multiprocessing—require:

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
