import { existsSync } from "node:fs";
import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { compileEntrypoint } from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import { nativeSourcePath } from "./native-source-path.ts";

const inputPath = process.argv[2];
const outputName = process.argv[3];
const outputDirectory = process.argv[4];
const compilerWire = process.argv[5];

if (
	inputPath === undefined ||
	outputName === undefined ||
	outputDirectory === undefined
) {
	throw new Error(
		"usage: selfhost-native <input> <output-name> <output-directory> [prebuilt-compiler-wire]",
	);
}
if (!existsSync(inputPath)) throw new Error(`entrypoint does not exist: ${inputPath}`);
if (compilerWire !== undefined && !existsSync(compilerWire)) {
	throw new Error(`prebuilt compiler wire does not exist: ${compilerWire}`);
}

const targetConfig = resolveBuildConfig({
	engine: {
		eval: compilerWire !== undefined,
		realms: false,
		regexp: false,
		intl: { enabled: false },
	},
	surface: { webPlatform: false, node: false, maligator: true },
});
const derivation = buildDerivationFromConfig(targetConfig);

const definition = compileEntrypoint(path.resolve(inputPath), {
	stripTypes: stripCompactTypes,
	buildConfig: targetConfig,
});
const context = resolveNativeBuildContext({
	features: derivation.features,
	compilerBake:
		compilerWire === undefined
			? undefined
			: { kind: "prebuilt", path: path.resolve(compilerWire) },
});
const result = buildLocalBinary({
	context,
	name: outputName,
	outDir: path.resolve(outputDirectory),
	cSource: emitProgramTranslationUnits(definition, {
		sourcePath: nativeSourcePath,
		maligatorSurface: true,
	}),
	verbose: true,
	cacheSuffix: derivation.cacheSuffix,
});

// oxlint-disable-next-line no-console -- CLI result consumed by the bootstrap check.
console.log(result.binaryPath);
