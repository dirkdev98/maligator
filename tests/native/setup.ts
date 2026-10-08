import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { TestProject } from "vitest/node";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import { perfStatsEnabled } from "../../src/build-flags.ts";
import { compilerEntrypointSourceFiles } from "../../src/compiler-bake.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../../src/runtime-build.ts";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

const compilerSourceDirectory = path.resolve("src");
const compilerEntrypoint = path.resolve("src/compiler/pipeline/eval-compiler-entry.mts");
const perfTests = new Set(
	readFileSync(new URL("../test-suite-native-perf.txt", import.meta.url), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((file) => path.resolve(file)),
);
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

export function setup(project: TestProject): void {
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
	// Both default surfaces must prepare their shared compiler before timed fixture builds.
	const variants = [
		{ environment, node: false },
		{ environment, node: true },
	];
	// Vitest records selected paths before global setup; collected files are still empty.
	if (
		!perfStatsEnabled(environment) &&
		project.vitest.state.getPaths().some((file) => perfTests.has(path.resolve(file)))
	) {
		variants.push({ environment: { ...environment, MAL_PERF_STATS: "1" }, node: false });
	}
	for (const variant of variants) {
		const config = preparedNativeEvalConfig(variant.node);
		ensureNativeArtifacts(
			resolveNativeBuildContext({
				features: buildDerivationFromConfig(config).features,
				compilerBake,
				environment: variant.environment,
			}),
		);
	}
}
