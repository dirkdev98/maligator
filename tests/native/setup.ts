import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { TestProject } from "vitest/node";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import { perfStatsEnabled } from "../../src/build-flags.ts";
import { CommandProgress } from "../../src/command-progress.ts";
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
	const variants: Array<{
		environment: NodeJS.ProcessEnv;
		node: boolean;
		webPlatform: boolean;
		realms?: boolean;
	}> = [
		{ environment, node: false, webPlatform: true },
		{ environment, node: true, webPlatform: true },
	];
	const selectedPaths = new Set(
		project.vitest.state.getPaths().map((file) => path.resolve(file)),
	);
	if (selectedPaths.has(path.resolve("tests/native/web-disabled.test.ts"))) {
		variants.push({ environment, node: false, webPlatform: false });
	}
	if (selectedPaths.has(path.resolve("tests/native/realms-disabled.test.ts"))) {
		variants.push({ environment, node: false, webPlatform: true, realms: false });
	}
	// Vitest records selected paths before global setup; collected files are still empty.
	if (
		!perfStatsEnabled(environment) &&
		[...selectedPaths].some((file) => perfTests.has(file))
	) {
		variants.push({
			environment: { ...environment, MAL_PERF_STATS: "1" },
			node: false,
			webPlatform: true,
		});
	}
	if (
		!perfStatsEnabled(environment) &&
		selectedPaths.has(path.resolve("tests/native/node-http-ready-queues.test.ts"))
	) {
		variants.push({
			environment: { ...environment, MAL_PERF_STATS: "1" },
			node: true,
			webPlatform: true,
		});
	}
	const progress = new CommandProgress("native-prepare", { cacheLease: false });
	for (const [index, variant] of variants.entries()) {
		const label = `eval runtime (Node ${variant.node ? "on" : "off"}, web ${variant.webPlatform ? "on" : "off"}, realms ${variant.realms === false ? "off" : "on"}, stats ${perfStatsEnabled(variant.environment) ? "on" : "off"})`;
		progress.stage(index + 1, variants.length, label);
		try {
			const config = preparedNativeEvalConfig(variant);
			ensureNativeArtifacts(
				resolveNativeBuildContext({
					features: buildDerivationFromConfig(config).features,
					compilerBake,
					environment: variant.environment,
				}),
			);
			progress.stagePassed(index + 1, variants.length, label);
		} catch (error) {
			progress.stageFailed(index + 1, variants.length, label);
			throw error;
		}
	}
	progress.complete();
}
