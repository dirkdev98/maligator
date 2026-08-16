import { knownFact, unknownFact } from "./compiler-facts.ts";
import type { CompilerFact } from "./compiler-facts.ts";
import { buildIRRegisterIndex } from "./ir-register-index.ts";
import type { IRFunction, IRInstruction } from "./ir.ts";

export interface ExactFreshArrayValue {
	/** Exact `LengthOfArrayLike` result at the consuming call. */
	readonly length: number;
	/** Whether every own indexed property in `[0, length)` is present. */
	readonly indexedCoverage: "complete" | "partial";
}

export interface ExactFreshArrayUseAnalysis {
	readonly fact: CompilerFact<ExactFreshArrayValue>;
	readonly allocation?: Extract<IRInstruction, { type: "createArray" }>;
}

/**
 * Prove that one Array value is created, initialized, and consumed by one
 * property-call pair without becoming observable in between. The payload is a
 * compiler fact rather than a transform-local boolean so every later consumer
 * uses the same length/coverage contract and explicit failure vocabulary.
 *
 * Numeric `defineProperty` instructions between allocation and the method Get are
 * the Array-literal/indexed-initialization surface. A dead move alias is harmless;
 * every other use exposes identity or allows the construction state to change.
 */
export function analyzeExactFreshArrayUse(
	fn: IRFunction,
	site: {
		readonly receiver: number;
		readonly callee: number;
		readonly property: Extract<IRInstruction, { type: "loadProperty" }>;
		readonly call: Extract<IRInstruction, { type: "call" }>;
	},
): ExactFreshArrayUseAnalysis {
	const index = buildIRRegisterIndex(fn, { locations: true });
	const allocation = index.uniqueDefinitions.get(site.receiver);
	if (allocation?.type !== "createArray") {
		return { fact: unknownFact("representation-mismatch") };
	}
	const allocationLocation = index.locations?.get(allocation);
	const propertyLocation = index.locations?.get(site.property);
	const callLocation = index.locations?.get(site.call);
	if (
		allocationLocation === undefined ||
		propertyLocation === undefined ||
		callLocation === undefined ||
		allocationLocation.blockIndex !== propertyLocation.blockIndex ||
		allocationLocation.blockIndex !== callLocation.blockIndex ||
		allocationLocation.instructionIndex >= propertyLocation.instructionIndex ||
		propertyLocation.instructionIndex >= callLocation.instructionIndex
	) {
		return { fact: unknownFact("conflicting-control-flow"), allocation };
	}

	const calleeUses = index.uses.get(site.callee) ?? [];
	if (
		calleeUses.length !== 1 ||
		calleeUses[0]?.instruction !== site.call ||
		calleeUses[0]?.position !== 1
	) {
		return { fact: unknownFact("observable-identity"), allocation };
	}

	const initializedIndices = new Set<number>();
	let maximumIndex = -1;
	let sawProperty = false;
	let sawCall = false;
	for (const use of index.uses.get(site.receiver) ?? []) {
		if (use.instruction === site.property && use.position === 1) {
			sawProperty = true;
			continue;
		}
		if (use.instruction === site.call && use.position === 2) {
			sawCall = true;
			continue;
		}
		if (use.position === 0 && use.instruction.type === "defineProperty") {
			const location = index.locations?.get(use.instruction);
			const key = index.uniqueDefinitions.get(use.instruction.registers[1]);
			if (
				location?.blockIndex !== allocationLocation.blockIndex ||
				location.instructionIndex <= allocationLocation.instructionIndex ||
				location.instructionIndex >= propertyLocation.instructionIndex ||
				key?.type !== "createNumber" ||
				!Number.isInteger(key.value) ||
				key.value < 0 ||
				key.value >= 0xffff_ffff
			) {
				return { fact: unknownFact("unsupported-consumer"), allocation };
			}
			initializedIndices.add(key.value);
			maximumIndex = Math.max(maximumIndex, key.value);
			continue;
		}
		if (
			use.position === 1 &&
			use.instruction.type === "move" &&
			(index.uses.get(use.instruction.registers[0]) ?? []).length === 0
		) {
			continue;
		}
		return { fact: unknownFact("observable-identity"), allocation };
	}
	if (!sawProperty || !sawCall) {
		return { fact: unknownFact("unsupported-consumer"), allocation };
	}

	const length = Math.max(allocation.length, maximumIndex + 1);
	const indexedCoverage =
		initializedIndices.size === length ? ("complete" as const) : ("partial" as const);
	return {
		allocation,
		fact: knownFact(
			{ length, indexedCoverage },
			{
				scope: { kind: "function", id: fn.functionIndex },
				dependencies: [],
				obligations: [],
				origin: "exact-fresh-array-use-analysis",
			},
		),
	};
}
