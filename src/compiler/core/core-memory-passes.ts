import { CoreEditor } from "./core-editor.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
	coreMemoryPartition,
} from "./core-ir-memory.ts";
import {
	CORE_LOCAL_PROVENANCE_ANALYSIS,
	CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
	CORE_OWN_DATA_CELL_FACT,
} from "./core-ir-provenance.ts";
import {
	CORE_EXACT_OWN_SLOT_ATTRIBUTE,
	CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
} from "./core-ir-shape-provenance.ts";
import {
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_LOCAL_VALUE_CLASS_ANALYSIS,
	coreCollectionReceiverBrandForOperation,
	coreExactCollectionBuiltinEffects,
} from "./core-ir-value-classes.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreFactId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const MEMORY_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

function exactAccessEffects(mode: "read" | "write"): CoreInstructionEffects {
	const effects: CoreInstructionEffects = {
		reads: Object.freeze(mode === "read" ? ["object-property"] : []),
		writes: Object.freeze(mode === "write" ? ["object-property"] : []),
		mayThrow: false,
		maySuspend: false,
		mayGc: false,
		callsUserCode: false,
	};
	return Object.freeze(effects);
}

const refineContainedOwnSlotAccesses: CorePass = {
	name: "refine-contained-own-slot-accesses",
	stage: "memory",
	scope: "instruction",
	requiredAnalyses: [CORE_LOCAL_PROVENANCE_ANALYSIS, CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionEffectRefinement(item.instruction) !== undefined) return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "loadPropertyStatic" && opcode !== "storePropertyStatic") return undefined;
		const operands = fn.instructionOperands(item.instruction);
		const base = operands[0];
		const stringIndex = fn.instructionAttributes(item.instruction).stringIndex;
		if (base === undefined || typeof stringIndex !== "number" || !Number.isSafeInteger(stringIndex)) return undefined;
		const mode = opcode === "loadPropertyStatic" ? "read" : "write";
		const shape = context.analysis(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS);
		const exact = shape.exactOwnSlot(base, { kind: "string-constant", index: stringIndex }, mode);
		if (exact === undefined) return undefined;
		const effects = exactAccessEffects(mode);
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_OWN_DATA_CELL_FACT,
			value: Object.freeze({ allocation: exact.layout.instruction, slot: exact.slot }),
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: { kind: "asserted", source: "local-shape-provenance" },
			obligations: [],
			origin: "local-shape-provenance",
		});
		editor.replaceInstruction(item.instruction, opcode, operands, {
			attributes: {
				...fn.instructionAttributes(item.instruction),
				[CORE_EXACT_OWN_SLOT_ATTRIBUTE]: exact.slot,
			},
			sourcePosition: fn.instructionSourcePosition(item.instruction),
			effectRefinement: { effects, proof },
		});
		return editor.commit();
	},
};

const refineExactCollectionAccesses: CorePass = {
	name: "refine-exact-collection-accesses",
	stage: "memory",
	scope: "instruction",
	requiredAnalyses: [CORE_LOCAL_VALUE_CLASS_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionEffectRefinement(item.instruction) !== undefined) return undefined;
		if (fn.instructionOpcodeName(item.instruction) !== "callBuiltin") return undefined;
		const operation = fn.instructionAttributes(item.instruction).operation;
		const expected = coreCollectionReceiverBrandForOperation(operation);
		const receiver = fn.instructionOperands(item.instruction)[0];
		const classes = context.analysis(CORE_LOCAL_VALUE_CLASS_ANALYSIS);
		const exact = receiver === undefined ? undefined : classes.containedCollection(receiver, item.instruction);
		if (exact === undefined || exact !== expected) return undefined;
		const effects = coreExactCollectionBuiltinEffects(fn, item.instruction, exact);
		if (effects === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
			value: fn.instructionAttributes(item.instruction).operation,
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: { kind: "asserted", source: "local-value-classes" },
			obligations: [],
			origin: "local-value-classes",
		});
		editor.replaceInstruction(
			item.instruction,
			"callBuiltin",
			fn.instructionOperands(item.instruction),
			{
				attributes: {
					...fn.instructionAttributes(item.instruction),
					[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE]: exact,
				},
				sourcePosition: fn.instructionSourcePosition(item.instruction),
				effectRefinement: { effects, proof },
			},
		);
		return editor.commit();
	},
};

function propertyBaseUse(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): boolean {
	if (fn.instructionKind(instruction) !== "operation") return false;
	return (fn.registry.byId(fn.instructionOpcode(instruction)).accesses ?? [])
		.some((access) => access.baseOperand === operand && access.family === "object-slot");
}

function effectsPermitRemoval(fn: CoreFunctionStore, instruction: CoreInstructionId): boolean {
	const effects = coreInstructionEffects(fn, instruction);
	return !effects.mayThrow && !effects.maySuspend && !effects.mayGc && !effects.callsUserCode;
}

function removeInstructionAndOwnedProof(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): void {
	const proof = fn.instructionEffectRefinement(instruction)?.proof;
	editor.removeInstruction(instruction);
	removeUnsharedProof(editor, fn, proof);
}

function removeUnsharedProof(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	proof: CoreFactId | undefined,
): void {
	if (proof === undefined || !fn.isFactLive(proof)) return;
	const shared = [...fn.instructionIds()].some((candidate) =>
		fn.instructionKind(candidate) === "operation" &&
		fn.instructionEffectRefinement(candidate)?.proof === proof,
	);
	if (!shared) editor.removeFact(proof);
}

const scalarReplaceContainedAggregates: CorePass = {
	name: "scalar-replace-contained-aggregates",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [
		CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
		CORE_LOCAL_PROVENANCE_ANALYSIS,
		CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS,
	],
	wakesOn: ["body", "memoryEffects", "facts"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const memory = context.analysis(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		context.analysis(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS);
		const replacements = new Map<CoreInstructionId, {
			readonly result: CoreValueId;
			readonly value: CoreValueId;
			readonly kind: "eliminate" | "box";
		}>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation" || !effectsPermitRemoval(fn, instruction)) continue;
			const outputs = fn.instructionResults(instruction);
			if (outputs.length !== 1) continue;
			for (const access of coreMemoryAccesses(fn, instruction, {
				ownCell(base, key, mode) {
					const resolved = provenance.ownCell(base, key, mode);
					return resolved === undefined ? undefined : { allocation: resolved.layout.instruction, cell: resolved.cell };
				},
			})) {
				if (access.mode !== "read" || !coreMemoryLocationIsExact(access.location)) continue;
				const value = memory.valueForRead(instruction, coreMemoryPartition(access.location));
				if (value === undefined || value === outputs[0]) continue;
				const sourceRepresentation = fn.valueRepresentation(value);
				const destinationRepresentation = fn.valueRepresentation(outputs[0]!);
				if (sourceRepresentation === destinationRepresentation) {
					replacements.set(instruction, { result: outputs[0]!, value, kind: "eliminate" });
				} else if (destinationRepresentation === "boxed" &&
					(sourceRepresentation === "f64" || sourceRepresentation === "i32" ||
						sourceRepresentation === "boolean")) {
					replacements.set(instruction, { result: outputs[0]!, value, kind: "box" });
				}
			}
		}
		const removableStores = new Set<CoreInstructionId>();
		const removableAllocations = new Set<CoreInstructionId>();
		for (const layout of provenance.layouts) {
			if (provenance.escape(layout.instruction) !== "contained") continue;
			const initialValues = layout.kind === "named-slots" ? layout.initialValues : [];
			if (initialValues.some((value) => !provenance.cannotBeHeldWeakly(value))) continue;
			let removable = true;
			const stores: Array<CoreInstructionId> = [];
			for (const use of fn.uses(layout.result)) {
				if (!propertyBaseUse(fn, use.instruction, use.operand)) {
					removable = false;
					break;
				}
				const accesses = coreMemoryAccesses(fn, use.instruction, {
					ownCell(base, key, mode) {
						const resolved = provenance.ownCell(base, key, mode);
						return resolved === undefined ? undefined : { allocation: resolved.layout.instruction, cell: resolved.cell };
					},
				});
				const access = accesses.find((candidate) => candidate.base === layout.result);
				if (access === undefined || !coreMemoryLocationIsExact(access.location) ||
					(access.location.kind !== "object-slot" && access.location.kind !== "element") ||
					access.location.allocation !== layout.instruction || !effectsPermitRemoval(fn, use.instruction)) {
					removable = false;
					break;
				}
				if (access.mode === "read") {
					if (!replacements.has(use.instruction)) {
						removable = false;
						break;
					}
				} else {
					if (access.value === undefined || !provenance.cannotBeHeldWeakly(access.value)) {
						removable = false;
						break;
					}
					stores.push(use.instruction);
				}
			}
			if (removable) {
				for (const store of stores) removableStores.add(store);
				removableAllocations.add(layout.instruction);
			}
		}
		if (replacements.size === 0 && removableAllocations.size === 0) return undefined;
		const replacementByResult = new Map(
			[...replacements.values()]
				.filter((replacement) => replacement.kind === "eliminate")
				.map((replacement) => [replacement.result, replacement.value]),
		);
		const finalReplacement = (value: CoreValueId): CoreValueId => {
			const seen = new Set<CoreValueId>();
			let current = value;
			while (!seen.has(current)) {
				seen.add(current);
				const next = replacementByResult.get(current);
				if (next === undefined) break;
				current = next;
			}
			return current;
		};
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const value = finalReplacement(replacement.value);
			if (replacement.kind === "eliminate") {
				editor.replaceValueUses(replacement.result, value);
				removeInstructionAndOwnedProof(editor, fn, instruction);
			} else {
				const proof = fn.instructionEffectRefinement(instruction)?.proof;
				editor.replaceInstruction(instruction, "move", [value], {
					attributes: {},
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				removeUnsharedProof(editor, fn, proof);
			}
		}
		for (const instruction of removableStores) {
			if (fn.isInstructionLive(instruction)) removeInstructionAndOwnedProof(editor, fn, instruction);
		}
		for (const instruction of removableAllocations) {
			if (fn.isInstructionLive(instruction) && fn.instructionResults(instruction).every((value) => fn.valueUseCount(value) === 0)) {
				editor.removeInstruction(instruction);
			}
		}
		return editor.commit();
	},
};

export const CORE_MEMORY_PASSES: ReadonlyArray<CorePass> = [
	refineContainedOwnSlotAccesses,
	refineExactCollectionAccesses,
	scalarReplaceContainedAggregates,
];
