import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
} from "../shared/compiler-value-kinds.ts";
import { HOST_RESULT_CONTRACTS } from "../shared/host-result-contracts.ts";
import type {
	HostResultContract,
	HostValueContract,
} from "../shared/host-result-contracts.ts";
import { coreDeferredHostSlots } from "./core-compilation.ts";
import type {
	ConstructedCoreCompilation,
	CoreCompilationContext,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreNormalResultFacts } from "./core-editor.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const hostSlots = new WeakMap<
	CoreCompilationContext["data"],
	ReadonlyMap<number, HostResultContract>
>();
const noHostSlots = new Map<number, HostResultContract>();

export function coreHostResultSlots(
	context: CoreCompilationContext,
): ReadonlyMap<number, HostResultContract> {
	const { data, facts } = context;
	// Host installers may reuse mutated module objects on later images or
	// when the runtime first loads a source builtin.
	if (
		data.inheritsHostComponents ||
		data.moduleLinks !== undefined ||
		facts.closure.scope.kind !== "whole-program" ||
		facts.closure.openings.some(
			({ kind }) => kind === "relocatable-artifact" || kind === "host-wire-splicing",
		)
	)
		return noHostSlots;
	const prior = hostSlots.get(context.data);
	if (prior !== undefined) return prior;
	const slots = new Map<number, HostResultContract>();
	const deferred = coreDeferredHostSlots(data);
	for (const candidate of context.data.hostInstallCandidates) {
		const contracts = HOST_RESULT_CONTRACTS.get(candidate.installer);
		if (contracts === undefined) continue;
		for (const installed of candidate.exports) {
			if (deferred.has(installed.slot)) continue;
			const contract = contracts.get(installed.name);
			if (contract !== undefined) slots.set(installed.slot, contract);
		}
	}
	hostSlots.set(context.data, slots);
	return slots;
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId | undefined,
): CoreInstructionId | undefined {
	return value !== undefined && fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function literal(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId | undefined,
): null | undefined | string | number | boolean | { readonly kind: "unknown" } {
	if (instruction !== undefined) {
		const attributes = fn.instructionAttributes(instruction);
		switch (fn.instructionOpcodeName(instruction)) {
			case "createUndefined":
				return undefined;
			case "createNull":
				return null;
			case "createBoolean":
			case "createNumber":
			case "createF64":
				if (typeof attributes.value === "boolean" || typeof attributes.value === "number")
					return attributes.value;
				break;
			case "createString":
				if (typeof attributes.stringIndex === "number")
					return program.stringConstantText(attributes.stringIndex);
				break;
		}
	}
	return UNKNOWN_LITERAL;
}

const UNKNOWN_LITERAL = Object.freeze({ kind: "unknown" } as const);

function stableEncoding(
	program: CoreProgram,
	fn: CoreFunctionStore,
	opts: CoreValueId,
	locked: boolean,
) {
	const producer = definition(fn, opts);
	const primitive = literal(program, fn, producer);
	if (primitive !== UNKNOWN_LITERAL || producer === undefined) return primitive;
	// Deferred native calls inspect the options later. Other uses of the object
	// can change its encoding before the task reads it.
	if (
		!locked ||
		fn.valueUseCount(opts) !== 1 ||
		fn.kernel.valueHandlerUseCount(opts) !== 0 ||
		fn.instructionOpcodeName(producer) !== "createObjectShaped"
	)
		return UNKNOWN_LITERAL;
	const keys = fn.instructionAttributes(producer).keyStringIndices;
	if (!Array.isArray(keys) || keys.length !== fn.kernel.instructionOperandCount(producer))
		return UNKNOWN_LITERAL;
	const keyIndex = keys.findIndex(
		(key) => typeof key === "number" && program.stringConstantText(key) === "encoding",
	);
	if (keyIndex < 0) return undefined;
	return literal(
		program,
		fn,
		definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer) + keyIndex),
		),
	);
}

export function coreHostResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: ReadonlyMap<number, HostResultContract>,
	locked: boolean,
):
	| {
			readonly immediate: CoreNormalResultFacts;
			readonly fulfilled?: CoreNormalResultFacts;
	  }
	| undefined {
	if (slots.size === 0 || fn.instructionOpcodeName(instruction) !== "call")
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const callee = definition(fn, fn.kernel.operandAt(start));
	if (callee === undefined || fn.instructionOpcodeName(callee) !== "loadGlobal")
		return undefined;
	const slot = fn.instructionAttributes(callee).index;
	const contract = typeof slot === "number" ? slots.get(slot) : undefined;
	if (contract?.kind !== "return" && contract?.kind !== "fulfill") return undefined;
	const result = valueFacts(contract.value);
	return contract.kind === "return"
		? { immediate: result }
		: {
				immediate: { mask: contract.immediateMask ?? COMPILER_VALUE_KIND_OBJECT },
				fulfilled: result,
			};

	function valueFacts(value: HostValueContract): CoreNormalResultFacts {
		const selector = value.selector;
		if (selector === undefined) return { mask: value.mask, heapBrand: value.brand };
		if (fn.instructionAttributes(instruction).argumentMode !== undefined)
			return { mask: value.mask };
		const argument = selector.argument + 2;
		const operand =
			argument < fn.kernel.instructionOperandCount(instruction)
				? fn.kernel.operandAt(start + argument)
				: undefined;
		const selected =
			operand === undefined
				? undefined
				: selector.kind === "text-flag"
					? literal(program, fn, definition(fn, operand))
					: stableEncoding(program, fn, operand, locked);
		const text =
			selected === UNKNOWN_LITERAL
				? undefined
				: selector.kind === "text-flag"
					? Boolean(selected)
					: selector.kind === "encoding"
						? typeof selected === "string"
							? true
							: selected === null || selected === undefined
								? false
								: undefined
						: typeof selected === "string"
							? selected.toLowerCase() !== "buffer"
							: selected === null || selected === undefined
								? true
								: undefined;
		return text === undefined
			? { mask: value.mask }
			: text
				? { mask: COMPILER_VALUE_KIND_STRING }
				: { mask: COMPILER_VALUE_KIND_OBJECT, heapBrand: "Uint8Array" };
	}
}

/** Installer-backed named slots establish exact callees before any script runs. */
export function specializeCoreHostResults(compilation: ConstructedCoreCompilation): void {
	const { program, context } = compilation;
	const slots = coreHostResultSlots(context);
	if (slots.size === 0) return;
	const locked = context.facts.world.primordialPolicy === "locked";
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const facts = coreHostResult(program, fn, instruction, slots, locked)?.immediate;
			if (facts === undefined) continue;
			(editor ??= CoreEditor.open(program, functionId)).setNormalResultFacts(
				instruction,
				facts,
			);
		}
		editor?.commit();
	}
}
