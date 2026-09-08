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
	CorePlanRepresentation,
} from "./core-ir-regions.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export function coreReadOnlyNumericParameterFields(
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
	const math = new Set<CoreValueId>();
	const mathLoads: Array<CoreValueId> = [];
	const callees = new Set<CoreValueId>();
	for (const instruction of fn.instructionIds()) {
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
		if (operands.includes(parameter)) return undefined;
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
				builtin === undefined ||
				!builtin.operation.startsWith("Math.") ||
				builtin.semantics.kind !== "known" ||
				builtin.semantics.value.result !== "number" ||
				(opcode === "call"
					? !knownBuiltinCallProves(builtin, builtin.operation)
					: builtin.identity.kind !== "known" ||
						builtin.identity.value !== builtin.operation) ||
				!compilerFactIsWorldInvariant(builtin.identity)
			)
				return undefined;
			continue;
		}
		if (
			![
				"createNumber",
				"createF64",
				"createBoolean",
				"createUndefined",
				"createNull",
				"binary",
				"unary",
				"move",
			].includes(opcode)
		)
			return undefined;
	}
	return keys.length === 0 || mathLoads.some((value) => !callees.has(value))
		? undefined
		: Object.freeze({
				keys: Object.freeze(keys),
				loads: Object.freeze(loads.map((load) => Object.freeze(load))),
			});
}

export function coreNumericFieldArgument(
	fn: CoreFunctionStore,
	facts: CoreLocalFactBundle,
	call: CoreInstructionId,
	argument: CoreValueId,
	fields: CoreEntryFields,
): CoreInstructionId | undefined {
	const layout = facts.provenance.allocationOf(argument);
	if (
		layout?.kind !== "named-slots" ||
		layout.result !== argument ||
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		layout.keys.length > 4 ||
		layout.keys.length === 0 ||
		fields.keys.some((key) => !layout.keys.includes(key)) ||
		fields.keys.some(
			(key) =>
				!["number", "int32"].includes(
					facts.valueKinds.exactScalar(layout.initialValues[layout.keys.indexOf(key)]!) ??
						"",
				),
		)
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
	return fn.instructionBlock(layout.instruction) === fn.instructionBlock(call)
		? layout.instruction
		: undefined;
}

export function coreFieldEntryHasNumericComputations(
	fn: CoreFunctionStore,
	representations: ReadonlyArray<CorePlanRepresentation>,
	operatorInputs: CoreDirectEntryPlan["operatorInputs"],
): boolean {
	const certified = new Set(operatorInputs?.map(({ instruction }) => instruction));
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (!["binary", "unary", "call", "callKnown"].includes(opcode)) continue;
		if (certified.has(instruction)) continue;
		for (
			let index = opcode === "call" ? 2 : opcode === "callKnown" ? 1 : 0;
			index < fn.kernel.instructionOperandCount(instruction);
			index++
		) {
			const value = fn.kernel.operandAt(
				fn.kernel.instructionOperandStart(instruction) + index,
			);
			if (representations[value] !== "f64") return false;
		}
	}
	return true;
}
