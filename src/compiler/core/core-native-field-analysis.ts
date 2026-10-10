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
