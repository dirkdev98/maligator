import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "../shared/compiler-facts.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreLocalFactBundle } from "./core-ir-provenance.ts";
import type {
	CoreDirectEntryPlan,
	CoreEntryFields,
	CoreEntryResultFields,
	CoreRecordFieldAccess,
	CoreRecordUses,
	CorePlanRepresentation,
} from "./core-ir-regions.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type { CoreFunctionVersions } from "./core-store.ts";

const argumentProofs = new WeakMap<
	ReadonlyArray<CorePlanRepresentation>,
	{
		readonly fn: CoreFunctionStore;
		readonly versions: CoreFunctionVersions;
		readonly call: CoreInstructionId;
		readonly allocation: CoreInstructionId;
		readonly keys: ReadonlyArray<number>;
	}
>();

// These read the parameter through the activation rather than as an operand.
const PARAMETER_ALIAS_OPCODES = new Set([
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
	"callRestArguments",
]);

export function coreReadOnlyParameterFields(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreEntryFields | undefined {
	if (
		fn.parameterCount !== 1 ||
		fn.metadata.capturedCount > 0 ||
		cfg.loops.length > 0 ||
		cfg.irreducibleCycles.length > 0 ||
		[...fn.instructionIds()].length > 64
	)
		return undefined;
	const parameter = fn.kernel.functionParameter(0);
	const keys: Array<number> = [];
	const loads: Array<{ instruction: CoreInstructionId; field: number }> = [];
	const numericCalls: Array<CoreInstructionId> = [];
	const math = new Set<CoreValueId>();
	const mathLoads: Array<CoreValueId> = [];
	const callees = new Set<CoreValueId>();
	for (const instruction of fn.instructionIds()) {
		if (!cfg.reachable.has(fn.instructionBlock(instruction))) continue;
		const operands = Array.from(
			{ length: fn.kernel.instructionOperandCount(instruction) },
			(_, i) => fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + i),
		);
		if (fn.instructionKind(instruction) !== "operation") {
			if (
				operands.includes(parameter) ||
				!["jump", "branch", "return"].includes(fn.instructionKind(instruction))
			)
				return undefined;
			continue;
		}
		const opcode = fn.instructionOpcodeName(instruction);
		const attrs = fn.instructionAttributes(instruction);
		if (opcode === "loadPropertyStatic" && operands[0] === parameter) {
			const key = attrs.stringIndex;
			if (typeof key !== "number") return undefined;
			if (!keys.includes(key)) keys.push(key);
			if (keys.length > 4) return undefined;
			loads.push({ instruction, field: keys.indexOf(key) });
			continue;
		}
		if (operands.includes(parameter) || PARAMETER_ALIAS_OPCODES.has(opcode))
			return undefined;
		if (opcode === "loadIntrinsic" && attrs.intrinsic === "Math") {
			math.add(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
			continue;
		}
		if (opcode === "loadPropertyStatic" && math.has(operands[0]!)) {
			mathLoads.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
			continue;
		}
		if (opcode === "call" || opcode === "callKnown") {
			if (attrs.construct || attrs.argumentMode !== undefined) return undefined;
			if (opcode === "call") callees.add(operands[0]!);
			const builtin = attrs.knownBuiltinCall as unknown as KnownBuiltinCall | undefined;
			if (
				builtin !== undefined &&
				builtin.operation.startsWith("Math.") &&
				builtin.semantics.kind === "known" &&
				builtin.semantics.value.result === "number" &&
				(opcode === "call"
					? knownBuiltinCallProves(builtin, builtin.operation)
					: builtin.identity.kind === "known" &&
						builtin.identity.value === builtin.operation) &&
				compilerFactIsWorldInvariant(builtin.identity)
			) {
				numericCalls.push(instruction);
				continue;
			}
		}
		// A strict callee exposes no `fn.arguments`, so code it calls cannot reach a record
		// that only its field loads read, or tell that the caller never allocated it.
		if (fn.metadata.strict) continue;
		if (
			![
				"createNumber",
				"createF64",
				"createBoolean",
				"createUndefined",
				"createNull",
				"createString",
				"binary",
				"unary",
				"mathUnaryNumber",
				"mathBinaryNumber",
				"move",
			].includes(opcode)
		)
			return undefined;
	}
	return keys.length === 0 ||
		(!fn.metadata.strict && mathLoads.some((value) => !callees.has(value)))
		? undefined
		: Object.freeze({
				keys: Object.freeze(keys),
				representations: Object.freeze(keys.map(() => "boxed" as const)),
				loads: Object.freeze(loads.map((load) => Object.freeze(load))),
				numericCalls: Object.freeze(numericCalls),
			});
}

export function coreFieldArgument(
	fn: CoreFunctionStore,
	facts: CoreLocalFactBundle,
	call: CoreInstructionId,
	argument: CoreValueId,
	fields: CoreEntryFields,
):
	| {
			readonly instruction: CoreInstructionId;
			readonly valueRepresentations: ReadonlyArray<CorePlanRepresentation>;
			readonly fields: CoreEntryFields;
	  }
	| undefined {
	const layout = facts.provenance.allocationOf(argument);
	if (
		layout?.kind !== "named-slots" ||
		layout.result !== argument ||
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		layout.keys.length > 4 ||
		layout.keys.length === 0 ||
		fields.keys.some((key) => !layout.keys.includes(key))
	)
		return undefined;
	// A single use keeps identity, aliases, and later mutation out of the deferred literal.
	if (fn.kernel.valueHandlerUseCount(argument) > 0) return undefined;
	const use = fn.kernel.valueFirstUse(argument);
	if (
		use < 0 ||
		fn.kernel.useNext(use) >= 0 ||
		fn.kernel.useInstruction(use) !== call ||
		fn.kernel.useOperand(use) !== 2
	)
		return undefined;
	if (fn.instructionBlock(layout.instruction) !== fn.instructionBlock(call))
		return undefined;
	for (
		let cursor = fn.kernel.instructionNext(layout.instruction);
		cursor >= 0 && cursor !== call;
		cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
	) {
		const instruction = coreInstructionId(cursor);
		if (
			fn.instructionKind(instruction) === "operation" &&
			["yield", "await", "generatorStart"].includes(fn.instructionOpcodeName(instruction))
		)
			return undefined;
	}
	const valueRepresentations = Object.freeze(
		layout.initialValues.map((value): CorePlanRepresentation => {
			const kind = facts.valueKinds.scalarKind(value);
			return kind === "number" ? "f64" : (kind ?? "boxed");
		}),
	);
	argumentProofs.set(valueRepresentations, {
		fn,
		versions: fn.versions,
		call,
		allocation: layout.instruction,
		keys: layout.keys,
	});
	return {
		instruction: layout.instruction,
		valueRepresentations,
		fields: Object.freeze({
			...fields,
			representations: Object.freeze(
				fields.keys.map((key) => valueRepresentations[layout.keys.indexOf(key)]!),
			),
		}),
	};
}

const MAX_RESULT_FIELDS = 8;

function onlyReturned(fn: CoreFunctionStore, value: CoreValueId): boolean {
	const pending = [value];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (fn.kernel.valueHandlerUseCount(current) > 0) return false;
		for (
			let use = fn.kernel.valueFirstUse(current);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return") continue;
			if (kind !== "operation") return false;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (opcode !== "move") return false;
			pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
		}
	}
	return true;
}

function returnedAllocation(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

/** The record every reachable return of `fn` creates, when no other code can observe it. */
export function coreRecordResultFields(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreEntryResultFields | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor
	)
		return undefined;
	let keys: ReadonlyArray<number> | undefined;
	const allocations = new Set<CoreInstructionId>();
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		if (fn.kernel.instructionOperandCount(terminator) !== 1) return undefined;
		const allocation = returnedAllocation(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
		);
		if (
			allocation === undefined ||
			fn.instructionOpcodeName(allocation) !== "createObjectShaped"
		)
			return undefined;
		if (allocations.has(allocation)) continue;
		const allocationKeys = fn.instructionAttributes(allocation).keyStringIndices;
		if (
			!Array.isArray(allocationKeys) ||
			allocationKeys.length === 0 ||
			allocationKeys.length > MAX_RESULT_FIELDS ||
			(keys !== undefined &&
				(keys.length !== allocationKeys.length ||
					keys.some((key, index) => key !== allocationKeys[index]))) ||
			!onlyReturned(fn, fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)))
		)
			return undefined;
		keys ??= Object.freeze(allocationKeys.map(Number));
		allocations.add(allocation);
	}
	return keys === undefined
		? undefined
		: Object.freeze({
				keys,
				allocations: Object.freeze([...allocations].sort((left, right) => left - right)),
			});
}

const MAX_RECORD_OBSERVERS = 8;

/**
 * Every use of a call's record result, when caller storage can stand in for it.
 * Reads and writes of its own fields stay accesses; any other use observes the
 * record and must see the object, so it may not be a control-flow edge or handler
 * argument that this function cannot rewrite.
 */
export function coreRecordResultUses(
	fn: CoreFunctionStore,
	call: CoreInstructionId,
	keys: ReadonlyArray<number>,
): CoreRecordUses | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.instructionKind(call) !== "operation" ||
		fn.instructionOpcodeName(call) !== "call" ||
		fn.kernel.instructionResultCount(call) !== 1
	)
		return undefined;
	const attributes = fn.instructionAttributes(call);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	const loads: Array<CoreRecordFieldAccess> = [];
	const stores: Array<CoreRecordFieldAccess> = [];
	const observers = new Set<CoreInstructionId>();
	const aliases = new Set<CoreValueId>();
	const pending = [fn.kernel.resultAt(fn.kernel.instructionResultStart(call))];
	while (pending.length > 0) {
		const value = pending.pop()!;
		if (aliases.has(value)) continue;
		aliases.add(value);
		if (fn.kernel.valueHandlerUseCount(value) > 0) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return" || kind === "throw") {
				observers.add(instruction);
				continue;
			}
			if (kind !== "operation") return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (opcode === "move") {
				pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
				continue;
			}
			const field =
				fn.kernel.useOperand(use) === 0 &&
				(opcode === "loadPropertyStatic" || opcode === "storePropertyStatic")
					? keys.indexOf(fn.instructionAttributes(instruction).stringIndex as number)
					: -1;
			if (field < 0) observers.add(instruction);
			else
				(opcode === "loadPropertyStatic" ? loads : stores).push({ instruction, field });
		}
	}
	// Storing the record into its own field also observes it.
	const ownStores = stores.filter(({ instruction }) => !observers.has(instruction));
	const accesses = loads.length + ownStores.length;
	if (
		loads.length > 64 ||
		ownStores.length > 64 ||
		observers.size > MAX_RECORD_OBSERVERS ||
		// An observer on every path would only add a copy after the callee's literal.
		(observers.size > 0 &&
			(accesses === 0 ||
				[...observers].some(
					(observer) => fn.instructionBlock(observer) === fn.instructionBlock(call),
				)))
	)
		return undefined;
	const byInstruction = (left: CoreRecordFieldAccess, right: CoreRecordFieldAccess) =>
		left.instruction - right.instruction;
	return Object.freeze({
		loads: Object.freeze(loads.map((load) => Object.freeze(load)).sort(byInstruction)),
		stores: Object.freeze(
			ownStores.map((store) => Object.freeze(store)).sort(byInstruction),
		),
		observers: Object.freeze([...observers].sort((left, right) => left - right)),
	});
}

export function coreFieldArgumentProofIsCurrent(
	fn: CoreFunctionStore,
	site: CoreDirectEntryPlan["callSites"][number],
	fields: CoreEntryFields,
): boolean {
	const proof =
		site.fieldValueRepresentations === undefined
			? undefined
			: argumentProofs.get(site.fieldValueRepresentations);
	return (
		proof?.fn === fn &&
		coreFunctionVersionsAreCurrent(fn, proof.versions) &&
		proof.call === site.instruction &&
		proof.allocation === site.fieldObject &&
		fields.representations.length === fields.keys.length &&
		fields.keys.every((key, index) => {
			const slot = proof.keys.indexOf(key);
			const target = fields.representations[index];
			return (
				slot >= 0 &&
				(target === "boxed" || target === site.fieldValueRepresentations![slot])
			);
		})
	);
}
