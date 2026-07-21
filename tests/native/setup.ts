/**
 * vitest globalSetup for the native lane. Prewarms the canonical runtime artifact
 * set; feature-specific archives are built lazily by the tests that need them.
 */

import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypointToBuffer } from "../../src/compile-program.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../../src/runtime-build.ts";
import { stripTypesWithTypeScript } from "../../src/typescript-strip.ts";

const compilerBake = {
	kind: "source" as const,
	sourceDirectory: path.resolve("src"),
	entrypoint: path.resolve("src/eval-compiler-entry.mts"),
	bake: () =>
		compileEntrypointToBuffer(path.resolve("src/eval-compiler-entry.mts"), {
			stripTypes: stripTypesWithTypeScript,
		}),
};

// vitest globalSetup supports a named `setup` export (avoids a default export).
export function setup(): void {
	const config = resolveBuildConfig({
		engine: {
			eval: true,
			regexp: true,
			realms: true,
			intl: { enabled: true, features: [] },
		},
		surface: { webPlatform: true, node: false },
	});
	ensureNativeArtifacts(
		resolveNativeBuildContext({
			features: buildDerivationFromConfig(config).features,
			compilerBake,
		}),
	);
}
