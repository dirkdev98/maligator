/**
 * vitest globalSetup for the native lane. Builds the canonical and Node-enabled
 * runtime archive sets before any native test runs, so parallel workers only emit
 * + link their fixtures (they pass `skipRuntimeBuild`) and never race a shared
 * `cmake` on either build dir.
 */

import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypointToBuffer } from "../../src/compile-program.ts";
import { ensureRuntimeLibrary } from "../../src/local-build.ts";
import { stripTypesWithTypeScript } from "../../src/typescript-strip.ts";

const compilerBake = {
	bake: () =>
		compileEntrypointToBuffer("src/eval-compiler-entry.mts", {
			stripTypes: stripTypesWithTypeScript,
		}),
};

// vitest globalSetup supports a named `setup` export (avoids a default export).
export function setup(): void {
	ensureRuntimeLibrary(false, { compilerBake });
	const nodeConfig = resolveBuildConfig({
		engine: {
			eval: true,
			regexp: true,
			realms: true,
			intl: { enabled: true, features: [] },
		},
		surface: { webPlatform: true, node: true },
	});
	ensureRuntimeLibrary(false, { ...buildDerivationFromConfig(nodeConfig), compilerBake });
}
