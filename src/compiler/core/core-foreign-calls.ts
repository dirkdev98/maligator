import type { FfiDirectEntry } from "../../build-config-values.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
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
import type { CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/** The direct entries of C library imports, by the global slot each import occupies. */
export function coreForeignSlots(
	candidates: ReadonlyArray<CoreHostInstallCandidate>,
): ReadonlyMap<number, FfiDirectEntry> {
	const slots = new Map<number, FfiDirectEntry>();
	for (const install of candidates) {
		for (const entry of install.exports) {
			if (entry.direct !== undefined) slots.set(entry.slot, entry.direct);
		}
	}
	return slots;
}

/**
 * Calls whose callee is read straight from a C library import's slot. The installer
 * fills that slot before any code runs and imports cannot be reassigned, so the call
 * always reaches the binding behind the entry.
 */
export function coreForeignCalls(
	fn: CoreFunctionStore,
	slots: ReadonlyMap<number, FfiDirectEntry>,
): ReadonlyMap<CoreInstructionId, FfiDirectEntry> {
	const calls = new Map<CoreInstructionId, FfiDirectEntry>();
	if (slots.size === 0) return calls;
	const kernel = fn.kernel;
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "call"
		)
			continue;
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
		case "undefined":
			return { mask: COMPILER_VALUE_KIND_UNDEFINED };
	}
}

/**
 * Publish the primitive each foreign call returns on normal completion, so callers
 * keep results such as C integers unboxed.
 */
export function refineCoreForeignCallResults(
	compilation: ConstructedCoreCompilation,
): void {
	const slots = coreForeignSlots(compilation.context.data.hostInstallCandidates);
	if (slots.size === 0) return;
	const { program } = compilation;
	for (const functionId of program.functionIds()) {
		const calls = coreForeignCalls(program.function(functionId), slots);
		const refined = [...calls].flatMap(([instruction, entry]) => {
			const facts = resultFacts(entry);
			return facts === undefined ? [] : [{ instruction, facts }];
		});
		if (refined.length === 0) continue;
		const editor = CoreEditor.open(program, functionId);
		for (const { instruction, facts } of refined)
			editor.setNormalResultFacts(instruction, facts);
		editor.commit();
	}
}
