import type { FfiDirectEntry } from "../../build-config-values.ts";
import { isFfiScalarEntry } from "../../build-config-values.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type {
	ConstructedCoreCompilation,
	CoreHostInstallCandidate,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreNormalResultFacts } from "./core-editor.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/** The direct entries of C library imports, by the global slot each import occupies. */
export function coreForeignSlots(
	candidates: ReadonlyArray<CoreHostInstallCandidate>,
): ReadonlyMap<number, FfiDirectEntry> {
	const slots = new Map<number, FfiDirectEntry>();
	for (const install of candidates) {
		for (const entry of install.exports) {
			if (entry.direct !== undefined) {
				if (
					entry.direct.scalar !== undefined &&
					(entry.direct.callsUserCode ||
						!isFfiScalarEntry(
							entry.direct.scalar,
							entry.direct.symbol,
							entry.direct.arity,
						))
				)
					throw new Error(
						`Foreign binding ${entry.direct.symbol} has an invalid scalar ABI`,
					);
				if (typeof entry.direct.callsUserCode !== "boolean")
					throw new Error(
						`Foreign binding ${entry.direct.symbol} has no reentry contract`,
					);
				slots.set(entry.slot, entry.direct);
			}
		}
	}
	return slots;
}

/**
 * Calls of configured C imports, selected statically or loaded from an import slot.
 * Installers fill those immutable slots before program entry.
 */
export function coreForeignCalls(
	fn: CoreFunctionStore,
	slots: ReadonlyMap<number, FfiDirectEntry>,
): ReadonlyMap<CoreInstructionId, FfiDirectEntry> {
	const calls = new Map<CoreInstructionId, FfiDirectEntry>();
	if (slots.size === 0) return calls;
	const kernel = fn.kernel;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		if (fn.instructionOpcodeName(instruction) === "callForeign") {
			const slot = fn.instructionAttributes(instruction).foreignSlot;
			const entry = typeof slot === "number" ? slots.get(slot) : undefined;
			if (entry === undefined || entry.callsUserCode)
				throw new Error(
					`Static foreign call ${instruction} has no callback-free binding`,
				);
			calls.set(instruction, entry);
			continue;
		}
		if (fn.instructionOpcodeName(instruction) !== "call") continue;
		const callee = kernel.operandAt(kernel.instructionOperandStart(instruction));
		if (kernel.valueDefinitionKind(callee) !== 1) continue;
		const load = coreInstructionId(kernel.valueDefinitionOwner(callee));
		if (fn.instructionOpcodeName(load) !== "loadGlobal") continue;
		const index = fn.instructionAttributes(load).index;
		const entry = typeof index === "number" ? slots.get(index) : undefined;
		if (entry !== undefined) calls.set(instruction, entry);
	}
	return calls;
}

/**
 * Whether a foreign call can borrow a stack object with the keys `names` as argument
 * `argument`: the binding reads that struct before the C call and keeps nothing, and
 * the object has exactly the struct's fields in order, so it has the struct's shape
 * and reading it runs no getter that could capture the object. An undefined name is
 * a key the program never spells.
 */
export function coreForeignBorrows(
	entry: FfiDirectEntry,
	argument: number,
	names: ReadonlyArray<string | undefined>,
): boolean {
	const fields = entry.borrows?.find((borrow) => borrow.argument === argument)?.fields;
	return (
		fields !== undefined &&
		fields.length === names.length &&
		fields.every((field, index) => names[index] === field)
	);
}

/** The most fields a stack object holds: the runtime keeps them inline. */
const STACK_OBJECT_SLOTS = 255;

/**
 * Foreign calls whose binding can write the object it returns, a struct or its result
 * and outputs, into the caller's stack object, as allocations with that object's keys.
 * A key the program never spells has no string constant and becomes -1: no access can
 * name it.
 */
export function coreForeignRecordResults(
	program: CoreProgram,
	fn: CoreFunctionStore,
	calls: ReadonlyMap<CoreInstructionId, FfiDirectEntry>,
): ReadonlyArray<{
	readonly instruction: CoreInstructionId;
	readonly result: CoreValueId;
	readonly keys: ReadonlyArray<number>;
}> {
	return [...calls].flatMap(([instruction, entry]) => {
		const keys = (entry.into?.fields ?? []).map(
			(field) => program.stringConstantSlot(field, "first") ?? -1,
		);
		if (keys.length === 0 || keys.length > STACK_OBJECT_SLOTS) return [];
		const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		return [{ instruction, result, keys }];
	});
}

function resultFacts(entry: FfiDirectEntry): CoreNormalResultFacts | undefined {
	const result = entry.result;
	switch (result?.kind) {
		case undefined:
			return undefined;
		case "integer":
			return {
				mask: COMPILER_VALUE_KIND_NUMBER,
				integerRange: {
					minimum: result.minimum,
					maximum: result.maximum,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				},
			};
		case "number":
			return { mask: COMPILER_VALUE_KIND_NUMBER };
		case "boolean":
			return { mask: COMPILER_VALUE_KIND_BOOLEAN };
		case "bigint":
			return { mask: COMPILER_VALUE_KIND_BIGINT };
		case "undefined":
			return { mask: COMPILER_VALUE_KIND_UNDEFINED };
	}
}

/**
 * Bind callback-free imports statically and publish their primitive normal results.
 */
export function specializeCoreForeignCalls(
	compilation: ConstructedCoreCompilation,
): void {
	const slots = coreForeignSlots(compilation.context.data.hostInstallCandidates);
	if (slots.size === 0) return;
	const { program } = compilation;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const calls = coreForeignCalls(fn, slots);
		const refined = [...calls].flatMap(([instruction, entry]) => {
			const facts = resultFacts(entry);
			return facts === undefined && entry.callsUserCode
				? []
				: [{ instruction, entry, facts }];
		});
		if (refined.length === 0) continue;
		const editor = CoreEditor.open(program, functionId);
		for (const { instruction, entry, facts } of refined) {
			if (!entry.callsUserCode && fn.instructionOpcodeName(instruction) === "call") {
				const start = fn.kernel.instructionOperandStart(instruction);
				const callee = fn.kernel.operandAt(start);
				const load = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
				const inputs = Array.from(
					{ length: fn.kernel.instructionOperandCount(instruction) - 2 },
					(_, index) => fn.kernel.operandAt(start + index + 2),
				);
				editor.replaceInstruction(instruction, "callForeign", inputs, {
					attributes: { foreignSlot: fn.instructionAttributes(load).index },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
			}
			if (facts !== undefined) editor.setNormalResultFacts(instruction, facts);
		}
		editor.commit();
	}
}
