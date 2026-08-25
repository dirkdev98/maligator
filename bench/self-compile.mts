import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-vm.ts";

const inputPath = process.argv[2];
const outputDirectory = process.argv[3];

if (inputPath === undefined || outputDirectory === undefined) {
	throw new Error("usage: self-compile <input> <output-directory>");
}

const config: ResolvedBuildConfig = {
	entry: undefined,
	outputName: undefined,
	assets: {},
	modules: { aliases: {} },
	engine: {
		primordials: "locked",
		eval: false,
		realms: false,
		regexp: true,
		temporal: false,
		intl: { enabled: false, features: [], languages: [] },
	},
	host: { scheduler: "single" },
	surface: { webPlatform: false, node: true, maligator: true },
};

const phases = {
	graphMs: 0,
	semanticMs: 0,
	lowerSemanticMs: 0,
	optimizeMs: 0,
	regallocMs: 0,
	lowerMs: 0,
	emitMs: 0,
	writeMs: 0,
};
type Phase = keyof typeof phases;
const measure = <T,>(phase: Phase, run: () => T): T => {
	const startedAt = Date.now();
	const result = run();
	phases[phase] += Date.now() - startedAt;
	return result;
};

const compilePhases = {
	graph: "graphMs",
	semantic: "semanticMs",
	"construct core ir": "lowerSemanticMs",
	"core ir optimizations": "optimizeMs",
	"lower core ir": "optimizeMs",
	"lower to vm": "lowerMs",
} as const;
const definition = compileEntrypoint(path.resolve(inputPath), {
	stripTypes: (source) => source,
	buildConfig: config,
	runPhase: (phase, run) => measure(compilePhases[phase], run),
});

const emitStartedAt = Date.now();
const units = emitProgramTranslationUnits(definition, { maligatorSurface: true });
phases.emitMs = Date.now() - emitStartedAt;

const writeStartedAt = Date.now();
mkdirSync(outputDirectory, { recursive: true });
for (let index = 0; index < units.length; index++) {
	writeFileSync(path.join(outputDirectory, `self-compile-${index}.c`), units[index]!);
}
phases.writeMs = Date.now() - writeStartedAt;

console.log(
	JSON.stringify({
		units: units.length,
		codeUnits: units.reduce((total, source) => total + source.length, 0),
		phases,
	}),
);
