import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";

const BOXING_OPCODES = new Set(["binary", "unary", "toPropertyKey", "requireCoercible"]);

const LOWERED_HELPER_OPCODES = new Set([
	"mathBinaryNumber",
	"mathUnaryNumber",
	"selectShapeCase",
]);

export interface CoreGeneratedCodeCost {
	readonly instructions: number;
	readonly helperCalls: number;
	readonly guards: number;
	readonly boxingOperations: number;
	readonly rootSlots: number;
	readonly safepoints: number;
	readonly duplicatedInstructions: number;
	readonly genericTwins: number;
	readonly loopFrequency: number;
	readonly estimatedCStatements: number;
	readonly estimatedBinaryBytes: number;
	readonly compileScore: number;
	readonly runtimeScore: number;
}

export interface CoreGeneratedCodeInstructionSite {
	readonly instruction: CoreInstruction;
	readonly loopFrequency?: number;
}

export interface CoreGeneratedCodeOverhead {
	readonly guards?: number;
	readonly duplicatedInstructions?: number;
	readonly genericTwins?: number;
	readonly loopFrequency?: number;
}

function generatedCodeCost(
	fn: CoreFunction | undefined,
	sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
	overhead: CoreGeneratedCodeOverhead,
): CoreGeneratedCodeCost {
	const boxed =
		fn === undefined
			? undefined
			: new Set<CoreValueId>(
					fn.values
						.filter(({ representation }) => representation === "boxed")
						.map(({ id }) => id),
				);
	let helperCalls = 0;
	let guards = overhead.guards ?? 0;
	let boxingOperations = 0;
	let rootSlots = 0;
	let safepoints = 0;
	let loopFrequency = overhead.loopFrequency ?? 1;
	let inputOperands = 0;
	for (const { instruction, loopFrequency: siteFrequency = 1 } of sites) {
		const effects = coreInstructionEffects(instruction);
		const helper =
			effects.callsUserCode ||
			effects.mayGc ||
			LOWERED_HELPER_OPCODES.has(instruction.opcode);
		if (helper) helperCalls++;
		if (instruction.opcode === "guardFunctionIndex") guards++;
		if (BOXING_OPCODES.has(instruction.opcode)) boxingOperations++;
		if (effects.mayGc) {
			safepoints++;
			if (boxed !== undefined) {
				rootSlots += new Set(instruction.inputs.filter((value) => boxed.has(value))).size;
			}
		}
		loopFrequency = Math.max(loopFrequency, siteFrequency);
		inputOperands += instruction.inputs.length;
	}
	const instructions = sites.length;
	const duplicatedInstructions = overhead.duplicatedInstructions ?? 0;
	const genericTwins = overhead.genericTwins ?? 0;
	const estimatedCStatements =
		instructions + helperCalls * 2 + guards * 2 + boxingOperations + genericTwins;
	const estimatedBinaryBytes =
		estimatedCStatements * 8 + inputOperands * 2 + duplicatedInstructions * 4;
	const compileScore =
		estimatedCStatements +
		helperCalls * 3 +
		guards * 2 +
		boxingOperations +
		rootSlots +
		safepoints * 2 +
		duplicatedInstructions +
		genericTwins +
		Math.ceil(estimatedBinaryBytes / 32);
	const runtimeScore =
		loopFrequency *
		(instructions +
			helperCalls * 6 +
			guards +
			boxingOperations * 2 +
			rootSlots +
			safepoints * 2);
	return {
		instructions,
		helperCalls,
		guards,
		boxingOperations,
		rootSlots,
		safepoints,
		duplicatedInstructions,
		genericTwins,
		loopFrequency,
		estimatedCStatements,
		estimatedBinaryBytes,
		compileScore,
		runtimeScore,
	};
}

export function coreBlockLoopFrequency(cfg: CoreControlFlow, block: CoreBlockId): number {
	let depth = 0;
	for (const loop of cfg.loops) {
		if (loop.blocks.has(block)) depth++;
	}
	return 4 ** Math.min(depth, 3);
}

export function coreGeneratedCodeCostForInstructions(
	fn: CoreFunction,
	sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
	overhead: CoreGeneratedCodeOverhead = {},
): CoreGeneratedCodeCost {
	return generatedCodeCost(fn, sites, overhead);
}

export function coreGeneratedCodeOverheadCost(
	overhead: CoreGeneratedCodeOverhead,
): CoreGeneratedCodeCost {
	return generatedCodeCost(undefined, [], overhead);
}

export function coreGeneratedCodeCostForRegion(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	claimedInstructions: ReadonlyArray<CoreInstructionId>,
	overhead: CoreGeneratedCodeOverhead,
): CoreGeneratedCodeCost {
	const claimed = new Set(claimedInstructions);
	const sites: Array<CoreGeneratedCodeInstructionSite> = [];
	for (const block of fn.blocks) {
		const frequency = coreBlockLoopFrequency(cfg, block.id);
		for (const instruction of block.instructions) {
			if (claimed.has(instruction.id)) {
				sites.push({ instruction, loopFrequency: frequency });
			}
		}
	}
	return generatedCodeCost(fn, sites, overhead);
}

export function coreGeneratedCodeAdmitsRegion(
	cost: CoreGeneratedCodeCost,
	benefitScore: number,
): boolean {
	return (
		cost.estimatedBinaryBytes <= 16_384 &&
		cost.compileScore <= 128 + benefitScore * cost.loopFrequency * 16
	);
}

export function coreGeneratedCodeAdmitsGuardedDispatch(
	cost: CoreGeneratedCodeCost,
): boolean {
	const avoidedGenericDispatch = cost.loopFrequency * 3;
	const runtimeGuard = cost.loopFrequency;
	return avoidedGenericDispatch - runtimeGuard >= cost.compileScore;
}
