import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { includeConfiguredAssets } from "./assets.ts";
import { createBuildArtifact } from "./build-artifact.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { selectNativeBuildPlan } from "./build-flags.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { compilerProducerDigestsForRoot } from "./compiler-cache-identity.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "./compiler/pipeline/compile-core.ts";
import { compileEntrypointToBuffer } from "./compiler/pipeline/compile-program.ts";
import { compilerProgramFactsFromConfig } from "./compiler/shared/compiler-facts.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { requireToolchain } from "./toolchain.ts";
import { MALIGATOR_VERSION } from "./version.ts";

export const PRODUCT_RUNTIME_ASSET_INCLUDE = [
	"dev_main.c",
	"host_main.c",
	"test262_main.c",
	"src/**",
	"rust/Cargo.toml",
	"rust/Cargo.lock",
	"rust/rust-toolchain.toml",
	"rust/src/**",
	"rust/include/**",
	"vendor/llhttp/include/**",
	"vendor/llhttp/src/**",
	"vendor/sqlite/**",
];

export function productCliConfig(
	repositoryRoot: string,
	compilerWirePath: string,
	compilerProducerDigestsPath: string,
): ResolvedBuildConfig {
	return resolveBuildConfig({
		assets: {
			compilerWire: { type: "file", path: path.resolve(compilerWirePath) },
			compilerProducerDigests: {
				type: "file",
				path: path.resolve(compilerProducerDigestsPath),
			},
			testRuntime: {
				type: "file",
				path: path.resolve(repositoryRoot, "src/testing/runtime.mjs"),
			},
			nodeGlobals: {
				type: "file",
				path: path.resolve(repositoryRoot, "src/node-globals.mjs"),
			},
			license: { type: "file", path: path.resolve(repositoryRoot, "LICENSE") },
			runtime: {
				type: "directory",
				path: path.resolve(repositoryRoot, "runtime"),
				include: [...PRODUCT_RUNTIME_ASSET_INCLUDE],
			},
		},
		engine: { eval: true, realms: true, regexp: true, intl: { enabled: false } },
		surface: { webPlatform: true, node: true, maligator: true },
	});
}

export interface BuildProductCliOptions {
	repositoryRoot: string;
	outDir: string;
	name?: string;
	target?: string;
	production?: boolean;
	artifactDirectory?: string;
	onProgress?: (message: string) => void;
}

/** Build the redistributable CLI and bake all resources it needs outside the checkout. */
export function buildProductCli(options: BuildProductCliOptions): string {
	const progress = options.onProgress ?? (() => {});
	const repositoryRoot = path.resolve(options.repositoryRoot);
	const outDir = path.resolve(options.outDir);
	const runtimeDirectory = path.join(repositoryRoot, "runtime");
	const compilerWirePath = path.join(outDir, "compiler.malw");
	mkdirSync(outDir, { recursive: true });
	progress("compiling the embedded eval compiler");
	writeFileSync(
		compilerWirePath,
		compileEntrypointToBuffer(
			path.join(repositoryRoot, "src/compiler/pipeline/eval-compiler-entry.mts"),
			{ stripTypes: stripCompactTypes },
		),
	);
	const compilerProducerDigestsPath = path.join(outDir, "compiler-producers.json");
	writeFileSync(
		compilerProducerDigestsPath,
		`${JSON.stringify(
			compilerProducerDigestsForRoot(
				path.join(repositoryRoot, "src"),
				maligatorCacheDirectory(),
			),
		)}\n`,
	);

	const config = productCliConfig(
		repositoryRoot,
		compilerWirePath,
		compilerProducerDigestsPath,
	);
	progress("analyzing and compiling the product CLI");
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(
		path.join(repositoryRoot, "src/product-cli-entry.mts"),
		{ buildConfig: config, stripTypes: stripCompactTypes },
	);
	const definition = compileSemanticProgramToProgramImage(semanticProgram, {
		facts: compilerProgramFactsFromConfig(config),
		runPhase: (phase, run) => {
			progress(`product CLI ${phase}`);
			const result = run();
			progress(`product CLI ${phase} complete`);
			return result;
		},
	});
	progress("embedding product CLI assets");
	const assets = includeConfiguredAssets(config.assets, repositoryRoot);
	const compilerWire = assets.find((asset) => asset.name === "compilerWire");
	if (compilerWire?.files.length !== 1) {
		throw new Error("Product compilerWire asset must contain exactly one file");
	}
	compilerWire.files[0]!.embeddedSymbol = "mal_compiler_wire_data";
	progress("emitting the product CLI translation units");
	const cSource = emitProgramTranslationUnits(definition, {
		compiled: true,
		assets,
		maligatorSurface: config.surface.maligator,
	});
	progress("product CLI translation units ready");
	const derivation = buildDerivationFromConfig(config);
	progress("selecting the native toolchain");
	const toolchain = requireToolchain({
		needsCxx: derivation.features.cargoFeatures.includes("url"),
		rustDir: path.join(runtimeDirectory, "rust"),
		target: options.target,
	});
	const production = options.production ?? true;
	const plan = selectNativeBuildPlan(toolchain, production);
	const context = resolveNativeBuildContext({
		toolchain,
		plan,
		runtimeDirectory,
		features: { ...derivation.features, developmentApiEnabled: true },
		compilerBake: { kind: "prebuilt", path: compilerWirePath },
		onCacheEvent: (event) =>
			progress(`${event.artifact} cache ${event.hit ? "hit" : "miss"}: ${event.path}`),
	});
	const executableName = options.name ?? "maligator";
	progress("linking the product CLI");
	const binaryPath = buildLocalBinary({
		context,
		name: executableName,
		cSource,
		verbose: false,
		mainFile: path.join(runtimeDirectory, "host_main.c"),
		outDir,
		cacheSuffix: derivation.cacheSuffix,
	}).binaryPath;
	if (options.artifactDirectory !== undefined) {
		progress("creating the deployable artifact");
		createBuildArtifact({
			binaryPath,
			directory: options.artifactDirectory,
			executableName,
			licensePath: path.join(repositoryRoot, "LICENSE"),
			version: MALIGATOR_VERSION,
			target: toolchain.rustTarget,
			production,
		});
	}
	progress(`product CLI ready: ${binaryPath}`);
	return binaryPath;
}
