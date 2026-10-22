import type { CoreCompilationContext } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	removeInstructionAndOwnedProof,
	removeUnsharedProof,
} from "./core-effect-proof-edits.ts";
import { removeCoreInstructions } from "./core-instruction-removal.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import type { CoreChangeSet, CoreFunctionStore } from "./core-store.ts";
import type { CoreProgram } from "./core-store.ts";

const key = (owner: unknown, index: unknown) => `${String(owner)}:${String(index)}`;

/**
 * Forward an owner's own captured loads from its stores. Only code nested in the
 * owner names its slots, so once the slot has no other writer, a load observes
 * the nearest dominating store unless another store can run between the two.
 */
function forwardOwnCapturedLoads(
	program: CoreProgram,
	fn: CoreFunctionStore,
	foreignWrites: ReadonlySet<string>,
	edit: () => CoreEditor,
): void {
	const stores = new Map<number, Array<CoreInstructionId>>();
	const loads: Array<{ instruction: CoreInstructionId; index: number }> = [];
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadCaptured" && opcode !== "storeCaptured") continue;
		const { functionIndex, index } = fn.instructionAttributes(instruction);
		if (
			functionIndex !== fn.id ||
			typeof index !== "number" ||
			foreignWrites.has(key(fn.id, index))
		)
			continue;
		if (opcode === "loadCaptured") loads.push({ instruction, index });
		else stores.set(index, [...(stores.get(index) ?? []), instruction]);
	}
	if (loads.length === 0 || stores.size === 0) return;
	let built: CoreControlFlow | undefined;
	const control = () => (built ??= buildCoreControlFlow(program, fn.id));
	const positions = new Int32Array(fn.instructionCapacity);
	for (const block of fn.blockIds()) {
		let position = 0;
		for (const instruction of fn.instructionIds(block))
			positions[instruction] = position++;
	}
	const dominates = (first: CoreInstructionId, second: CoreInstructionId): boolean => {
		const from = fn.instructionBlock(first);
		const to = fn.instructionBlock(second);
		return from === to
			? positions[first]! < positions[second]!
			: control().reachable.has(to) && control().instructionDominatesBlock(from, to);
	};
	const reachedAvoiding = new Map<string, ReadonlySet<CoreBlockId>>();
	// Blocks entered after leaving `from` without first passing through `barrier`.
	const reachableAvoiding = (
		from: CoreBlockId,
		barrier: CoreBlockId,
	): ReadonlySet<CoreBlockId> => {
		const id = `${from}:${barrier}`;
		let reached = reachedAvoiding.get(id);
		if (reached !== undefined) return reached;
		const seen = new Set<CoreBlockId>();
		const { successors } = control();
		const queue = (successors[from] ?? []).map((edge) => edge.to);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const next = queue[cursor]!;
			if (next === barrier || seen.has(next)) continue;
			seen.add(next);
			for (const edge of successors[next] ?? []) queue.push(edge.to);
		}
		reached = seen;
		reachedAvoiding.set(id, reached);
		return reached;
	};
	// Another store can only intervene on a path that leaves the forwarding store's
	// block and reaches the load without re-entering that block. Stores sharing the
	// load's block run after the load, so they intervene only around a cycle.
	const intervenes = (
		store: CoreInstructionId,
		other: CoreInstructionId,
		load: CoreInstructionId,
	): boolean => {
		const storeBlock = fn.instructionBlock(store);
		const loadBlock = fn.instructionBlock(load);
		const otherBlock = fn.instructionBlock(other);
		if (storeBlock === loadBlock || otherBlock === storeBlock) return false;
		if (!reachableAvoiding(storeBlock, storeBlock).has(otherBlock)) return false;
		return reachableAvoiding(otherBlock, storeBlock).has(loadBlock);
	};
	for (const { instruction: load, index } of loads) {
		const writes = stores.get(index) ?? [];
		let nearest: CoreInstructionId | undefined;
		for (const store of writes) {
			if (dominates(store, load) && (nearest === undefined || dominates(nearest, store)))
				nearest = store;
		}
		if (
			nearest === undefined ||
			writes.some(
				(other) =>
					other !== nearest &&
					!dominates(other, nearest) &&
					intervenes(nearest, other, load),
			)
		)
			continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(nearest));
		const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(load));
		const definition =
			fn.kernel.valueDefinitionKind(value) === 1
				? fn.instructionOpcodeName(
						coreInstructionId(fn.kernel.valueDefinitionOwner(value)),
					)
				: undefined;
		// The TDZ sentinel stays behind its load and check. A nested function's object
		// is created lazily at the binding reads where it escapes, so only calls bypass them.
		if (
			definition === "createEmpty" ||
			(definition === "createFunction" && !onlyCalled(fn, result))
		)
			continue;
		const editor = edit();
		if (fn.valueRepresentation(result) === fn.valueRepresentation(value)) {
			editor.replaceValueUses(result, value);
			removeInstructionAndOwnedProof(editor, fn, load);
		} else {
			const proof = fn.instructionEffectRefinement(load)?.proof;
			editor.replaceInstruction(load, "move", [value], {
				sourcePosition: fn.instructionSourcePosition(load),
			});
			removeUnsharedProof(editor, fn, proof);
		}
	}
}

function onlyCalled(fn: CoreFunctionStore, value: CoreValueId): boolean {
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return false;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (fn.instructionKind(instruction) !== "operation") return false;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "throwIfTdz") continue;
		if (opcode !== "call") return false;
		const start = fn.kernel.instructionOperandStart(instruction);
		for (let index = 1; index < fn.kernel.instructionOperandCount(instruction); index++)
			if (fn.kernel.operandAt(start + index) === value) return false;
	}
	return true;
}

function emptyBody(editor: CoreEditor, fn: CoreFunctionStore): boolean {
	const body = fn.bodyEntry ?? fn.entry;
	if (body !== fn.entry && fn.kernel.blockParameterCount(body) !== 0) return false;
	const blocks = [...fn.blockIds()];
	const instructions = blocks.flatMap((block) => [
		...fn.bodyInstructionIds(block),
		...(block === fn.entry || block === body ? [] : [fn.blockTerminator(block)]),
	]);
	const {
		outputs: [value],
	} = editor.appendInstruction(body, "createUndefined", []);
	if (body !== fn.entry)
		editor.replaceTerminator(fn.entry, {
			kind: "jump",
			edge: { block: body, arguments: [] },
		});
	editor.replaceTerminator(body, { kind: "return", value: value! });
	for (const block of blocks) editor.clearHandler(block);
	removeCoreInstructions(editor, instructions);
	for (const block of blocks) {
		if (block !== fn.entry && block !== body) editor.removeBlock(block);
	}
	return true;
}

interface CapturedSlotUses {
	// Slots that another function, a mapped arguments object or private-name creation writes.
	readonly foreignWrites: ReadonlySet<string>;
	readonly implicitReads: ReadonlySet<string>;
	readonly identities: ReadonlySet<CoreFunctionId>;
}

// Undefined when dynamic scope can read or write any slot.
function scanCapturedSlots(
	program: CoreProgram,
	functions: ReadonlyArray<CoreFunctionId>,
): CapturedSlotUses | undefined {
	const foreignWrites = new Set<string>();
	const implicitReads = new Set<string>();
	const identities = new Set<CoreFunctionId>();
	for (const id of functions) {
		const fn = program.function(id);
		for (const index of fn.metadata.mappedArgumentSlots) {
			foreignWrites.add(key(id, index));
			if (index >= 0) implicitReads.add(key(id, index));
		}
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode.startsWith("with")) return undefined;
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "createFunction") {
				if (typeof attributes.functionIndex === "number")
					identities.add(coreFunctionId(attributes.functionIndex));
			} else if (opcode === "storeCaptured") {
				if (attributes.functionIndex !== id)
					foreignWrites.add(key(attributes.functionIndex, attributes.index));
			} else if (
				opcode === "createPrivateNames" &&
				Array.isArray(attributes.capturedIndices)
			) {
				for (const index of attributes.capturedIndices) {
					foreignWrites.add(key(attributes.functionIndex, index));
					implicitReads.add(key(attributes.functionIndex, index));
				}
			}
		}
	}
	return { foreignWrites, implicitReads, identities };
}

function forwardAllOwnCapturedLoads(
	program: CoreProgram,
	functions: ReadonlyArray<CoreFunctionId>,
	foreignWrites: ReadonlySet<string>,
	edit: (id: CoreFunctionId) => CoreEditor,
): void {
	for (const id of functions) {
		const fn = program.function(id);
		if (!fn.isAsync && !fn.isGenerator)
			forwardOwnCapturedLoads(program, fn, foreignWrites, () => edit(id));
	}
}

/**
 * Forward each function's reads of its own captured bindings from their stores
 * before local optimization, so the owner sees stored values as plain SSA values.
 */
export function forwardCoreOwnCapturedLoads(
	program: CoreProgram,
	context: CoreCompilationContext,
): number {
	if (context.facts.closure.sourceClosure.kind !== "known") return 0;
	const functions = [...program.functionIds()];
	const uses = scanCapturedSlots(program, functions);
	if (uses === undefined) return 0;
	const editors = new Map<CoreFunctionId, CoreEditor>();
	forwardAllOwnCapturedLoads(program, functions, uses.foreignWrites, (id) => {
		let editor = editors.get(id);
		if (editor === undefined) {
			editor = CoreEditor.open(program, id);
			editors.set(id, editor);
		}
		return editor;
	});
	for (const editor of editors.values()) editor.commit();
	return editors.size;
}

/**
 * Source-frame retention does not make an uninstantiated function body executable,
 * and captured slots that no remaining code reads need no stores. Dropping a store
 * can leave its closure unused, which in turn uninstantiates that closure's body.
 */
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
	const roots = new Set(context.data.cjsModuleFunctionIndices.map(coreFunctionId));
	const functions = [...program.functionIds()];
	const entry = functions[0];
	if (entry !== undefined) roots.add(entry);
	for (const installer of context.data.hostInstallCandidates) {
		for (const { slot } of installer.exports) {
			for (const target of flow.targets.globalStoreTargets(slot).functions)
				roots.add(target);
		}
	}
	const editors = new Map<CoreFunctionId, CoreEditor>();
	const edit = (id: CoreFunctionId): CoreEditor => {
		let editor = editors.get(id);
		if (editor === undefined) {
			editor = CoreEditor.open(program, id);
			editors.set(id, editor);
		}
		return editor;
	};
	const emptied = new Set<CoreFunctionId>();
	let uses = scanCapturedSlots(program, functions);
	for (let round = 0; round < 8; round++) {
		const identities = uses?.identities ?? scanIdentities(program, functions);
		for (const id of functions) {
			const fn = program.function(id);
			if (
				emptied.has(id) ||
				roots.has(id) ||
				identities.has(id) ||
				fn.isAsync ||
				fn.isGenerator ||
				fn.metadata.isClassConstructor ||
				[...fn.factIds()].length !== 0
			)
				continue;
			if (emptyBody(edit(id), fn)) emptied.add(id);
		}
		if (uses === undefined) break;
		forwardAllOwnCapturedLoads(program, functions, uses.foreignWrites, edit);
		const readers = new Set(uses.implicitReads);
		for (const id of functions) {
			const fn = program.function(id);
			for (const instruction of fn.instructionIds()) {
				if (
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadCaptured"
				) {
					const { functionIndex, index } = fn.instructionAttributes(instruction);
					readers.add(key(functionIndex, index));
				}
			}
		}
		let released = false;
		for (const id of functions) {
			const fn = program.function(id);
			const closures: Array<CoreInstructionId> = [];
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode === "createFunction") closures.push(instruction);
				if (opcode !== "storeCaptured") continue;
				const { functionIndex, index } = fn.instructionAttributes(instruction);
				if (
					typeof functionIndex !== "number" ||
					functionIndex < 0 ||
					readers.has(key(functionIndex, index))
				)
					continue;
				edit(id).removeInstruction(instruction);
			}
			for (const closure of closures) {
				const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(closure));
				if (fn.valueUseCount(value) + fn.kernel.valueHandlerUseCount(value) !== 0)
					continue;
				edit(id).removeInstruction(closure);
				released = true;
			}
		}
		if (!released) break;
		uses = scanCapturedSlots(program, functions);
	}
	return [...editors.values()].map((editor) => editor.commit());
}

function scanIdentities(
	program: CoreProgram,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlySet<CoreFunctionId> {
	const identities = new Set<CoreFunctionId>();
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
	return identities;
}
