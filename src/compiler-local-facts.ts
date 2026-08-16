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

export interface ExactFreshMapValue {
	readonly getCalls: number;
	readonly setCalls: number;
}

export interface ExactFreshMapUseAnalysis {
	readonly fact: CompilerFact<ExactFreshMapValue>;
	readonly allocation?: Extract<IRInstruction, { type: "construct" }>;
	readonly calls?: ReadonlySet<Extract<IRInstruction, { type: "call" }>>;
}

/**
 * Prove a zero-argument intrinsic Map allocation stays function-private and is
 * used only by exact get/set property-call pairs. The proof is whole-value: one
 * result is cached for every site on the same allocation, so loops and multiple
 * operations do not multiply compiler work. Any identity exposure, named write,
 * dynamic method extraction, constructor iterable, or used Map#set result rejects
 * the complete region.
 */
export function analyzeExactFreshMapUse(
	fn: IRFunction,
	receiver: number,
): ExactFreshMapUseAnalysis {
	const index = buildIRRegisterIndex(fn);
	const moveRoot = (initial: number): number => {
		let register = initial;
		const seen = new Set<number>();
		while (!seen.has(register)) {
			seen.add(register);
			const definition = index.uniqueDefinitions.get(register);
			if (definition?.type !== "move") break;
			register = definition.registers[1];
		}
		return register;
	};
	const allocation = index.uniqueDefinitions.get(moveRoot(receiver));
	if (allocation?.type !== "construct" || allocation.registers.length !== 2) {
		return { fact: unknownFact("representation-mismatch") };
	}
	const constructor = index.uniqueDefinitions.get(moveRoot(allocation.registers[1]));
	if (constructor?.type !== "loadIntrinsic" || constructor.intrinsic !== "Map") {
		return { fact: unknownFact("representation-mismatch"), allocation };
	}

	const aliases = new Set<number>([allocation.registers[0]]);
	const aliasWorklist = [allocation.registers[0]];
	while (aliasWorklist.length > 0) {
		const alias = aliasWorklist.pop()!;
		for (const use of index.uses.get(alias) ?? []) {
			if (use.instruction.type !== "move" || use.position !== 1) continue;
			const target = use.instruction.registers[0];
			if (index.uniqueDefinitions.get(target) !== use.instruction) continue;
			if (!aliases.has(target)) {
				aliases.add(target);
				aliasWorklist.push(target);
			}
		}
	}
	if (!aliases.has(receiver)) {
		return { fact: unknownFact("conflicting-control-flow"), allocation };
	}

	const properties = new Set<IRInstruction>();
	const calls = new Set<Extract<IRInstruction, { type: "call" }>>();
	let getCalls = 0;
	let setCalls = 0;
	for (const alias of aliases) {
		for (const use of index.uses.get(alias) ?? []) {
			const property = use.instruction;
			if (property.type !== "loadPropertyStatic" || use.position !== 1) continue;
			const calleeUses = index.uses.get(property.registers[0]) ?? [];
			const callUse = calleeUses[0];
			if (
				calleeUses.length !== 1 ||
				callUse?.position !== 1 ||
				callUse.instruction.type !== "call" ||
				!aliases.has(callUse.instruction.registers[2])
			) {
				return { fact: unknownFact("observable-identity"), allocation };
			}
			const operation = callUse.instruction.knownBuiltinCall?.operation;
			if (operation !== "Map.prototype.get" && operation !== "Map.prototype.set") {
				return { fact: unknownFact("unsupported-consumer"), allocation };
			}
			if (
				operation === "Map.prototype.set" &&
				(index.uses.get(callUse.instruction.registers[0])?.length ?? 0) !== 0
			) {
				return { fact: unknownFact("observable-identity"), allocation };
			}
			properties.add(property);
			calls.add(callUse.instruction);
			if (operation === "Map.prototype.get") getCalls++;
			else setCalls++;
		}
	}

	for (const alias of aliases) {
		for (const use of index.uses.get(alias) ?? []) {
			if (use.instruction.type === "move" && use.position === 1) continue;
			if (properties.has(use.instruction) && use.position === 1) continue;
			if (
				use.instruction.type === "call" &&
				calls.has(use.instruction) &&
				use.position === 2
			) {
				continue;
			}
			return { fact: unknownFact("observable-identity"), allocation };
		}
	}
	if (calls.size === 0) {
		return { fact: unknownFact("unsupported-consumer"), allocation };
	}
	return {
		allocation,
		calls,
		fact: knownFact(
			{ getCalls, setCalls },
			{
				scope: { kind: "function", id: fn.functionIndex },
				dependencies: [],
				obligations: [],
				origin: "exact-fresh-map-use-analysis",
			},
		),
	};
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
		readonly property: Extract<
			IRInstruction,
			{ type: "loadProperty" | "loadPropertyStatic" }
		>;
		readonly call: Extract<IRInstruction, { type: "call" }>;
	},
): ExactFreshArrayUseAnalysis {
	const index = buildIRRegisterIndex(fn, { locations: true });
	let allocationRegister = site.receiver;
	const rootSeen = new Set<number>();
	while (!rootSeen.has(allocationRegister)) {
		rootSeen.add(allocationRegister);
		const definition = index.uniqueDefinitions.get(allocationRegister);
		if (definition?.type !== "move") break;
		allocationRegister = definition.registers[1];
	}
	const allocation = index.uniqueDefinitions.get(allocationRegister);
	if (allocation?.type !== "createArray") {
		return { fact: unknownFact("representation-mismatch") };
	}
	const aliases = new Set<number>([allocation.registers[0]]);
	const aliasWorklist = [allocation.registers[0]];
	while (aliasWorklist.length > 0) {
		const alias = aliasWorklist.pop()!;
		for (const use of index.uses.get(alias) ?? []) {
			if (use.instruction.type !== "move" || use.position !== 1) continue;
			const target = use.instruction.registers[0];
			if (index.uniqueDefinitions.get(target) !== use.instruction) continue;
			if (!aliases.has(target)) {
				aliases.add(target);
				aliasWorklist.push(target);
			}
		}
	}
	if (!aliases.has(site.receiver)) {
		return { fact: unknownFact("conflicting-control-flow"), allocation };
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
	for (const alias of aliases) {
		for (const use of index.uses.get(alias) ?? []) {
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
			if (use.position === 1 && use.instruction.type === "move") continue;
			return { fact: unknownFact("observable-identity"), allocation };
		}
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
