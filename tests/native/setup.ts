import * as path from "node:path";
import type { TestProject } from "vitest/node";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import type { ResolvedBuildConfig } from "../../src/build-config.ts";
import { perfStatsEnabled } from "../../src/build-flags.ts";
import { CommandProgress } from "../../src/command-progress.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import { embeddedCompilerOptions } from "../../src/compiler/pipeline/embedded-compiler-options.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../../src/runtime-build.ts";
import {
	defaultProductEvalConfig,
	owningArgumentForwardingEvalConfig,
	preparedNativeEvalConfig,
} from "../helpers/native-eval-config.ts";
import { nativePreparations } from "../helpers/native-preparations.ts";

const compilerSourceDirectory = path.resolve("src");
const compilerEntrypoint = path.resolve("src/compiler/pipeline/eval-compiler-entry.mts");
const compilerBake = {
	kind: "source" as const,
	sourceDirectory: compilerSourceDirectory,
	entrypoint: compilerEntrypoint,
	bake: () =>
		compileEntrypointToBuffer(compilerEntrypoint, {
			...embeddedCompilerOptions(compilerSourceDirectory),
			stripTypes: stripCompactTypes,
		}),
	bakeProgram: () =>
		compileEntrypoint(compilerEntrypoint, {
			...embeddedCompilerOptions(compilerSourceDirectory),
			stripTypes: stripCompactTypes,
		}),
};

interface Preparation {
	environment: NodeJS.ProcessEnv;
	label: string;
	config: ResolvedBuildConfig;
}

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
	const internal = (
		variantEnvironment: NodeJS.ProcessEnv,
		profile: {
			realms?: boolean;
			primordials?: "mutable" | "locked";
		},
	): Preparation => ({
		environment: variantEnvironment,
		label: `eval runtime (realms ${profile.realms === false ? "off" : "on"}, primordials ${profile.primordials ?? "mutable"}, stats ${perfStatsEnabled(variantEnvironment) ? "on" : "off"})`,
		config: preparedNativeEvalConfig(profile),
	});
	const statsEnvironment = { ...environment, MAL_PERF_STATS: "1" };
	const variants: Array<Preparation> = [internal(environment, {})];
	// Vitest records selected paths before global setup; collected files are still empty.
	const required = new Set(
		project.vitest.state
			.getPaths()
			.flatMap((file) => nativePreparations(process.cwd(), path.resolve(file))),
	);
	if (required.has("realms-disabled")) {
		variants.push(internal(environment, { realms: false }));
	}
	if (!perfStatsEnabled(environment) && required.has("perf-stats")) {
		variants.push(internal(statsEnvironment, {}));
	}
	if (required.has("locked-perf-stats")) {
		variants.push(
			internal(statsEnvironment, {
				primordials: "locked",
			}),
		);
	}
	if (required.has("product-eval-defaults")) {
		variants.push({
			environment,
			label: "eval runtime (product defaults)",
			config: defaultProductEvalConfig(),
		});
	}
	if (required.has("owning-argument-forwarding")) {
		for (const primordials of ["mutable", "locked"] as const) {
			variants.push({
				environment,
				label: `owning argument forwarding runtime (${primordials} primordials)`,
				config: owningArgumentForwardingEvalConfig(primordials),
			});
		}
	}
	const progress = new CommandProgress("native-prepare", { cacheLease: false });
	for (const [index, variant] of variants.entries()) {
		progress.stage(index + 1, variants.length, variant.label);
		try {
			ensureNativeArtifacts(
				resolveNativeBuildContext({
					features: buildDerivationFromConfig(variant.config).features,
					compilerBake,
					environment: variant.environment,
				}),
			);
			progress.stagePassed(index + 1, variants.length, variant.label);
		} catch (error) {
			progress.stageFailed(index + 1, variants.length, variant.label);
			throw error;
		}
	}
	progress.complete();
}
