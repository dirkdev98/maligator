import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import {
	CORE_OPTIMIZATION_FAMILIES,
	type CoreOptimizationFamily,
} from "../src/compiler/core/core-optimization-families.ts";
import {
	completeCompilerOptimizationOwners,
	readCoreOptimizationRuntimeCounters,
	subtractCoreOptimizationRuntimeCounters,
} from "../src/compiler/core/core-optimization-owners.ts";
import type {
	CompilerOptimizationOwnerRuntimePhases,
	CoreOptimizationRuntimeCounters,
} from "../src/compiler/core/core-optimization-owners.ts";
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
const runtimePhases: Partial<Record<Phase, CoreOptimizationRuntimeCounters>> = {};
const measure = <T,>(phase: Phase, run: () => T): T => {
	const runtimeBefore = readCoreOptimizationRuntimeCounters();
	const startedAt = Date.now();
	try {
		return run();
	} finally {
		phases[phase] += Date.now() - startedAt;
		const runtime = subtractCoreOptimizationRuntimeCounters(
			runtimeBefore,
			readCoreOptimizationRuntimeCounters(),
		);
		if (runtime !== undefined) {
			const current = runtimePhases[phase];
			runtimePhases[phase] = Object.freeze({
				allocatedBytes: (current?.allocatedBytes ?? 0) + runtime.allocatedBytes,
				collections: (current?.collections ?? 0) + runtime.collections,
			});
		}
	}
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

const units = measure("emitMs", () =>
	emitProgramTranslationUnits(image, { maligatorSurface: true }),
);

measure("writeMs", () => {
	mkdirSync(outputDirectory, { recursive: true });
	for (let index = 0; index < units.length; index++) {
		const unit = units[index]!;
		writeFileSync(path.join(outputDirectory, `self-compile-${unit.id}.c`), unit.source);
	}
});

console.log(
	JSON.stringify({
		units: units.length,
		codeUnits: units.reduce((total, unit) => total + unit.source.length, 0),
		phases,
		optimizer: optimizationReport,
		owners: completeCompilerOptimizationOwners(
			optimizationReport.owners,
			phases,
			{
				inputInstructions: optimizationReport.input.instructions,
				outputInstructions: optimizationReport.output.instructions,
				generatedCodeUnits: units.reduce((total, unit) => total + unit.source.length, 0),
			},
			runtimePhases as CompilerOptimizationOwnerRuntimePhases,
		),
	}),
);
