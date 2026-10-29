import type { CoreCompilationContext } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	removeInstructionAndOwnedProof,
	removeUnsharedProof,
} from "./core-effect-proof-edits.ts";
import { removeCoreInstructions } from "./core-instruction-removal.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import type { CoreChangeSet, CoreFunctionStore } from "./core-store.ts";
import type { CoreProgram } from "./core-store.ts";

const key = (owner: unknown, index: unknown) => `${String(owner)}:${String(index)}`;

type SlotValue =
	| { readonly kind: "value"; readonly value: CoreValueId }
	| { readonly kind: "phi"; readonly block: CoreBlockId }
	| { readonly kind: "unknown" };

const UNKNOWN_SLOT: SlotValue = { kind: "unknown" };
const SLOT_FLOW_ROUNDS = 32;
const SCALAR_JOIN_REPRESENTATIONS: ReadonlySet<CoreRepresentation> = new Set([
	"boxed",
	"f64",
	"i32",
	"boolean",
	"string",
]);

// Earlier joins in this edit may already have appended arguments to the edge.
function liveEdgeArguments(
	fn: CoreFunctionStore,
	from: CoreBlockId,
	to: CoreBlockId,
): ReadonlyArray<CoreValueId> {
	const terminator = fn.blockTerminator(from);
	const start = fn.kernel.terminatorEdgeStart(terminator);
	for (
		let edge = start;
		edge < start + fn.kernel.terminatorEdgeCount(terminator);
		edge++
	) {
		if (fn.kernel.terminatorEdgeBlock(edge) !== to) continue;
		const first = fn.kernel.terminatorEdgeArgumentStart(edge);
		return Array.from(
			{ length: fn.kernel.terminatorEdgeArgumentCount(edge) },
			(_, index) => fn.kernel.operandAt(first + index),
		);
	}
	throw new Error(`Core block ${from} has no edge to ${to}`);
}

function sameSlotValue(left: SlotValue, right: SlotValue): boolean {
	switch (left.kind) {
		case "value":
			return right.kind === "value" && left.value === right.value;
		case "phi":
			return right.kind === "phi" && left.block === right.block;
		case "unknown":
			return right.kind === "unknown";
	}
}

/**
 * Read an owner's own captured slots as SSA values. Only code nested in the owner
 * names its slots, so once no other function, arguments object or private-name
 * creation writes a slot, each load sees the value the owner's own stores leave on
 * every path to it, joined by block parameters where paths disagree. The function
 * entry and exception handlers keep reading the environment.
 */
function forwardOwnCapturedLoads(
	program: CoreProgram,
	fn: CoreFunctionStore,
	foreignWrites: ReadonlySet<string>,
	edit: () => CoreEditor,
): void {
	const slots = new Map<
		number,
		{ loads: Array<CoreInstructionId>; stores: Array<CoreInstructionId> }
	>();
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode !== "loadCaptured" && opcode !== "storeCaptured") continue;
		const { functionIndex, index } = fn.instructionAttributes(instruction);
		if (
			functionIndex !== fn.id ||
			typeof index !== "number" ||
			foreignWrites.has(key(fn.id, index))
		)
			continue;
		let slot = slots.get(index);
		if (slot === undefined) {
			slot = { loads: [], stores: [] };
			slots.set(index, slot);
		}
		(opcode === "loadCaptured" ? slot.loads : slot.stores).push(instruction);
	}
	for (const [index, slot] of slots)
		if (slot.loads.length === 0 || slot.stores.length === 0) slots.delete(index);
	if (slots.size === 0) return;
	const control = buildCoreControlFlow(program, fn.id);
	const definition = (value: CoreValueId): string | undefined =>
		fn.kernel.valueDefinitionKind(value) === 1
			? fn.instructionOpcodeName(coreInstructionId(fn.kernel.valueDefinitionOwner(value)))
			: undefined;
	const stored = (store: CoreInstructionId): CoreValueId =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(store));
	for (const { loads, stores } of slots.values()) {
		const storeSet = new Set(stores);
		const lastStore = new Map<CoreBlockId, CoreValueId>();
		for (const block of control.reversePostorder) {
			for (const instruction of fn.instructionIds(block))
				if (storeSet.has(instruction)) lastStore.set(block, stored(instruction));
		}
		const entry = new Map<CoreBlockId, SlotValue>();
		const exit = (block: CoreBlockId): SlotValue | undefined => {
			const value = lastStore.get(block);
			return value === undefined ? entry.get(block) : { kind: "value", value };
		};
		// Only ordinary edges carry a block parameter; handlers and the entry keep the slot.
		const joinable = (block: CoreBlockId): boolean =>
			block !== fn.entry &&
			(control.predecessors[block] ?? []).every(
				(edge, position, edges) =>
					edge.kind === "ordinary" &&
					edges.findIndex((other) => other.from === edge.from) === position,
			);
		let rounds = 0;
		for (let changed = true; changed; rounds++) {
			changed = false;
			for (const block of control.reversePostorder) {
				let value: SlotValue | undefined;
				if (!joinable(block)) value = UNKNOWN_SLOT;
				else
					for (const edge of control.predecessors[block] ?? []) {
						const incoming = exit(edge.from);
						if (incoming === undefined) continue;
						value =
							value === undefined || sameSlotValue(value, incoming)
								? incoming
								: { kind: "phi", block };
					}
				if (value === undefined) continue;
				const previous = entry.get(block);
				if (previous === undefined || !sameSlotValue(previous, value)) {
					entry.set(block, value);
					changed = true;
				}
			}
		}
		if (rounds > SLOT_FLOW_ROUNDS) continue;
		// A join may not carry the TDZ sentinel or a closure that is created lazily.
		const joins = new Map<CoreBlockId, boolean>();
		for (const [block, value] of entry)
			if (value.kind === "phi" && value.block === block) joins.set(block, true);
		for (let changed = true; changed;) {
			changed = false;
			for (const block of joins.keys()) {
				if (!joins.get(block)) continue;
				const valid = (control.predecessors[block] ?? []).every((edge) => {
					const incoming = exit(edge.from);
					if (incoming === undefined || incoming.kind === "unknown") return false;
					if (incoming.kind === "phi") return joins.get(incoming.block) === true;
					const opcode = definition(incoming.value);
					return opcode !== "createEmpty" && opcode !== "createFunction";
				});
				if (!valid) {
					joins.set(block, false);
					changed = true;
				}
			}
		}
		const representations = new Map<CoreBlockId, CoreRepresentation>();
		for (let changed = true; changed;) {
			changed = false;
			for (const [block, valid] of joins) {
				if (!valid) continue;
				let representation: CoreRepresentation | undefined;
				for (const edge of control.predecessors[block] ?? []) {
					const incoming = exit(edge.from);
					const next =
						incoming?.kind === "value"
							? fn.valueRepresentation(incoming.value)
							: incoming?.kind === "phi"
								? representations.get(incoming.block)
								: undefined;
					if (next === undefined) continue;
					representation =
						(representation === undefined || representation === next) &&
						SCALAR_JOIN_REPRESENTATIONS.has(next)
							? next
							: "boxed";
				}
				if (
					representation !== undefined &&
					representations.get(block) !== representation
				) {
					representations.set(block, representation);
					changed = true;
				}
			}
		}
		const parameters = new Map<CoreBlockId, CoreValueId>();
		const materialize = (block: CoreBlockId): CoreValueId => {
			const existing = parameters.get(block);
			if (existing !== undefined) return existing;
			const editor = edit();
			const representation = representations.get(block) ?? "boxed";
			const parameter = editor.appendBlockParameter(block, { representation });
			parameters.set(block, parameter);
			for (const edge of control.predecessors[block] ?? []) {
				const incoming = exit(edge.from);
				if (incoming === undefined || incoming.kind === "unknown")
					throw new Error("Validated captured-slot join lost an incoming value");
				let value =
					incoming.kind === "value" ? incoming.value : materialize(incoming.block);
				if (fn.valueRepresentation(value) !== representation)
					value = editor.insertInstruction(
						edge.from,
						fn.blockTerminator(edge.from),
						"move",
						[value],
						{ outputRepresentations: [representation] },
					).outputs[0]!;
				editor.redirectEdge(edge.from, block, {
					block,
					arguments: [...liveEdgeArguments(fn, edge.from, block), value],
				});
			}
			return parameter;
		};
		for (const load of loads) {
			const block = fn.instructionBlock(load);
			if (!control.reachable.has(block)) continue;
			let reaching = entry.get(block);
			for (const instruction of fn.instructionIds(block)) {
				if (instruction === load) break;
				if (storeSet.has(instruction))
					reaching = { kind: "value", value: stored(instruction) };
			}
			let value: CoreValueId | undefined;
			const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(load));
			if (reaching?.kind === "value") {
				const opcode = definition(reaching.value);
				// A nested function's object is created lazily at the binding reads where it
				// escapes, so only calls bypass them.
				if (
					opcode === "createEmpty" ||
					(opcode === "createFunction" && !onlyCalled(fn, result))
				)
					continue;
				value = reaching.value;
			} else if (reaching?.kind === "phi" && joins.get(reaching.block) === true)
				value = materialize(reaching.block);
			if (value === undefined) continue;
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
}

function onlyCalled(fn: CoreFunctionStore, value: CoreValueId): boolean {
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return false;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") return false;
		const opcode = header.opcode;
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
}

// Undefined when dynamic scope can read or write any slot.
function scanCapturedSlots(
	program: CoreProgram,
	functions: ReadonlyArray<CoreFunctionId>,
): CapturedSlotUses | undefined {
	const foreignWrites = new Set<string>();
	const implicitReads = new Set<string>();
	for (const id of functions) {
		const fn = program.function(id);
		for (const index of fn.metadata.mappedArgumentSlots) {
			foreignWrites.add(key(id, index));
			if (index >= 0) implicitReads.add(key(id, index));
		}
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (opcode.startsWith("with")) return undefined;
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "storeCaptured") {
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
	return { foreignWrites, implicitReads };
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
	for (let round = 0; round < 8; round++) {
		const identities = scanIdentities(program, functions);
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
		const instantiable = instantiableFunctions(program, roots);
		const live = functions.filter((id) => instantiable.has(id));
		const uses = scanCapturedSlots(program, live);
		if (uses === undefined) break;
		forwardAllOwnCapturedLoads(program, live, uses.foreignWrites, edit);
		const readers = new Set(uses.implicitReads);
		for (const id of live) {
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
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") continue;
				const opcode = header.opcode;
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
	}
	return [...editors.values()].map((editor) => editor.commit());
}

// Functions some running code can create; a body nothing creates never runs, even
// while it stays in the program as an inlining or guard source.
function instantiableFunctions(
	program: CoreProgram,
	roots: ReadonlySet<CoreFunctionId>,
): ReadonlySet<CoreFunctionId> {
	const live = new Set(roots);
	const pending = [...roots];
	while (pending.length > 0) {
		const fn = program.function(pending.pop()!);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "createFunction"
			)
				continue;
			const target = fn.instructionAttributes(instruction).functionIndex;
			if (typeof target !== "number" || live.has(coreFunctionId(target))) continue;
			live.add(coreFunctionId(target));
			pending.push(coreFunctionId(target));
		}
	}
	return live;
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
