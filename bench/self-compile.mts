import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import {
	CORE_OPTIMIZATION_FAMILIES,
	type CoreOptimizationFamily,
} from "../src/compiler/core/core-optimization-families.ts";
import type {
	CoreInstrumentationMode,
	CoreOptimizationReport,
} from "../src/compiler/core/core-optimization-report.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";

const inputPath = process.argv[2];
const outputDirectory = process.argv[3];

if (inputPath === undefined || outputDirectory === undefined) {
	throw new Error("usage: self-compile <input> <output-directory>");
}

const instrumentationValue = process.env.MAL_CORE_INSTRUMENTATION ?? "off";
if (
	instrumentationValue !== "off" &&
	instrumentationValue !== "phases" &&
	instrumentationValue !== "counters" &&
	instrumentationValue !== "full"
) {
	throw new Error(`unknown Core instrumentation mode ${instrumentationValue}`);
}
const instrumentation: CoreInstrumentationMode = instrumentationValue;
const ablationValue = process.env.MAL_CORE_BENCHMARK_ABLATION;
if (
	ablationValue !== undefined &&
	!CORE_OPTIMIZATION_FAMILIES.includes(ablationValue as CoreOptimizationFamily)
) {
	throw new Error(`unknown Core benchmark ablation ${ablationValue}`);
}
const coreOptimizationBenchmarkAblation =
	ablationValue === undefined
		? undefined
		: { family: ablationValue as CoreOptimizationFamily };

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
	surface: { webPlatform: false, node: true, maligator: true },
};

const phases = {
	graphMs: 0,
	semanticMs: 0,
	constructCoreMs: 0,
	optimizeCoreMs: 0,
	coreToExecutionMs: 0,
	executionToImageMs: 0,
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
	"construct core ir": "constructCoreMs",
	"optimize core ir": "optimizeCoreMs",
	"core to execution": "coreToExecutionMs",
	"execution to image": "executionToImageMs",
} as const;
let optimizationReport: CoreOptimizationReport | undefined;
const image = compileEntrypoint(path.resolve(inputPath), {
	stripTypes: (source) => source,
	buildConfig: config,
	coreInstrumentation: instrumentation,
	coreOptimizationBenchmarkAblation,
	afterCoreOptimization(_program, _context, report) {
		optimizationReport = report;
	},
	runPhase: (phase, run) => measure(compilePhases[phase], run),
});
if (optimizationReport === undefined) throw new Error("missing Core optimization report");

const emitStartedAt = Date.now();
const units = emitProgramTranslationUnits(image, { maligatorSurface: true });
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
		optimizer: optimizationReport,
	}),
);
