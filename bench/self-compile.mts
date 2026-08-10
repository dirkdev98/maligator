import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compile-program.ts";
import { emitVmTranslationUnits } from "../src/emit-vm.ts";

const inputPath = process.argv[2];
const outputDirectory = process.argv[3];

if (inputPath === undefined || outputDirectory === undefined) {
	throw new Error("usage: self-compile <input> <output-directory>");
}

const config: ResolvedBuildConfig = {
	entry: undefined,
	outputName: undefined,
	assets: {},
	engine: {
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false, features: [], languages: [] },
	},
	host: { scheduler: "single" },
	surface: { webPlatform: false, node: true, maligator: true },
};

const definition = compileEntrypoint(path.resolve(inputPath), {
	stripTypes: (source) => source,
	buildConfig: config,
});
const units = emitVmTranslationUnits(definition, { maligatorSurface: true });

mkdirSync(outputDirectory, { recursive: true });
for (let index = 0; index < units.length; index++) {
	writeFileSync(path.join(outputDirectory, `self-compile-${index}.c`), units[index]!);
}

console.log(
	JSON.stringify({
		units: units.length,
		codeUnits: units.reduce((total, source) => total + source.length, 0),
	}),
);
