/**
 * vitest globalSetup for the native lane. Prewarms the canonical runtime artifact
 * set; feature-specific archives are built lazily by the tests that need them.
 */

import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { compilerEntrypointSourceFiles } from "../../src/compiler-bake.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../../src/runtime-build.ts";

const compilerSourceDirectory = path.resolve("src");
const compilerEntrypoint = path.resolve("src/compiler/pipeline/eval-compiler-entry.mts");
const compilerBake = {
	kind: "source" as const,
	sourceDirectory: compilerSourceDirectory,
	entrypoint: compilerEntrypoint,
	sourceFiles: compilerEntrypointSourceFiles(
		compilerSourceDirectory,
		compilerEntrypoint,
		stripCompactTypes,
	),
	bake: () =>
		compileEntrypointToBuffer(compilerEntrypoint, {
			stripTypes: stripCompactTypes,
		}),
	bakeProgram: () =>
		compileEntrypoint(compilerEntrypoint, {
			stripTypes: stripCompactTypes,
		}),
};

// vitest globalSetup supports a named `setup` export (avoids a default export).
export function setup(): void {
	const config = resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: true,
			regexp: true,
			realms: true,
			temporal: true,
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
