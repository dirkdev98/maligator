import path from "node:path";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { nativeSourcePath } from "../src/native-source-path.ts";

export function normalizeCompilerScaleEmissionImage(
	image: ProgramImage,
	sourceRoot: string,
): ProgramImage {
	return {
		...image,
		runtime: {
			...image.runtime,
			files: image.runtime.files.map((file) =>
				file.startsWith(`${sourceRoot}${path.sep}`)
					? path.relative(sourceRoot, file)
					: nativeSourcePath(file),
			),
		},
	};
}

export interface CompilerScaleNormalizationInput {
	readonly medianWallMs: number;
	readonly medianOptimizeCoreMs: number;
	readonly inputInstructions: number;
	readonly localWorkItems?: number;
	readonly localAppliedEdits?: number;
	readonly controlFlowRecomputations?: number;
	readonly liveBlocks: number;
	readonly liveEdges?: number;
	readonly localValueKindRecomputations?: number;
	readonly programValueKindFunctionEvaluations?: number;
	readonly liveValues: number;
	readonly memoryTransfers?: number;
	readonly memoryEvents?: number;
	readonly programFlowLocalInstructionVisits?: number;
	readonly programFlowTransferRecords?: number;
	readonly programFlowSccTransfers?: number;
	readonly exactCallEdges?: number;
	readonly programFlowSccs?: number;
	readonly candidateFunctionsScanned?: number;
	readonly candidatesDiscovered?: number;
	readonly admittedFunctions?: number;
	readonly sampledAllocatedBytes?: number;
	readonly liveInstructions: number;
	readonly peakRssBytes: number;
}

function normalized(value: number | undefined, basis: number): number | null {
	return value === undefined || basis === 0 ? null : value / basis;
}

export function normalizeCompilerScaleMetrics(input: CompilerScaleNormalizationInput) {
	const liveBlocksAndEdges =
		input.liveEdges === undefined ? 0 : input.liveBlocks + input.liveEdges;
	const valueKindWork =
		input.localValueKindRecomputations === undefined ||
		input.programValueKindFunctionEvaluations === undefined
			? undefined
			: input.localValueKindRecomputations + input.programValueKindFunctionEvaluations;
	const programFlowWork =
		input.programFlowLocalInstructionVisits === undefined ||
		input.programFlowTransferRecords === undefined ||
		input.programFlowSccTransfers === undefined
			? undefined
			: input.programFlowLocalInstructionVisits +
				input.programFlowTransferRecords +
				input.programFlowSccTransfers;
	const exactEdgesAndSccs =
		input.exactCallEdges === undefined || input.programFlowSccs === undefined
			? 0
			: input.exactCallEdges + input.programFlowSccs;
	const candidateWork =
		input.candidateFunctionsScanned === undefined ||
		input.candidatesDiscovered === undefined
			? undefined
			: input.candidateFunctionsScanned + input.candidatesDiscovered;
	return {
		timing: {
			inputInstructions: input.inputInstructions,
			wallMsPerThousandInputInstructions: normalized(
				input.medianWallMs * 1_000,
				input.inputInstructions,
			),
			optimizeCoreMsPerThousandInputInstructions: normalized(
				input.medianOptimizeCoreMs * 1_000,
				input.inputInstructions,
			),
		},
		local: {
			workItems: input.localWorkItems ?? null,
			appliedEdits: input.localAppliedEdits ?? null,
			workPerAppliedEdit: normalized(input.localWorkItems, input.localAppliedEdits ?? 0),
		},
		cfg: {
			controlFlowRecomputations: input.controlFlowRecomputations ?? null,
			liveBlocksAndEdges: input.liveEdges === undefined ? null : liveBlocksAndEdges,
			workPerLiveBlockAndEdge: normalized(
				input.controlFlowRecomputations,
				liveBlocksAndEdges,
			),
		},
		valueKinds: {
			localRecomputations: input.localValueKindRecomputations ?? null,
			programFunctionEvaluations: input.programValueKindFunctionEvaluations ?? null,
			work: valueKindWork ?? null,
			liveValues: input.liveValues,
			workPerLiveValue: normalized(valueKindWork, input.liveValues),
		},
		memory: {
			transfers: input.memoryTransfers ?? null,
			events: input.memoryEvents ?? null,
			workPerMemoryEvent: normalized(input.memoryTransfers, input.memoryEvents ?? 0),
		},
		programFlow: {
			localInstructionVisits: input.programFlowLocalInstructionVisits ?? null,
			transferRecords: input.programFlowTransferRecords ?? null,
			sccTransfers: input.programFlowSccTransfers ?? null,
			work: programFlowWork ?? null,
			exactEdgesAndSccs:
				input.exactCallEdges === undefined || input.programFlowSccs === undefined
					? null
					: exactEdgesAndSccs,
			workPerExactEdgeAndScc: normalized(programFlowWork, exactEdgesAndSccs),
		},
		candidates: {
			functionsScanned: input.candidateFunctionsScanned ?? null,
			discovered: input.candidatesDiscovered ?? null,
			work: candidateWork ?? null,
			admittedFunctions: input.admittedFunctions ?? null,
			workPerAdmittedFunction: normalized(candidateWork, input.admittedFunctions ?? 0),
		},
		allocation: {
			sampledBytes: input.sampledAllocatedBytes ?? null,
			liveInstructions: input.liveInstructions,
			sampledBytesPerLiveInstruction: normalized(
				input.sampledAllocatedBytes,
				input.liveInstructions,
			),
		},
		rss: {
			peakBytes: input.peakRssBytes,
			liveInstructions: input.liveInstructions,
			peakBytesPerHundredThousandLiveInstructions: normalized(
				input.peakRssBytes * 100_000,
				input.liveInstructions,
			),
		},
	};
}
