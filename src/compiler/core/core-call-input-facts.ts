import { builtinInputContract } from "../shared/host-result-contracts.ts";
import type {
	HostInputBrand,
	HostInputContract,
} from "../shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export const CORE_CALL_INPUT_FACTS_ATTRIBUTE = "callInputFacts";

export interface CoreCallInputFact {
	readonly index: number;
	readonly mask: number;
	readonly brand?: HostInputBrand;
}

export interface CoreCallInputFacts {
	readonly onTrue?: ReadonlyArray<CoreCallInputFact>;
	readonly onFalse?: ReadonlyArray<CoreCallInputFact>;
	readonly onReturn?: ReadonlyArray<CoreCallInputFact>;
	readonly onFulfill?: ReadonlyArray<CoreCallInputFact>;
}

export function instantiateCoreCallInputFacts(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	contract: HostInputContract | undefined,
	fulfillment = false,
): CoreCallInputFacts | undefined {
	if (contract === undefined || contract.unavailable !== undefined) return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	if (opcode !== "call" && opcode !== "construct" && opcode !== "callKnown")
		return undefined;
	const argumentStart = opcode === "call" ? 2 : 1;
	const spread = attributes.argumentMode !== undefined;
	const limit = fn.kernel.instructionOperandCount(instruction) - Number(spread);
	const instantiate = (key: keyof CoreCallInputFacts) => {
		const facts: Array<CoreCallInputFact> = [];
		for (const { argument, mask, brand } of contract[key] ?? []) {
			if (spread && (argument === "all" || argument === "last")) continue;
			const start =
				argument === "receiver"
					? argumentStart - 1
					: argument === "all"
						? argumentStart
						: argument === "last"
							? Math.max(argumentStart, limit - 1)
							: argumentStart + argument;
			const end = argument === "all" ? limit : Math.min(start + 1, limit);
			for (let index = start; index < end; index++)
				facts.push({ index, mask, ...(brand === undefined ? {} : { brand }) });
		}
		return facts.length === 0 ? undefined : facts;
	};
	const onTrue = instantiate("onTrue");
	const onFalse = instantiate("onFalse");
	const onReturn = instantiate("onReturn");
	const onFulfill = fulfillment ? instantiate("onFulfill") : undefined;
	return onTrue === undefined &&
		onFalse === undefined &&
		onReturn === undefined &&
		onFulfill === undefined
		? undefined
		: { onTrue, onFalse, onReturn, onFulfill };
}

export function coreCallInputFacts(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreCallInputFacts | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "call" && opcode !== "construct" && opcode !== "callKnown")
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	const construct = opcode === "construct" || attributes.construct === true;
	let operation = attributes.operation;
	if (opcode !== "callKnown") {
		const recorded = attributes[CORE_CALL_INPUT_FACTS_ATTRIBUTE] as
			| CoreCallInputFacts
			| undefined;
		if (recorded !== undefined) return recorded;
		const callee = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		if (fn.kernel.valueDefinitionKind(callee) !== 1) return undefined;
		const load = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
		const loadAttributes = fn.instructionAttributes(load);
		if (fn.instructionOpcodeName(load) === "loadPrimordial") {
			const nodeIndex = loadAttributes.nodeIndex;
			operation =
				typeof nodeIndex === "number"
					? getPrimordialCatalog().nodes[nodeIndex]?.[0]
					: undefined;
		} else if (fn.instructionOpcodeName(load) === "loadIntrinsic")
			operation = loadAttributes.intrinsic;
		else return undefined;
	}
	return typeof operation === "string"
		? instantiateCoreCallInputFacts(
				fn,
				instruction,
				builtinInputContract(operation, construct),
			)
		: undefined;
}
