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
			intrinsicGlobalReads: true,
			stripTypes: stripCompactTypes,
		}),
	bakeProgram: () =>
		compileEntrypoint(compilerEntrypoint, {
			intrinsicGlobalReads: true,
			stripTypes: stripCompactTypes,
		}),
};

export function setup(): void {
	if (process.env.MAL_NATIVE_PREWARM === "0") return;
	const preparationJobs = process.env.MAL_PREPARATION_BUILD_JOBS;
	const environment =
		preparationJobs === undefined
			? process.env
			: {
					...process.env,
					MAL_BUILD_JOBS: preparationJobs,
					CARGO_BUILD_JOBS: preparationJobs,
				};
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
			environment,
		}),
	);
}
