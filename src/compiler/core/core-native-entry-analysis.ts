import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import { CORE_BUILTIN_CALLBACK_EFFECT_FACT } from "./core-builtin-effects.ts";
import { analyzeCoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import type { CoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import { analyzeCoreLoopInductions } from "./core-ir-loops.ts";
import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreDirectEntryPlan, CorePlanRepresentation } from "./core-ir-regions.ts";
import type {
	CoreValueKindAnalysis,
	CoreValueKindInputs,
} from "./core-ir-value-kinds.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { analyzeCoreNativeEntryControlFlow } from "./core-native-entry-reachability.ts";
import type { CoreNativeEntryControlFlow } from "./core-native-entry-reachability.ts";
import { coreInstructionFacts } from "./core-native-instruction-facts.ts";
import type { CoreInstructionRangeQuery } from "./core-native-instruction-facts.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

const representationProofs = new WeakMap<
	ReadonlyArray<CorePlanRepresentation>,
	{
		readonly fn: CoreFunctionStore;
		readonly program: CoreProgram;
		readonly programFlowRevision: number | undefined;
		readonly versions: CoreFunctionVersions;
		readonly resultRepresentation: CorePlanRepresentation;
		readonly controlFlow: CoreNativeEntryControlFlow | undefined;
		readonly parameters: ReadonlyArray<CorePlanRepresentation>;
		readonly arguments: ReadonlyArray<CorePlanRepresentation> | undefined;
		readonly instructionFacts: CoreDirectEntryPlan["instructionFacts"];
		readonly constants: CoreDirectEntryPlan["constantBooleans"];
		readonly calls: CoreDirectEntryPlan["callSites"];
		readonly callOverrides: CoreDirectEntryPlan["callOverrides"];
		readonly fields: CoreDirectEntryPlan["fieldParameters"];
		readonly resultFields: CoreDirectEntryPlan["resultFields"];
		readonly recordParameters: CoreDirectEntryPlan["recordParameters"];
	}
>();

export function analyzeCoreNativeEntry(
	program: CoreProgram,
	cfg: CoreControlFlow,
	parameters: ReadonlyArray<CorePlanRepresentation>,
	arguments_: ReadonlyArray<CorePlanRepresentation> | undefined,
	callSites: CoreDirectEntryPlan["callSites"],
	fields?: CoreDirectEntryPlan["fieldParameters"],
	exactOperationResultMasks: ReadonlyMap<CoreInstructionId, number> = new Map(),
	callOverrides?: CoreDirectEntryPlan["callOverrides"],
	resultFields?: CoreDirectEntryPlan["resultFields"],
	recordParameters?: CoreDirectEntryPlan["recordParameters"],
): {
	readonly valueRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
	readonly constantBooleans?: CoreDirectEntryPlan["constantBooleans"];
	readonly instructionFacts?: CoreDirectEntryPlan["instructionFacts"];
} {
	const fn = program.function(cfg.function);
	const mask = (representation: CorePlanRepresentation | undefined) =>
		representation === "f64"
			? COMPILER_VALUE_KIND_NUMBER
			: representation === "boolean"
				? COMPILER_VALUE_KIND_BOOLEAN
				: representation === "string"
					? COMPILER_VALUE_KIND_STRING
					: COMPILER_VALUE_KIND_TOP;
	const kindInputs: CoreValueKindInputs = {
		parameterMasks: parameters.map(mask),
		operationResultMask(instruction, result) {
			const exact = exactOperationResultMasks.get(instruction);
			if (exact !== undefined) return exact;
			if (fields !== undefined) {
				const field = fields.loads.find((load) => load.instruction === instruction);
				if (field !== undefined) return mask(fields.representations[field.field]);
				if (fields.numericCalls.includes(instruction)) return COMPILER_VALUE_KIND_NUMBER;
			}
			if (
				arguments_ === undefined ||
				result !== fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))
			)
				return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "loadArgument" || opcode === "loadStaticArgument")
				return mask(arguments_[fn.instructionAttributes(instruction).index as number]);
			return undefined;
		},
	};
	let kinds = analyzeCoreValueKinds(program, fn, cfg, kindInputs);
	const instructions = cfg.reversePostorder.flatMap((block) => [
		...fn.bodyInstructionIds(block),
		fn.blockTerminator(block),
	]);
	let ranges: CoreLoopInductionAnalysis | undefined;
	let controlFlow: CoreNativeEntryControlFlow | undefined;
	const range: CoreInstructionRangeQuery = (value, block) =>
		(ranges ??= analyzeCoreLoopInductions(
			program,
			fn,
			cfg,
			coreCanonicalValueRoots(fn, cfg, controlFlow?.edges),
			(value) => kinds.exactScalar(value),
			(value) => kinds.kindMask(value),
		)).range(value, block);
	let constants =
		arguments_ === undefined
			? []
			: coreFixedArityComparisons(fn, instructions, kinds, arguments_.length);
	const hasMerge = [...fn.blockIds()].some(
		(block) =>
			block !== fn.entry &&
			fn.kernel.blockParameterCount(block) > 0 &&
			(cfg.predecessors[block]?.length ?? 0) > 1,
	);
	const returnValues = [...fn.blockIds()].flatMap((block) => {
		const terminator = fn.blockTerminator(block);
		return fn.instructionKind(terminator) === "return"
			? [
					{
						block,
						value: fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
					},
				]
			: [];
	});
	const distinct = new Set(
		returnValues.map(({ value }) => kinds.scalarKind(value) ?? "boxed"),
	);
	controlFlow =
		hasMerge ||
		distinct.size > 1 ||
		instructions.some(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "call",
		)
			? analyzeCoreNativeEntryControlFlow(program, fn, cfg, kinds, constants, range)
			: undefined;
	if (hasMerge && controlFlow !== undefined) {
		// Exhausting the monotone refinement budget leaves conservative facts.
		let previousSize = cfg.successors.reduce(
			(count, edges) => count + (edges?.length ?? 0),
			0,
		);
		const cost = Math.max(1, instructions.length + fn.valueCapacity);
		let remaining = Math.max(4096, instructions.length * 8);
		while (controlFlow.edges.size < previousSize && remaining >= cost) {
			remaining -= cost;
			previousSize = controlFlow.edges.size;
			kinds = analyzeCoreValueKinds(program, fn, cfg, {
				...kindInputs,
				controlEdges: controlFlow.edges,
			});
			ranges = undefined;
			constants =
				arguments_ === undefined
					? []
					: coreFixedArityComparisons(fn, instructions, kinds, arguments_.length);
			controlFlow = analyzeCoreNativeEntryControlFlow(
				program,
				fn,
				cfg,
				kinds,
				constants,
				range,
				controlFlow.edges,
			);
		}
	}
	let conditional: CoreConditionalValueKinds | undefined;
	const inputKinds: CoreConditionalValueKinds = {
		kindMask(value, block) {
			const mask = kinds.kindMask(value);
			if ((mask & (mask - 1)) === 0) return mask;
			return (conditional ??= analyzeCoreConditionalValueKinds(
				program,
				fn,
				cfg,
				(value) => kinds.kindMask(value),
			)).kindMask(value, block);
		},
	};
	let callbackEffectRevision: number | undefined;
	const inputs = Object.freeze(
		instructions.flatMap((instruction) => {
			const refinement = fn.instructionEffectRefinement(instruction);
			if (
				refinement !== undefined &&
				fn.fact(refinement.proof).kind === CORE_BUILTIN_CALLBACK_EFFECT_FACT
			)
				callbackEffectRevision = program.programFlowRevision;
			return [
				Object.freeze({
					instruction,
					...coreInstructionFacts(
						program,
						fn,
						instruction,
						kinds,
						inputKinds,
						true,
						range,
					),
				}),
			];
		}),
	);
	const instructionFacts = inputs.length === 0 ? undefined : inputs;
	const constantBooleans =
		constants.length === 0
			? undefined
			: Object.freeze(constants.map((constant) => Object.freeze(constant)));
	const valueRepresentations = Object.freeze(
		Array.from({ length: fn.valueCapacity }, (_, index): CorePlanRepresentation => {
			const value = index as CoreValueId;
			if (fn.kernel.valueLive(value) === 0) return "boxed";
			const scalar = kinds.scalarKind(value);
			return scalar === "number" ? "f64" : (scalar ?? "boxed");
		}),
	);
	const liveReturns = returnValues.filter(
		({ block }) => controlFlow === undefined || controlFlow.blocks.has(block),
	);
	const resultRepresentation =
		liveReturns.length > 0 &&
		liveReturns.every(
			({ value }) =>
				valueRepresentations[value] === valueRepresentations[liveReturns[0]!.value],
		)
			? valueRepresentations[liveReturns[0]!.value]!
			: "boxed";
	representationProofs.set(valueRepresentations, {
		fn,
		program,
		programFlowRevision: callbackEffectRevision,
		versions: fn.versions,
		resultRepresentation,
		controlFlow,
		parameters: [...parameters],
		arguments: arguments_ === undefined ? undefined : [...arguments_],
		constants: constantBooleans,
		instructionFacts,
		fields:
			fields === undefined
				? undefined
				: {
						keys: [...fields.keys],
						representations: [...fields.representations],
						loads: fields.loads.map((load) => ({ ...load })),
						numericCalls: [...fields.numericCalls],
					},
		calls: callSites.map((site) => ({ ...site })),
		callOverrides: callOverrides?.map((site) => ({ ...site })),
		resultFields,
		recordParameters,
	});
	return {
		valueRepresentations,
		resultRepresentation,
		instructionFacts,
		...(constantBooleans === undefined ? {} : { constantBooleans }),
	};
}

export function coreNativeEntryControlFlow(
	fn: CoreFunctionStore,
	entry: CoreDirectEntryPlan,
): CoreNativeEntryControlFlow | undefined {
	const proof =
		entry.valueRepresentations === undefined
			? undefined
			: representationProofs.get(entry.valueRepresentations);
	return proof?.fn === fn && coreFunctionVersionsAreCurrent(fn, proof.versions)
		? proof.controlFlow
		: undefined;
}

// Compact only references to these same proven contracts; dead calls retain their semantic facts.
export function compactCoreNativeEntries(
	program: CoreProgram,
	entries: ReadonlyArray<CoreDirectEntryPlan>,
): ReadonlyArray<CoreDirectEntryPlan> {
	const ids = new Map<CoreDirectEntryPlan["function"], Map<number, number>>();
	for (const entry of entries) {
		if (!coreNativeEntryProofIsCurrent(program.function(entry.function), entry))
			throw new RangeError("Cannot reindex an unproven native entry");
		const siblings = ids.get(entry.function) ?? new Map<number, number>();
		if (siblings.has(entry.id)) throw new RangeError("Duplicate native entry ID");
		siblings.set(entry.id, siblings.size);
		ids.set(entry.function, siblings);
	}
	return entries.map((entry) => {
		const fn = program.function(entry.function);
		const reachable = coreNativeEntryControlFlow(fn, entry)?.blocks;
		const calls = entry.callOverrides
			?.filter(
				(call) =>
					reachable === undefined || reachable.has(fn.instructionBlock(call.instruction)),
			)
			.map((call) => {
				const entryId = ids.get(call.target)?.get(call.entryId);
				if (entryId === undefined) throw new RangeError("Dangling native entry override");
				return entryId === call.entryId ? call : Object.freeze({ ...call, entryId });
			});
		const id = ids.get(entry.function)!.get(entry.id)!;
		const changed =
			calls !== undefined &&
			(calls.length !== entry.callOverrides!.length ||
				calls.some((call, index) => call !== entry.callOverrides![index]));
		if (!changed) return id === entry.id ? entry : Object.freeze({ ...entry, id });
		const overrides = Object.freeze(calls);
		const previous = entry.valueRepresentations!;
		// A new array owns the rebound proof; other consumers may retain the old numbering.
		const values = Object.freeze([...previous]);
		representationProofs.set(values, {
			...representationProofs.get(previous)!,
			callOverrides: overrides.map((call) => ({ ...call })),
		});
		return Object.freeze({
			...entry,
			id,
			callOverrides: overrides,
			valueRepresentations: values,
		});
	});
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
			entry.resultFields === undefined &&
			entry.recordParameters === undefined &&
			entry.instructionFacts === undefined &&
			entry.callOverrides === undefined
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
		(proof.programFlowRevision === undefined ||
			proof.programFlowRevision === proof.program.programFlowRevision) &&
		coreFunctionVersionsAreCurrent(fn, proof.versions) &&
		proof.resultRepresentation === entry.resultRepresentation &&
		same(proof.parameters, entry.parameterRepresentations) &&
		same(proof.arguments, entry.argumentRepresentations) &&
		proof.constants === entry.constantBooleans &&
		proof.resultFields === entry.resultFields &&
		proof.recordParameters === entry.recordParameters &&
		proof.instructionFacts === entry.instructionFacts &&
		(proof.callOverrides === undefined
			? entry.callOverrides === undefined
			: entry.callOverrides !== undefined &&
				proof.callOverrides.length === entry.callOverrides.length &&
				proof.callOverrides.every((site, index) => {
					const current = entry.callOverrides![index]!;
					return (
						site.instruction === current.instruction &&
						site.target === current.target &&
						site.entryId === current.entryId &&
						site.guarded === current.guarded
					);
				})) &&
		same(proof.fields?.keys, entry.fieldParameters?.keys) &&
		same(proof.fields?.representations, entry.fieldParameters?.representations) &&
		same(proof.fields?.numericCalls, entry.fieldParameters?.numericCalls) &&
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
				site.fieldValueRepresentations === current.fieldValueRepresentations &&
				site.recordUses === current.recordUses &&
				site.recordObjects === current.recordObjects &&
				site.builtinCallbackOperation === current.builtinCallbackOperation &&
				site.builtinCallbackNumbers === current.builtinCallbackNumbers &&
				site.numericSortCallback === current.numericSortCallback &&
				site.numericSortCallbackViaCall === current.numericSortCallbackViaCall
			);
		})
	);
}

function coreFixedArityComparisons(
	fn: CoreFunctionStore,
	instructions: ReadonlyArray<CoreInstructionId>,
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
	for (const instruction of instructions) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		if (fn.instructionOpcodeName(instruction) !== "binary") continue;
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
	let prefixBudget = 64;
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		if (prefixBudget-- === 0) break;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") {
			const effects = coreInstructionEffects(fn, instruction);
			if (
				effects.mayGc ||
				effects.mayThrow ||
				effects.maySuspend ||
				effects.callsUserCode ||
				effects.writes.length > 0
			)
				break;
		}
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
