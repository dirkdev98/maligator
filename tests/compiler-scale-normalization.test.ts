import { describe, expect, it } from "vitest";
import { normalizeCompilerScaleMetrics } from "../scripts/compiler-scale-normalization.ts";

describe("compiler scale normalization", () => {
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
