import type { CoreCompilation } from "../core/core-compilation.ts";
import type { CoreBlockId, CoreRepresentation, CoreValueId } from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import { nativeLoopBackedgeInstructions } from "./execution-liveness.ts";
import { lowerCoreCompilationToTargetProgram } from "./lower-core-target.ts";
import type { CoreStorageAssignment } from "./lower-core-target.ts";
import type { NativeProgram } from "./native-ir.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

function nativeValueStorage(
	fn: CoreFunctionStore,
	blocks: ReadonlyArray<CoreBlockId>,
): CoreStorageAssignment {
	const roots = new Map<CoreValueId, CoreValueId>();
	const registers = new Map<CoreValueId, number>();
	const registerRepresentations = new Map<number, CoreRepresentation>();
	const storageValues: Array<number> = [];
	const assign = (value: CoreValueId): void => {
		if (registers.has(value)) return;
		const local = storageValues.length;
		roots.set(value, value);
		registers.set(value, local);
		registerRepresentations.set(local, fn.valueRepresentation(value));
		storageValues.push(value);
	};
	for (let index = 0; index < fn.parameterCount; index++)
		assign(fn.kernel.functionParameter(index));
	// Raw argument snapshots retain the runtime helper ABI, independently of VM coloring.
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") break;
		if (fn.kernel.instructionResultCount(instruction) > 0)
			assign(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
	}
	for (const block of blocks) {
		const start = fn.kernel.blockParameterStart(block);
		for (let index = 0; index < fn.kernel.blockParameterCount(block); index++)
			assign(fn.kernel.blockParameterValue(start + index));
		for (const instruction of fn.instructionIds(block)) {
			const result = fn.kernel.instructionResultStart(instruction);
			for (let index = 0; index < fn.kernel.instructionResultCount(instruction); index++)
				assign(fn.kernel.resultAt(result + index));
			const operand = fn.kernel.instructionOperandStart(instruction);
			for (let index = 0; index < fn.kernel.instructionOperandCount(instruction); index++)
				assign(fn.kernel.operandAt(operand + index));
		}
		const handler = fn.kernel.blockHandlerArgumentStart(block);
		for (let index = 0; index < fn.kernel.blockHandlerArgumentCount(block); index++)
			assign(fn.kernel.handlerArgumentAt(handler + index));
	}
	return { roots, registers, registerRepresentations, storageValues };
}

export function lowerCoreCompilationToNativeProgram(
	compilation: CoreCompilation,
	options: { readonly excludeGuardedDirectCalls?: boolean } = {},
): NativeProgram {
	const target = lowerCoreCompilationToTargetProgram(compilation, {
		...options,
		assignStorage: nativeValueStorage,
		loopBackedgeInstructions: nativeLoopBackedgeInstructions,
	});
	const functions = target.functions.map((fn) => {
		if (fn.storageValues === undefined)
			throw new Error("Native lowering lost SSA value storage");
		return { ...fn, storageValues: fn.storageValues };
	});
	const program: NativeProgram = { ...target, kind: "native", functions };
	verifyNativeExecutionProgram(program);
	return program;
}
