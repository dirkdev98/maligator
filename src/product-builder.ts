import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { includeConfiguredAssets } from "./assets.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import { compileEntrypointToBuffer } from "./compile-program.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";
import { stripTypesWithTypeScript } from "./typescript-strip.ts";

export const PRODUCT_RUNTIME_ASSET_INCLUDE = [
	"host_main.c",
	"test262_main.c",
	"src/**",
	"rust/Cargo.toml",
	"rust/Cargo.lock",
	"rust/rust-toolchain.toml",
	"rust/src/**",
	"rust/include/**",
];

export function productCliConfig(
	repositoryRoot: string,
	compilerWirePath: string,
): ResolvedBuildConfig {
	return resolveBuildConfig({
		assets: {
			compilerWire: { type: "file", path: path.resolve(compilerWirePath) },
			runtime: {
				type: "directory",
				path: path.resolve(repositoryRoot, "runtime"),
				include: [...PRODUCT_RUNTIME_ASSET_INCLUDE],
			},
		},
		engine: { eval: true, realms: false, regexp: true, intl: { enabled: false } },
		surface: { webPlatform: false, node: true, maligator: true },
	});
}

export interface BuildProductCliOptions {
	repositoryRoot: string;
	outDir: string;
	name?: string;
}

/** Build the redistributable CLI and bake all resources it needs outside the checkout. */
export function buildProductCli(options: BuildProductCliOptions): string {
	const repositoryRoot = path.resolve(options.repositoryRoot);
	const outDir = path.resolve(options.outDir);
	const runtimeDirectory = path.join(repositoryRoot, "runtime");
	const compilerWirePath = path.join(outDir, "compiler.malw");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		compilerWirePath,
		compileEntrypointToBuffer(path.join(repositoryRoot, "src/eval-compiler-entry.mts"), {
			stripTypes: stripTypesWithTypeScript,
		}),
	);

	const config = productCliConfig(repositoryRoot, compilerWirePath);
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(
		path.join(repositoryRoot, "src/product-cli-entry.mts"),
		{ buildConfig: config, stripTypes: stripTypesWithTypeScript },
	);
	const definition = compileSemanticProgramToVmDefinition(semanticProgram);
	const assets = includeConfiguredAssets(config.assets, repositoryRoot);
	const compilerWire = assets.find((asset) => asset.name === "compilerWire");
	if (compilerWire?.files.length !== 1) {
		throw new Error("Product compilerWire asset must contain exactly one file");
	}
	compilerWire.files[0]!.embeddedSymbol = "mal_compiler_wire_data";
	const cSource = emitVmDefinition(definition, {
		compiled: true,
		assets,
		maligatorSurface: config.surface.maligator,
	});
	const derivation = buildDerivationFromConfig(config);
	const context = resolveNativeBuildContext({
		runtimeDirectory,
		features: derivation.features,
		compilerBake: { kind: "prebuilt", path: compilerWirePath },
	});
	return buildLocalBinary({
		context,
		name: options.name ?? "maligator-product",
		cSource,
		verbose: false,
		mainFile: path.join(runtimeDirectory, "host_main.c"),
		outDir,
		cacheSuffix: derivation.cacheSuffix,
	}).binaryPath;
}
