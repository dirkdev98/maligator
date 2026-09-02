import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreBlockId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

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
	readonly admissionChecks: number;
	readonly materializationPaths: number;
	readonly stateSynchronizations: number;
	readonly loopFrequency: number;
	readonly estimatedCStatements: number;
	readonly estimatedBinaryBytes: number;
	readonly compileScore: number;
	readonly runtimeScore: number;
}

export interface CoreGeneratedCodeInstructionSite {
	readonly instruction: CoreInstructionId;
	readonly loopFrequency?: number;
}

export interface CoreGeneratedCodeOverhead {
	readonly guards?: number;
	readonly duplicatedInstructions?: number;
	readonly genericTwins?: number;
	readonly admissionChecks?: number;
	readonly materializationPaths?: number;
	readonly stateSynchronizations?: number;
	readonly loopFrequency?: number;
}

function generatedCodeCost(
	fn: CoreFunctionStore | undefined,
	sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
	overhead: CoreGeneratedCodeOverhead,
): CoreGeneratedCodeCost {
	let helperCalls = 0;
	let guards = overhead.guards ?? 0;
	let boxingOperations = 0;
	let rootSlots = 0;
	let safepoints = 0;
	let loopFrequency = overhead.loopFrequency ?? 1;
	let inputOperands = 0;
	for (const { instruction, loopFrequency: siteFrequency = 1 } of sites) {
		if (
			fn === undefined ||
			!fn.isInstructionLive(instruction) ||
			fn.instructionKind(instruction) !== "operation"
		)
			continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const effects = coreInstructionEffects(fn, instruction);
		if (effects.callsUserCode || effects.mayGc || LOWERED_HELPER_OPCODES.has(opcode)) {
			helperCalls++;
		}
		if (opcode === "guardFunctionIndex") guards++;
		if (BOXING_OPCODES.has(opcode)) boxingOperations++;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		if (effects.mayGc) {
			safepoints++;
			const seen = new Set<number>();
			for (let offset = 0; offset < operandCount; offset++) {
				const value = fn.kernel.operandAt(operandStart + offset);
				if (!seen.has(value) && fn.valueRepresentation(value) === "boxed") rootSlots++;
				seen.add(value);
			}
		}
		loopFrequency = Math.max(loopFrequency, siteFrequency);
		inputOperands += operandCount;
	}
	const instructions = sites.length;
	const duplicatedInstructions = overhead.duplicatedInstructions ?? 0;
	const genericTwins = overhead.genericTwins ?? 0;
	const admissionChecks = overhead.admissionChecks ?? 0;
	const materializationPaths = overhead.materializationPaths ?? 0;
	const stateSynchronizations = overhead.stateSynchronizations ?? 0;
	const estimatedCStatements =
		instructions +
		helperCalls * 2 +
		guards * 2 +
		boxingOperations +
		genericTwins +
		admissionChecks * 2 +
		materializationPaths * 4 +
		stateSynchronizations * 2;
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
		admissionChecks * 2 +
		materializationPaths * 4 +
		stateSynchronizations * 2 +
		Math.ceil(estimatedBinaryBytes / 32);
	const runtimeScore =
		loopFrequency *
		(instructions +
			helperCalls * 6 +
			guards +
			boxingOperations * 2 +
			rootSlots +
			safepoints * 2 +
			admissionChecks +
			materializationPaths * 6 +
			stateSynchronizations * 2);
	return Object.freeze({
		instructions,
		helperCalls,
		guards,
		boxingOperations,
		rootSlots,
		safepoints,
		duplicatedInstructions,
		genericTwins,
		admissionChecks,
		materializationPaths,
		stateSynchronizations,
		loopFrequency,
		estimatedCStatements,
		estimatedBinaryBytes,
		compileScore,
		runtimeScore,
	});
}

export interface CoreGeneratedCodeCostModel {
	forInstructions(
		sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
		overhead?: CoreGeneratedCodeOverhead,
	): CoreGeneratedCodeCost;
	forRegion(
		claimedInstructions: ReadonlyArray<CoreInstructionId>,
		overhead?: CoreGeneratedCodeOverhead,
	): CoreGeneratedCodeCost;
}

export function coreGeneratedCodeCostModel(
	fn: CoreFunctionStore,
	cfg?: CoreControlFlow,
): CoreGeneratedCodeCostModel {
	const frequency = new Map<CoreInstructionId, number>();
	if (cfg !== undefined) {
		for (const block of fn.blockIds()) {
			const loopFrequency = coreBlockLoopFrequency(cfg, block);
			for (const instruction of fn.instructionIds(block)) {
				frequency.set(instruction, loopFrequency);
			}
		}
	}
	return Object.freeze({
		forInstructions(
			sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
			overhead: CoreGeneratedCodeOverhead = {},
		) {
			return generatedCodeCost(fn, sites, overhead);
		},
		forRegion(
			claimedInstructions: ReadonlyArray<CoreInstructionId>,
			overhead: CoreGeneratedCodeOverhead = {},
		) {
			return generatedCodeCost(
				fn,
				claimedInstructions.map((instruction) => ({
					instruction,
					loopFrequency: frequency.get(instruction) ?? 1,
				})),
				overhead,
			);
		},
	});
}

export function coreBlockLoopFrequency(cfg: CoreControlFlow, block: CoreBlockId): number {
	let depth = 0;
	for (const loop of cfg.loops) {
		if (loop.blocks.has(block)) depth++;
	}
	return 4 ** Math.min(depth, 3);
}

export function coreGeneratedCodeCostForInstructions(
	fn: CoreFunctionStore,
	sites: ReadonlyArray<CoreGeneratedCodeInstructionSite>,
	overhead: CoreGeneratedCodeOverhead = {},
): CoreGeneratedCodeCost {
	return coreGeneratedCodeCostModel(fn).forInstructions(sites, overhead);
}

export function coreGeneratedCodeOverheadCost(
	overhead: CoreGeneratedCodeOverhead,
): CoreGeneratedCodeCost {
	return generatedCodeCost(undefined, [], overhead);
}

export function coreGeneratedCodeCostForRegion(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	claimedInstructions: ReadonlyArray<CoreInstructionId>,
	overhead: CoreGeneratedCodeOverhead = {},
): CoreGeneratedCodeCost {
	return coreGeneratedCodeCostModel(fn, cfg).forRegion(claimedInstructions, overhead);
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
