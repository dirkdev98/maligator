import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildDerivationFromConfig } from "./build-config.ts";
import { compileEntrypoint } from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "./local-build.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import {
	SELFHOST_NATIVE_EMISSION,
	SELFHOST_NATIVE_FRONTEND,
	selfhostNativeEvidence,
	selfhostNativeTargetConfig,
} from "./selfhost-native-target.ts";

const args = process.argv.slice(2);
const evidenceFlag = args.indexOf("--evidence");
const evidenceDirectory = evidenceFlag === -1 ? undefined : args[evidenceFlag + 1];
if (evidenceFlag !== -1) args.splice(evidenceFlag, 2);
const [inputPath, outputName, outputDirectory, compilerWire] = args;

if (
	inputPath === undefined ||
	outputName === undefined ||
	outputDirectory === undefined ||
	(evidenceFlag !== -1 && evidenceDirectory === undefined)
) {
	throw new Error(
		"usage: selfhost-native <input> <output-name> <output-directory> [prebuilt-compiler-wire] [--evidence <directory>]",
	);
}
if (!existsSync(inputPath)) throw new Error(`entrypoint does not exist: ${inputPath}`);
if (compilerWire !== undefined && !existsSync(compilerWire)) {
	throw new Error(`prebuilt compiler wire does not exist: ${compilerWire}`);
}

const targetConfig = selfhostNativeTargetConfig(compilerWire !== undefined);
const derivation = buildDerivationFromConfig(targetConfig);

const definition = compileEntrypoint(path.resolve(inputPath), {
	...SELFHOST_NATIVE_FRONTEND,
	buildConfig: targetConfig,
});
const translationUnits = emitProgramTranslationUnits(
	definition,
	SELFHOST_NATIVE_EMISSION,
);
if (evidenceDirectory !== undefined) {
	mkdirSync(evidenceDirectory, { recursive: true });
	for (const { name, bytes } of selfhostNativeEvidence(definition, translationUnits))
		writeFileSync(path.join(evidenceDirectory, name), bytes);
}
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
	cSource: translationUnits,
	verbose: true,
	cacheSuffix: derivation.cacheSuffix,
});

// oxlint-disable-next-line no-console -- CLI result consumed by the bootstrap check.
console.log(result.binaryPath);
