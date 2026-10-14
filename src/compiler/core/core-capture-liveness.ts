import type { CoreCompilationContext } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreFunctionId } from "./core-ir.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import type { CoreChangeSet } from "./core-store.ts";
import type { CoreProgram } from "./core-store.ts";

/** Source-frame retention does not make an uninstantiated function body executable. */
export function pruneCoreCaptureLiveness(
	program: CoreProgram,
	context: CoreCompilationContext,
	flow: CoreProgramFlowState,
): ReadonlyArray<CoreChangeSet> {
	if (
		context.facts.closure.sourceClosure.kind !== "known" ||
		!flow.reachability.sourceClosed
	)
		return [];
	// Guards and inline source frames reference code without instantiating its identity.
	const identities = new Set(context.data.cjsModuleFunctionIndices.map(coreFunctionId));
	const functions = [...program.functionIds()];
	const entry = functions[0];
	if (entry !== undefined) identities.add(entry);
	for (const installer of context.data.hostInstallCandidates) {
		for (const { slot } of installer.exports) {
			for (const target of flow.targets.globalStoreTargets(slot).functions)
				identities.add(target);
		}
	}
	for (const id of functions) {
		const fn = program.function(id);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "createFunction"
			)
				continue;
			const target = fn.instructionAttributes(instruction).functionIndex;
			if (typeof target === "number") identities.add(coreFunctionId(target));
		}
	}
	const changed = new Map<CoreFunctionId, CoreChangeSet>();
	for (const id of functions) {
		const fn = program.function(id);
		if (
			identities.has(id) ||
			fn.isAsync ||
			fn.isGenerator ||
			fn.metadata.isClassConstructor ||
			[...fn.factIds()].length !== 0
		)
			continue;
		const body = fn.bodyEntry ?? fn.entry;
		if (body !== fn.entry && fn.kernel.blockParameterCount(body) !== 0) continue;
		const instructions = [
			...fn.bodyInstructionIds(fn.entry),
			...(body === fn.entry ? [] : fn.bodyInstructionIds(body)),
		];
		const editor = CoreEditor.open(program, id);
		const {
			outputs: [value],
		} = editor.appendInstruction(body, "createUndefined", []);
		if (body !== fn.entry)
			editor.replaceTerminator(fn.entry, {
				kind: "jump",
				edge: { block: body, arguments: [] },
			});
		editor.replaceTerminator(body, { kind: "return", value: value! });
		editor.clearHandler(fn.entry);
		editor.clearHandler(body);
		for (const block of [...fn.blockIds()]) {
			if (block !== fn.entry && block !== body) editor.removeBlock(block);
		}
		for (const instruction of instructions.toReversed())
			editor.removeInstruction(instruction);
		changed.set(id, editor.commit());
	}
	const readers = new Set<string>();
	const key = (owner: unknown, index: unknown) => `${String(owner)}:${String(index)}`;
	for (const id of functions) {
		const fn = program.function(id);
		for (const index of fn.metadata.mappedArgumentSlots) {
			if (index >= 0) readers.add(key(id, index));
		}
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode.startsWith("with")) return [...changed.values()];
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "loadCaptured")
				readers.add(key(attributes.functionIndex, attributes.index));
			if (opcode === "createPrivateNames" && Array.isArray(attributes.capturedIndices)) {
				for (const index of attributes.capturedIndices)
					readers.add(key(attributes.functionIndex, index));
			}
		}
	}
	for (const id of functions) {
		const fn = program.function(id);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			if (fn.instructionOpcodeName(instruction) !== "storeCaptured") continue;
			const { functionIndex, index } = fn.instructionAttributes(instruction);
			if (
				typeof functionIndex !== "number" ||
				functionIndex < 0 ||
				readers.has(key(functionIndex, index))
			)
				continue;
			editor ??= CoreEditor.open(program, id);
			editor.removeInstruction(instruction);
		}
		if (editor !== undefined) {
			changed.set(id, editor.commit());
		}
	}
	return [...changed.values()];
}
