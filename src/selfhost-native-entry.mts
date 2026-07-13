import { existsSync } from "node:fs";
import * as path from "node:path";
import { stripCompactTypes } from "./compact-type-strip.ts";
import { compileEntrypoint } from "./compile-program.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { buildLocalBinary } from "./local-build.ts";

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

const evalEnabled = compilerWire !== undefined;
const targetConfig = {
	entry: undefined,
	engine: {
		eval: evalEnabled,
		realms: false,
		regexp: false,
		intl: { enabled: false, features: [], languages: [] },
	},
	host: { scheduler: "single" as const },
	surface: { webPlatform: false, node: false, maligator: true },
};

const definition = compileEntrypoint(path.resolve(inputPath), {
	stripTypes: stripCompactTypes,
	buildConfig: targetConfig,
});
const binary = buildLocalBinary({
	name: outputName,
	outDir: path.resolve(outputDirectory),
	cSource: emitVmDefinition(definition),
	verbose: true,
	evalEnabled,
	realmsEnabled: false,
	intlEnabled: false,
	webPlatformEnabled: false,
	regexpEnabled: false,
	nodeEnabled: false,
	cacheSuffix: evalEnabled ? "selfhost-native-eval" : "selfhost-native-minimal",
	rustCacheSuffix: "selfhost-native-minimal",
	compilerBake:
		compilerWire === undefined ? undefined : { prebuiltPath: path.resolve(compilerWire) },
});

// eslint-disable-next-line no-console -- CLI result consumed by the bootstrap check.
console.log(binary);
