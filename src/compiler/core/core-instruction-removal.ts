import type { CoreEditor } from "./core-editor.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId } from "./core-ir.ts";

/** The caller must first detach exceptional uses of the discarded region. */
export function removeCoreInstructions(
	editor: CoreEditor,
	instructions: Iterable<CoreInstructionId>,
): void {
	const fn = editor.function;
	const pending = new Set(instructions);
	const queue = new Array<CoreInstructionId>();
	const queued = new Set<CoreInstructionId>();
	const enqueueIfDead = (instruction: CoreInstructionId): void => {
		if (!pending.has(instruction) || queued.has(instruction)) return;
		const start = fn.kernel.instructionResultStart(instruction);
		const count = fn.kernel.instructionResultCount(instruction);
		for (let index = 0; index < count; index++) {
			const value = fn.kernel.resultAt(start + index);
			if (fn.valueUseCount(value) + fn.kernel.valueHandlerUseCount(value) > 0) return;
		}
		queued.add(instruction);
		queue.push(instruction);
	};
	for (const instruction of pending) enqueueIfDead(instruction);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const instruction = queue[cursor]!;
		const dependencies = new Array<CoreInstructionId>();
		const start = fn.kernel.instructionOperandStart(instruction);
		const count = fn.kernel.instructionOperandCount(instruction);
		for (let index = 0; index < count; index++) {
			const value = fn.kernel.operandAt(start + index);
			if (fn.kernel.valueDefinitionKind(value) === 1)
				dependencies.push(coreInstructionId(fn.kernel.valueDefinitionOwner(value)));
		}
		editor.removeInstruction(instruction);
		pending.delete(instruction);
		for (const dependency of dependencies) enqueueIfDead(dependency);
	}
	if (pending.size > 0)
		throw new Error("Discarded Core instructions retain external or cyclic uses");
}
