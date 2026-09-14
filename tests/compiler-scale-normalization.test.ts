import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	normalizeCompilerScaleEmissionImage,
	normalizeCompilerScaleMetrics,
} from "../scripts/compiler-scale-normalization.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";
import { testProgramImage } from "./helpers/program-image.ts";

function partitionedImage(sourceRoot: string, changed = false): ProgramImage {
	const instructions: BytecodeFunction["instructions"] = [
		changed
			? { opcode: "CREATE_BOOLEAN", dst: 0, value: true }
			: { opcode: "CREATE_UNDEFINED", dst: 0 },
		{ opcode: "CREATE_UNDEFINED", dst: 1 },
		...Array.from({ length: 20 }, () => ({
			opcode: "CALL" as const,
			dst: 2,
			callee: 0,
			thisValue: 1,
			argumentCount: 0,
			arguments: [],
		})),
		{ opcode: "RETURN", value: 2 },
	];
	const seed: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: 3,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions,
		handlers: [],
		fileIndex: 0,
		positions: [],
	};
	const functions = Array.from({ length: 32 }, () => ({
		...seed,
		instructions: [...seed.instructions],
	}));
	const runtime = {
		entrypointPath: "/compiler-scale-entry.mjs",
		functionCount: functions.length,
		functions,
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: 0,
		files: [path.join(sourceRoot, "input.mjs")],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	};
	return {
		...testProgramImage(runtime),
		native: createConservativeNativePlan(functions),
	};
}

function emittedPartitionProjection(image: ProgramImage) {
	return emitProgramTranslationUnits(
		image,
		{},
		{
			targetCodeUnits: 16_000,
			hardMaximumCodeUnits: 200_000,
		},
	).map(({ id, definitions, source }) => ({ id, definitions, source }));
}

describe("compiler scale normalization", () => {
	it("normalizes copied source roots before deterministic unit partitioning", () => {
		const warmRoot = "/tmp/compiler-scale-warm/source";
		const coldRoot = "/tmp/compiler-scale-cold/source";
		const warm = partitionedImage(warmRoot);
		const cold = partitionedImage(coldRoot);
		const warmFiles = [...warm.runtime.files];
		const coldFiles = [...cold.runtime.files];
		const normalizedWarm = normalizeCompilerScaleEmissionImage(warm, warmRoot);
		const normalizedCold = normalizeCompilerScaleEmissionImage(cold, coldRoot);
		const first = emittedPartitionProjection(normalizedWarm);

		expect(first.length).toBeGreaterThan(1);
		expect(first).toEqual(emittedPartitionProjection(normalizedCold));
		expect(first).toEqual(
			emittedPartitionProjection(normalizeCompilerScaleEmissionImage(warm, warmRoot)),
		);
		expect(warm.runtime.files).toEqual(warmFiles);
		expect(cold.runtime.files).toEqual(coldFiles);
		expect(
			emittedPartitionProjection(
				normalizeCompilerScaleEmissionImage(partitionedImage(warmRoot, true), warmRoot),
			),
		).not.toEqual(first);
	});

	it("retains each numerator and denominator beside its normalized value", () => {
		expect(
			normalizeCompilerScaleMetrics({
				medianWallMs: 50,
				medianOptimizeCoreMs: 30,
				inputInstructions: 1_000,
				localWorkItems: 100,
				localAppliedEdits: 4,
				controlFlowRecomputations: 6,
				liveBlocks: 10,
				liveEdges: 5,
				localValueKindRecomputations: 3,
				programValueKindFunctionEvaluations: 7,
				liveValues: 20,
				memoryTransfers: 24,
				memoryEvents: 8,
				programFlowLocalInstructionVisits: 100,
				programFlowTransferRecords: 40,
				programFlowSccTransfers: 10,
				exactCallEdges: 5,
				programFlowSccs: 5,
				candidateFunctionsScanned: 30,
				candidatesDiscovered: 10,
				admittedFunctions: 2,
				sampledAllocatedBytes: 2_000,
				liveInstructions: 100,
				peakRssBytes: 5_000,
			}),
		).toEqual({
			timing: {
				inputInstructions: 1_000,
				wallMsPerThousandInputInstructions: 50,
				optimizeCoreMsPerThousandInputInstructions: 30,
			},
			local: { workItems: 100, appliedEdits: 4, workPerAppliedEdit: 25 },
			cfg: {
				controlFlowRecomputations: 6,
				liveBlocksAndEdges: 15,
				workPerLiveBlockAndEdge: 0.4,
			},
			valueKinds: {
				localRecomputations: 3,
				programFunctionEvaluations: 7,
				work: 10,
				liveValues: 20,
				workPerLiveValue: 0.5,
			},
			memory: { transfers: 24, events: 8, workPerMemoryEvent: 3 },
			programFlow: {
				localInstructionVisits: 100,
				transferRecords: 40,
				sccTransfers: 10,
				work: 150,
				exactEdgesAndSccs: 10,
				workPerExactEdgeAndScc: 15,
			},
			candidates: {
				functionsScanned: 30,
				discovered: 10,
				work: 40,
				admittedFunctions: 2,
				workPerAdmittedFunction: 20,
			},
			allocation: {
				sampledBytes: 2_000,
				liveInstructions: 100,
				sampledBytesPerLiveInstruction: 20,
			},
			rss: {
				peakBytes: 5_000,
				liveInstructions: 100,
				peakBytesPerHundredThousandLiveInstructions: 5_000_000,
			},
		});
	});

	it("uses null when instrumentation did not capture a numerator or basis", () => {
		const result = normalizeCompilerScaleMetrics({
			medianWallMs: 1,
			medianOptimizeCoreMs: 1,
			inputInstructions: 0,
			liveBlocks: 1,
			liveValues: 0,
			liveInstructions: 0,
			peakRssBytes: 1,
		});

		expect(result.timing.wallMsPerThousandInputInstructions).toBeNull();
		expect(result.local.workPerAppliedEdit).toBeNull();
		expect(result.cfg.workPerLiveBlockAndEdge).toBeNull();
		expect(result.valueKinds.workPerLiveValue).toBeNull();
		expect(result.memory.workPerMemoryEvent).toBeNull();
		expect(result.programFlow.workPerExactEdgeAndScc).toBeNull();
		expect(result.candidates.workPerAdmittedFunction).toBeNull();
		expect(result.allocation.sampledBytesPerLiveInstruction).toBeNull();
		expect(result.rss.peakBytesPerHundredThousandLiveInstructions).toBeNull();
	});
});
