import type { CoreEditor } from "./core-editor.ts";
import type { CoreFactId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export function removeInstructionAndOwnedProof(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): void {
	const proof = fn.instructionEffectRefinement(instruction)?.proof;
	editor.removeInstruction(instruction);
	removeUnsharedProof(editor, fn, proof);
}

export function removeUnsharedProof(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	proof: CoreFactId | undefined,
): void {
	if (proof === undefined || !fn.isFactLive(proof)) return;
	const shared = [...fn.instructionIds()].some(
		(candidate) =>
			fn.instructionKind(candidate) === "operation" &&
			fn.instructionEffectRefinement(candidate)?.proof === proof,
	);
	if (!shared) editor.removeFact(proof);
}
