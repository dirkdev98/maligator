import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	compilerOperatorInputKindsHaveExactNativeSemantics,
} from "../shared/compiler-value-kinds.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreDirectEntryPlan, CorePlanRepresentation } from "./core-ir-regions.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type { CoreFunctionStore, CoreFunctionVersions } from "./core-store.ts";

const representationProofs = new WeakMap<
	ReadonlyArray<CorePlanRepresentation>,
	{
		readonly fn: CoreFunctionStore;
		readonly versions: CoreFunctionVersions;
		readonly parameters: ReadonlyArray<CorePlanRepresentation>;
		readonly arguments: ReadonlyArray<CorePlanRepresentation> | undefined;
		readonly operatorInputs: CoreDirectEntryPlan["operatorInputs"];
		readonly constants: CoreDirectEntryPlan["constantBooleans"];
		readonly calls: CoreDirectEntryPlan["callSites"];
		readonly fields: CoreDirectEntryPlan["fieldParameters"];
	}
>();

export function analyzeCoreNativeEntry(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	parameters: ReadonlyArray<CorePlanRepresentation>,
	arguments_: ReadonlyArray<CorePlanRepresentation> | undefined,
	callSites: CoreDirectEntryPlan["callSites"],
	fields?: CoreDirectEntryPlan["fieldParameters"],
	exactOperationResultMasks: ReadonlyMap<CoreInstructionId, number> = new Map(),
): {
	readonly valueRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
	readonly constantBooleans?: CoreDirectEntryPlan["constantBooleans"];
	readonly operatorInputs?: CoreDirectEntryPlan["operatorInputs"];
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
			const exact = exactOperationResultMasks.get(instruction);
			if (exact !== undefined) return exact;
			if (
				fields !== undefined &&
				(fields.loads.some((load) => load.instruction === instruction) ||
					fn.instructionOpcodeName(instruction) === "call" ||
					fn.instructionOpcodeName(instruction) === "callKnown")
			)
				return COMPILER_VALUE_KIND_NUMBER;
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
	const inputs = Object.freeze(
		[...fn.instructionIds()].flatMap((instruction) => {
			if (fn.instructionKind(instruction) !== "operation") return [];
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "unary" && opcode !== "binary") return [];
			const start = fn.kernel.instructionOperandStart(instruction);
			const masks = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, i) => kinds.kindMask(fn.kernel.operandAt(start + i)),
			);
			return compilerOperatorInputKindsHaveExactNativeSemantics(
				opcode,
				fn.instructionAttributes(instruction).operator,
				masks,
			)
				? [Object.freeze({ instruction, masks: Object.freeze(masks) })]
				: [];
		}),
	);
	const operatorInputs = inputs.length === 0 ? undefined : inputs;
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
		versions: fn.versions,
		parameters: [...parameters],
		arguments: arguments_ === undefined ? undefined : [...arguments_],
		constants: constantBooleans,
		operatorInputs,
		fields:
			fields === undefined
				? undefined
				: { keys: [...fields.keys], loads: fields.loads.map((load) => ({ ...load })) },
		calls: callSites.map((site) => ({ ...site })),
	});
	return {
		valueRepresentations,
		resultRepresentation,
		operatorInputs,
		...(constantBooleans === undefined ? {} : { constantBooleans }),
	};
}

export function coreNativeEntryProofIsCurrent(
	fn: CoreFunctionStore,
	entry: CoreDirectEntryPlan,
): boolean {
	if (entry.valueRepresentations === undefined)
		return (
			entry.argumentRepresentations === undefined &&
			entry.constantBooleans === undefined &&
			entry.fieldParameters === undefined &&
			entry.operatorInputs === undefined
		);
	const proof = representationProofs.get(entry.valueRepresentations);
	const same = <T>(
		left: ReadonlyArray<T> | undefined,
		right: ReadonlyArray<T> | undefined,
	) =>
		left === undefined
			? right === undefined
			: right !== undefined &&
				left.length === right.length &&
				left.every((value, i) => value === right[i]);
	return (
		proof?.fn === fn &&
		coreFunctionVersionsAreCurrent(fn, proof.versions) &&
		same(proof.parameters, entry.parameterRepresentations) &&
		same(proof.arguments, entry.argumentRepresentations) &&
		proof.constants === entry.constantBooleans &&
		proof.operatorInputs === entry.operatorInputs &&
		same(proof.fields?.keys, entry.fieldParameters?.keys) &&
		(proof.fields === undefined ||
			(entry.fieldParameters !== undefined &&
				proof.fields.loads.length === entry.fieldParameters.loads.length &&
				proof.fields.loads.every(
					(load, i) =>
						load.instruction === entry.fieldParameters!.loads[i]!.instruction &&
						load.field === entry.fieldParameters!.loads[i]!.field,
				))) &&
		proof.calls.length === entry.callSites.length &&
		proof.calls.every((site, i) => {
			const current = entry.callSites[i]!;
			return (
				site.caller === current.caller &&
				site.instruction === current.instruction &&
				(site.guarded === true) === (current.guarded === true) &&
				site.fieldObject === current.fieldObject &&
				site.numericSortCallback === current.numericSortCallback &&
				site.numericSortCallbackViaCall === current.numericSortCallbackViaCall
			);
		})
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
			readonly restStarts: ReadonlyArray<number>;
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
	const restStarts = new Set<number>();
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createArgumentsObject" || opcode === "callRestArguments")
			return { kind: "general" };
		if (opcode === "createRestArguments") {
			const startIndex = fn.instructionAttributes(instruction).startIndex;
			const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			if (
				typeof startIndex !== "number" ||
				!Number.isSafeInteger(startIndex) ||
				startIndex < 0
			)
				return { kind: "general" };
			for (
				let use = fn.kernel.valueFirstUse(result);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const user = fn.kernel.useInstruction(use);
				if (fn.instructionKind(user) !== "operation") return { kind: "general" };
				const userOpcode = fn.instructionOpcodeName(user);
				if (fn.kernel.operandAt(fn.kernel.instructionOperandStart(user)) !== result)
					return { kind: "general" };
				if (userOpcode === "loadProperty") continue;
				if (userOpcode === "loadPropertyStatic") continue;
				return { kind: "general" };
			}
			restStarts.add(startIndex);
			continue;
		}
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
		restStarts: [...restStarts].sort((a, b) => a - b),
	};
}
