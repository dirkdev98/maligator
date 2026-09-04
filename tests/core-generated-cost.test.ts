import { describe, expect, it } from "vitest";
import {
	CORE_GENERATED_CODE_COST_WEIGHTS,
	coreGeneratedCodeAdmitsRegion,
	coreGeneratedCodeOverheadCost,
} from "../src/compiler/core/core-ir-generated-cost.ts";

describe("Core generated-code cost", () => {
	it("records every profitability multiplier in one stable contract", () => {
		expect(CORE_GENERATED_CODE_COST_WEIGHTS).toEqual({
			estimatedCStatements: {
				instruction: 1,
				helperCall: 2,
				guard: 2,
				boxingOperation: 1,
				genericTwin: 1,
				admissionCheck: 2,
				materializationPath: 4,
				stateSynchronization: 2,
			},
			estimatedBinaryBytes: {
				cStatement: 8,
				inputOperand: 2,
				duplicatedInstruction: 4,
			},
			compilerWork: {
				cStatement: 1,
				helperCall: 3,
				guard: 2,
				boxingOperation: 1,
				rootSlot: 1,
				safepoint: 2,
				duplicatedInstruction: 1,
				genericTwin: 1,
				admissionCheck: 2,
				materializationPath: 4,
				stateSynchronization: 2,
				binaryByteDivisor: 32,
			},
			runtime: {
				instruction: 1,
				helperCall: 6,
				guard: 1,
				boxingOperation: 2,
				rootSlot: 1,
				safepoint: 2,
				admissionCheck: 1,
				materializationPath: 6,
				stateSynchronization: 2,
			},
			loopFrequency: { base: 4, maximumDepth: 3 },
			admission: {
				maximumEstimatedBinaryBytes: 16_384,
				baseCompilerWork: 128,
				benefitLoopScale: 16,
			},
		});
	});

	it("applies the recorded weights deterministically", () => {
		const cost = coreGeneratedCodeOverheadCost({
			guards: 1,
			duplicatedInstructions: 2,
			genericTwins: 3,
			admissionChecks: 4,
			materializationPaths: 5,
			stateSynchronizations: 6,
			loopFrequency: 7,
		});

		expect(cost).toMatchObject({
			estimatedCStatements: 45,
			estimatedBinaryBytes: 368,
			compileScore: 104,
			runtimeScore: 329,
		});
		expect(coreGeneratedCodeAdmitsRegion(cost, 0)).toBe(true);
	});
});
