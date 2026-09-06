import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreDirectEntryPlan, CorePlanRepresentation } from "./core-ir-regions.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const representationProofs = new WeakMap<
	ReadonlyArray<CorePlanRepresentation>,
	{
		readonly fn: CoreFunctionStore;
		readonly versions: string;
		readonly parameters: string;
		readonly arguments: string | undefined;
		readonly constants: CoreDirectEntryPlan["constantBooleans"];
		readonly calls: string;
	}
>();

export function analyzeCoreNativeEntry(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	parameters: ReadonlyArray<CorePlanRepresentation>,
	arguments_: ReadonlyArray<CorePlanRepresentation> | undefined,
	callSites: CoreDirectEntryPlan["callSites"],
): {
	readonly valueRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
	readonly constantBooleans?: CoreDirectEntryPlan["constantBooleans"];
} {
	const mask = (representation: CorePlanRepresentation | undefined) =>
		representation === "f64"
			? COMPILER_VALUE_KIND_NUMBER
			: representation === "boolean"
				? COMPILER_VALUE_KIND_BOOLEAN
				: representation === "string"
					? COMPILER_VALUE_KIND_STRING
					: COMPILER_VALUE_KIND_TOP;
	const kinds = analyzeCoreValueKinds(fn, cfg, {
		parameterMasks: parameters.map(mask),
		operationResultMask(instruction, result) {
			if (
				arguments_ === undefined ||
				result !== fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))
			)
				return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "loadArgumentCount") return COMPILER_VALUE_KIND_NUMBER;
			if (opcode === "loadArgument" || opcode === "loadStaticArgument")
				return mask(arguments_[fn.instructionAttributes(instruction).index as number]);
			return undefined;
		},
	});
	const constants =
		arguments_ === undefined
			? []
			: coreFixedArityComparisons(fn, kinds, arguments_.length);
	const constantBooleans =
		constants.length === 0
			? undefined
			: Object.freeze(constants.map((constant) => Object.freeze(constant)));
	const valueRepresentations = Object.freeze(
		Array.from({ length: fn.valueCapacity }, (_, index): CorePlanRepresentation => {
			const value = index as CoreValueId;
			if (fn.kernel.valueLive(value) === 0) return "boxed";
			const scalar = kinds.exactScalar(value);
			return scalar === "int32" || scalar === "number" ? "f64" : (scalar ?? "boxed");
		}),
	);
	const returns = [...fn.blockIds()].flatMap((block) => {
		const terminator = fn.blockTerminator(block);
		return fn.instructionKind(terminator) === "return"
			? [
					valueRepresentations[
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator))
					]!,
				]
			: [];
	});
	const resultRepresentation =
		returns.length > 0 && returns.every((representation) => representation === returns[0])
			? returns[0]!
			: "boxed";
	representationProofs.set(valueRepresentations, {
		fn,
		versions: JSON.stringify(fn.versions),
		parameters: parameters.join(","),
		arguments: arguments_?.join(","),
		constants: constantBooleans,
		calls: callSites
			.map((site) => `${site.caller}:${site.instruction}:${site.guarded === true}`)
			.sort()
			.join(","),
	});
	return {
		valueRepresentations,
		resultRepresentation,
		...(constantBooleans === undefined ? {} : { constantBooleans }),
	};
}

export function coreNativeEntryProofIsCurrent(
	fn: CoreFunctionStore,
	entry: CoreDirectEntryPlan,
): boolean {
	if (entry.valueRepresentations === undefined)
		return (
			entry.argumentRepresentations === undefined && entry.constantBooleans === undefined
		);
	const proof = representationProofs.get(entry.valueRepresentations);
	return (
		proof?.fn === fn &&
		proof.versions === JSON.stringify(fn.versions) &&
		proof.parameters === entry.parameterRepresentations.join(",") &&
		proof.arguments === entry.argumentRepresentations?.join(",") &&
		proof.constants === entry.constantBooleans &&
		proof.calls ===
			entry.callSites
				.map((site) => `${site.caller}:${site.instruction}:${site.guarded === true}`)
				.sort()
				.join(",")
	);
}

export function coreFixedArityComparisons(
	fn: CoreFunctionStore,
	kinds: CoreValueKindAnalysis,
	argumentCount: number,
): ReadonlyArray<{
	readonly instruction: CoreInstructionId;
	readonly value: boolean;
}> {
	const memo = new Map<CoreValueId, number | undefined>();
	const number = (value: CoreValueId, remaining = 32): number | undefined => {
		if (memo.has(value)) return memo.get(value);
		if (remaining === 0 || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		memo.set(value, undefined);
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(instruction);
		const result =
			opcode === "loadArgumentCount"
				? argumentCount
				: opcode === "createNumber" || opcode === "createF64"
					? fn.instructionAttributes(instruction).value
					: opcode === "move"
						? number(
								fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
								remaining - 1,
							)
						: undefined;
		const numeric = typeof result === "number" ? result : undefined;
		memo.set(value, numeric);
		return numeric;
	};
	const constants: Array<{ instruction: CoreInstructionId; value: boolean }> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "binary"
		)
			continue;
		const start = fn.kernel.instructionOperandStart(instruction);
		const left = fn.kernel.operandAt(start);
		const right = fn.kernel.operandAt(start + 1);
		const operator = fn.instructionAttributes(instruction).operator;
		if (
			(operator === "===" || operator === "!==") &&
			(kinds.kindMask(left) & kinds.kindMask(right)) === 0
		) {
			constants.push({ instruction, value: operator === "!==" });
			continue;
		}
		const a = number(left);
		const b = number(right);
		if (a === undefined || b === undefined) continue;
		const value =
			operator === ">"
				? a > b
				: operator === ">="
					? a >= b
					: operator === "<"
						? a < b
						: operator === "<="
							? a <= b
							: operator === "===" || operator === "=="
								? a === b
								: operator === "!==" || operator === "!="
									? a !== b
									: undefined;
		if (value !== undefined) constants.push({ instruction, value });
	}
	return constants;
}

export type CoreArgumentObservation =
	| {
			readonly kind: "count-and-static-elements";
			readonly readsCount: boolean;
			readonly indices: ReadonlyArray<number>;
	  }
	| { readonly kind: "general" };

export function coreArgumentObservation(fn: CoreFunctionStore): CoreArgumentObservation {
	if (fn.metadata.mappedArguments) return { kind: "general" };
	const snapshots = new Map<CoreValueId, number>();
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") break;
		if (opcode === "loadArgument")
			snapshots.set(
				fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				fn.instructionAttributes(instruction).index as number,
			);
	}
	let readsCount = false;
	const indices = new Set<number>();
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			opcode === "createArgumentsObject" ||
			opcode === "createRestArguments" ||
			opcode === "callRestArguments"
		)
			return { kind: "general" };
		if (opcode === "loadArgumentCount") readsCount = true;
		if (opcode === "loadArgument" || opcode === "loadStaticArgument") {
			const index = fn.instructionAttributes(instruction).index;
			if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
				return { kind: "general" };
			const snapshot =
				opcode === "loadArgument"
					? fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))
					: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			// Heap-valued arguments must be copied to traced registers before any safepoint.
			if (snapshots.get(snapshot) !== index) return { kind: "general" };
			indices.add(index);
		}
	}
	return {
		kind: "count-and-static-elements",
		readsCount,
		indices: [...indices].sort((a, b) => a - b),
	};
}
