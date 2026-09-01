import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
	coreMemoryPartition,
} from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_LOCAL_PROVENANCE_ANALYSIS,
	CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
	CORE_OWN_DATA_CELL_FACT,
} from "./core-ir-provenance.ts";
import type { CoreNamedAllocationLayout, CoreProvenance } from "./core-ir-provenance.ts";
import {
	CORE_EXACT_OWN_SLOT_ATTRIBUTE,
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
	CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
	coreKnownOwnSlotFromAttribute,
} from "./core-ir-shape-provenance.ts";
import {
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_LOCAL_VALUE_CLASS_ANALYSIS,
	coreCollectionReceiverBrandForOperation,
	coreExactCollectionBuiltinEffects,
} from "./core-ir-value-classes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreFactId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type {
	CoreChangeSet,
	CoreFunctionStore,
	CoreProgram,
	CoreUse,
} from "./core-store.ts";

const CONTAINED_FRESH_ARRAY_OPERATIONS = new Set([
	"Array.prototype.push",
	"Array.prototype.pop",
]);

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

function isLengthString(program: CoreProgram, index: number): boolean {
	const units = program.stringConstants[index];
	const length = [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68];
	return (
		units?.length === length.length &&
		units.every((unit, position) => unit === length[position])
	);
}

function replaceTerminatorEdges(
	payload: CoreTerminatorPayload,
	replace: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorPayload {
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: replace(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: payload.condition,
				consequent: replace(payload.consequent),
				alternate: replace(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: payload.condition,
				fact: payload.fact,
				success: replace(payload.success),
				fallback: replace(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: payload.discriminant,
				cases: payload.cases.map(({ value, edge }) => ({ value, edge: replace(edge) })),
				default: replace(payload.default),
			};
		case "return":
		case "throw":
		case "unreachable":
			return payload;
	}
}

const foldExactAllocationObservations: CorePass = {
	name: "fold-exact-allocation-observations",
	stage: "memory",
	scope: "instruction",
	requiredAnalyses: [CORE_LOCAL_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "cfg"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation"
		)
			return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		const operator = fn.instructionAttributes(item.instruction).operator;
		const operands = fn.instructionOperands(item.instruction);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		let replacement:
			| {
					readonly opcode: "createBoolean";
					readonly attributes: { readonly value: boolean };
			  }
			| {
					readonly opcode: "createString";
					readonly attributes: { readonly stringIndex: number };
			  }
			| undefined;
		if (
			opcode === "unary" &&
			operator === "typeof" &&
			operands[0] !== undefined &&
			provenance.allocationOf(operands[0]) !== undefined
		) {
			const stringIndex = program.stringConstants.findIndex(
				(units) =>
					units.length === 6 &&
					units.every((unit, index) => unit === "object".charCodeAt(index)),
			);
			if (stringIndex >= 0)
				replacement = { opcode: "createString", attributes: { stringIndex } };
		} else if (
			opcode === "binary" &&
			(operator === "===" || operator === "!==") &&
			operands[0] !== undefined &&
			operands[1] !== undefined
		) {
			const left = provenance.allocationOf(operands[0]);
			const right = provenance.allocationOf(operands[1]);
			if (left !== undefined && right !== undefined) {
				const same = right.instruction === left.instruction;
				replacement = {
					opcode: "createBoolean",
					attributes: { value: operator === "===" ? same : !same },
				};
			}
		}
		if (replacement === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(item.instruction, replacement.opcode, [], {
			attributes: replacement.attributes,
			sourcePosition: fn.instructionSourcePosition(item.instruction),
		});
		return editor.commit();
	},
};

const forwardFreshOwnSlotPrefix: CorePass = {
	name: "forward-fresh-own-slot-prefix",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		for (const layout of provenance.layouts) {
			if (layout.kind !== "named-slots") continue;
			const block = fn.instructionBlock(layout.instruction);
			const instructions = [...fn.bodyInstructionIds(block)];
			const allocationIndex = instructions.indexOf(layout.instruction);
			if (allocationIndex < 0) continue;
			const values = new Map(
				layout.keys.map((key, index) => [key, layout.initialValues[index]!] as const),
			);
			for (const instruction of instructions.slice(allocationIndex + 1)) {
				const opcode = fn.instructionOpcodeName(instruction);
				const operands = fn.instructionOperands(instruction);
				const aliases = operands.map(
					(value) => provenance.allocationOf(value)?.instruction === layout.instruction,
				);
				if (!aliases.some(Boolean)) continue;
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				const propertyAccess =
					(opcode === "loadPropertyStatic" || opcode === "storePropertyStatic") &&
					aliases[0] === true &&
					typeof stringIndex === "number" &&
					layout.keys.includes(stringIndex);
				const transparent = aliases.every(
					(alias, index) =>
						!alias ||
						(propertyAccess && (index === 0 || opcode === "storePropertyStatic")) ||
						(index === 0 &&
							(opcode === "move" || opcode === "throwIfTdz" || opcode === "rootUse")),
				);
				if (!transparent) break;
				if (!propertyAccess) continue;
				if (opcode === "storePropertyStatic") {
					if (operands[1] !== undefined) values.set(stringIndex, operands[1]);
					continue;
				}
				const result = fn.instructionResults(instruction)[0];
				const value = values.get(stringIndex);
				if (result === undefined || value === undefined) break;
				const editor = CoreEditor.open(program, item.function);
				if (fn.valueRepresentation(result) === fn.valueRepresentation(value)) {
					editor.replaceValueUses(result, value);
					removeInstructionAndOwnedProof(editor, fn, instruction);
				} else {
					const proof = fn.instructionEffectRefinement(instruction)?.proof;
					editor.replaceInstruction(instruction, "move", [value], {
						sourcePosition: fn.instructionSourcePosition(instruction),
					});
					removeUnsharedProof(editor, fn, proof);
				}
				return editor.commit();
			}
		}
		return undefined;
	},
};

const annotateKnownOwnSlots: CorePass = {
	name: "annotate-known-own-slots",
	stage: "memory",
	scope: "instruction",
	requiredAnalyses: [CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "memoryEffects"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: false, facts: false, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation"
		)
			return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "loadPropertyStatic" && opcode !== "storePropertyStatic")
			return undefined;
		const attributes = fn.instructionAttributes(item.instruction);
		if (coreKnownOwnSlotFromAttribute(attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]))
			return undefined;
		const stringIndex = attributes.stringIndex;
		const base = fn.instructionOperands(item.instruction)[0];
		if (typeof stringIndex !== "number" || base === undefined) return undefined;
		const shape = context.analysis(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS).candidates(base);
		if (shape.opaque || shape.origins.length === 0) return undefined;
		const candidates = shape.origins.flatMap((origin) => {
			const slot = origin.keys.indexOf(stringIndex);
			return slot < 0
				? []
				: [
						{
							shapeFunctionIndex: origin.function,
							shapeInstruction: origin.instruction,
							slot,
						},
					];
		});
		if (candidates.length !== shape.origins.length) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(
			item.instruction,
			opcode,
			fn.instructionOperands(item.instruction),
			{
				attributes: {
					...attributes,
					[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: { candidates },
				},
				sourcePosition: fn.instructionSourcePosition(item.instruction),
				effectRefinement: fn.instructionEffectRefinement(item.instruction),
			},
		);
		return editor.commit();
	},
};

const refineContainedOwnSlotAccesses: CorePass = {
	name: "refine-contained-own-slot-accesses",
	stage: "memory",
	scope: "instruction",
	requiredAnalyses: [
		CORE_LOCAL_PROVENANCE_ANALYSIS,
		CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "memoryEffects", "facts"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionEffectRefinement(item.instruction) !== undefined
		)
			return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		const mode =
			opcode === "loadProperty" || opcode === "loadPropertyStatic"
				? "read"
				: opcode === "storeProperty" ||
					  opcode === "storePropertyStatic" ||
					  opcode === "defineProperty"
					? "write"
					: undefined;
		if (mode === undefined) return undefined;
		const operands = fn.instructionOperands(item.instruction);
		const base = operands[0];
		if (base === undefined) return undefined;
		const attributes = fn.instructionAttributes(item.instruction);
		const stringIndex = attributes.stringIndex;
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		const shape = context.analysis(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS);
		const namedExact =
			typeof stringIndex === "number" && Number.isSafeInteger(stringIndex)
				? shape.exactOwnSlot(base, { kind: "string-constant", index: stringIndex }, mode)
				: undefined;
		const indexedLayout = provenance.allocationOf(base);
		const indexedAccess = coreMemoryAccesses(fn, item.instruction, {
			ownCell(candidateBase, key, accessMode) {
				const resolved = provenance.ownCell(candidateBase, key, accessMode);
				return resolved === undefined
					? undefined
					: { allocation: resolved.layout.instruction, cell: resolved.cell };
			},
		}).find(
			(access) =>
				access.base === base &&
				coreMemoryLocationIsExact(access.location) &&
				indexedLayout?.kind === "indexed" &&
				(access.location.kind === "element" || access.location.kind === "object-slot") &&
				access.location.allocation === indexedLayout.instruction &&
				(access.location.kind === "element" ||
					(access.location.kind === "object-slot" &&
						isLengthString(program, access.location.key))),
		);
		const indexedExact =
			indexedLayout?.kind === "indexed" &&
			indexedAccess !== undefined &&
			coreMemoryLocationIsExact(indexedAccess.location) &&
			(indexedAccess.location.kind === "element" ||
				indexedAccess.location.kind === "object-slot")
				? {
						layout: indexedLayout,
						slot:
							indexedAccess.location.kind === "element"
								? indexedAccess.location.index
								: 0,
					}
				: undefined;
		const exact = namedExact ?? indexedExact;
		if (exact === undefined) return undefined;
		if (mode === "write") {
			const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
			const cannotBeHeldWeakly = (value: CoreValueId): boolean =>
				provenance.cannotBeHeldWeakly(value) || kinds.exactScalar(value) !== undefined;
			const initial =
				exact.layout.kind === "named-slots"
					? exact.layout.initialValues[exact.slot]
					: exact.layout.elements.get(exact.slot)?.value;
			if (initial === undefined) return undefined;
			const occupants = [initial];
			for (const candidate of fn.instructionIds()) {
				if (fn.instructionKind(candidate) !== "operation") continue;
				const access = coreMemoryAccesses(fn, candidate, {
					ownCell(candidateBase, key, accessMode) {
						const resolved = provenance.ownCell(candidateBase, key, accessMode);
						return resolved === undefined
							? undefined
							: { allocation: resolved.layout.instruction, cell: resolved.cell };
					},
				}).find(
					(candidateAccess) =>
						candidateAccess.mode === "write" &&
						candidateAccess.value !== undefined &&
						coreMemoryLocationIsExact(candidateAccess.location) &&
						candidateAccess.location.kind ===
							(indexedExact === undefined ? "object-slot" : "element") &&
						candidateAccess.location.allocation === exact.layout.instruction &&
						(indexedExact === undefined
							? namedExact !== undefined &&
								candidateAccess.location.kind === "object-slot" &&
								candidateAccess.location.key === namedExact.layout.keys[namedExact.slot]
							: candidateAccess.location.kind === "element" &&
								candidateAccess.location.index === exact.slot),
				);
				if (access?.value !== undefined) occupants.push(access.value);
			}
			if (occupants.some((value) => !cannotBeHeldWeakly(value))) return undefined;
		}
		const effects = exactAccessEffects(mode);
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_OWN_DATA_CELL_FACT,
			value: Object.freeze({ allocation: exact.layout.instruction, slot: exact.slot }),
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: {
				kind: "summary",
				digest: `contained-allocation:${exact.layout.instruction}`,
			},
			obligations: [],
			origin: "local-shape-provenance",
		});
		editor.replaceInstruction(item.instruction, opcode, operands, {
			attributes: {
				...attributes,
				...(namedExact === undefined
					? {}
					: { [CORE_EXACT_OWN_SLOT_ATTRIBUTE]: exact.slot }),
			},
			sourcePosition: fn.instructionSourcePosition(item.instruction),
			effectRefinement: { effects, proof },
		});
		return editor.commit();
	},
};

const forwardExactMemoryLoads: CorePass = {
	name: "forward-exact-memory-loads",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [CORE_CONTROL_FLOW_ANALYSIS, CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS],
	wakesOn: ["body", "cfg", "memoryEffects"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_CONTROL_FLOW_ANALYSIS);
		const memory = context.analysis(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS);
		const available = new Map<
			string,
			Array<{ readonly instruction: CoreInstructionId; readonly value: CoreValueId }>
		>();
		for (const block of control.reversePostorder) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (
					fn.instructionKind(instruction) !== "operation" ||
					!effectsPermitRemoval(fn, instruction)
				)
					continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (
					!fn.registry.byId(fn.instructionOpcode(instruction)).discardable &&
					opcode !== "loadProperty" &&
					opcode !== "loadPropertyStatic" &&
					opcode !== "loadPropertyStaticShapeCase"
				)
					continue;
				const [result] = fn.instructionResults(instruction);
				const readKey = memory.readKey(instruction);
				if (result === undefined || readKey === undefined) continue;
				const key = [
					opcode,
					JSON.stringify(fn.instructionAttributes(instruction)),
					fn.instructionOperands(instruction).join(","),
					readKey,
					fn.valueRepresentation(result),
				].join("\0");
				const prior = (available.get(key) ?? []).findLast(
					(candidate) =>
						fn.instructionBlock(candidate.instruction) === block ||
						control.instructionDominatesBlock(
							fn.instructionBlock(candidate.instruction),
							block,
						),
				);
				if (
					prior !== undefined &&
					fn.valueRepresentation(prior.value) === fn.valueRepresentation(result)
				) {
					const editor = CoreEditor.open(program, item.function);
					editor.replaceValueUses(result, prior.value);
					removeInstructionAndOwnedProof(editor, fn, instruction);
					return editor.commit();
				}
				const candidates = available.get(key) ?? [];
				candidates.push({ instruction, value: result });
				available.set(key, candidates);
			}
		}
		return undefined;
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
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionEffectRefinement(item.instruction) !== undefined
		)
			return undefined;
		if (fn.instructionOpcodeName(item.instruction) !== "callBuiltin") return undefined;
		const operation = fn.instructionAttributes(item.instruction).operation;
		if (typeof operation !== "string") return undefined;
		const expected = coreCollectionReceiverBrandForOperation(operation);
		const receiver = fn.instructionOperands(item.instruction)[0];
		const classes = context.analysis(CORE_LOCAL_VALUE_CLASS_ANALYSIS);
		const exact =
			receiver === undefined
				? undefined
				: classes.containedCollection(receiver, item.instruction);
		if (exact === undefined || exact !== expected) return undefined;
		const effects = coreExactCollectionBuiltinEffects(fn, item.instruction, exact);
		if (effects === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
			value: operation,
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: {
				kind: "summary",
				digest: `exact-collection-builtin:${operation}`,
			},
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

const rewriteContainedFreshArrayBuiltins: CorePass = {
	name: "rewrite-contained-fresh-array-builtins",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "representations"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		if (
			item.scope !== "function" ||
			compilationContext.facts.world.primordialPolicy !== "locked"
		)
			return undefined;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		interface Candidate {
			readonly call: CoreInstructionId;
			readonly property: CoreInstructionId;
			readonly allocation: CoreInstructionId;
			readonly receiver: CoreValueId;
			readonly forwarded: ReadonlyArray<CoreValueId>;
			readonly operation: "Array.prototype.push" | "Array.prototype.pop";
			readonly known: KnownBuiltinCall;
		}
		const candidates: Array<Candidate> = [];
		for (const call of fn.instructionIds()) {
			if (
				fn.instructionKind(call) !== "operation" ||
				fn.instructionOpcodeName(call) !== "call"
			)
				continue;
			const operands = fn.instructionOperands(call);
			const [callee, receiver] = operands;
			if (callee === undefined || receiver === undefined) continue;
			const known = fn.instructionAttributes(call).knownBuiltinCall as unknown as
				| KnownBuiltinCall
				| undefined;
			const operation = known?.operation;
			if (
				known === undefined ||
				typeof operation !== "string" ||
				!CONTAINED_FRESH_ARRAY_OPERATIONS.has(operation) ||
				!knownBuiltinCallProves(known, operation) ||
				!compilerFactIsWorldInvariant(known.identity)
			)
				continue;
			const exact = exactBuiltinCallDescriptor(operation);
			if (exact?.receiverProof !== "fresh-array") continue;
			const calleeDefinition = fn.valueDefinition(callee);
			if (calleeDefinition.kind !== "instruction") continue;
			const property = calleeDefinition.instruction;
			if (
				fn.instructionKind(property) !== "operation" ||
				fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
				fn.valueUseCount(callee) !== 1
			)
				continue;
			const layout = provenance.allocationOf(receiver);
			const propertyBase = fn.instructionOperands(property)[0];
			if (
				layout?.kind !== "indexed" ||
				propertyBase === undefined ||
				provenance.allocationOf(propertyBase)?.instruction !== layout.instruction
			)
				continue;
			const arguments_ = operands.slice(2);
			candidates.push({
				call,
				property,
				allocation: layout.instruction,
				receiver,
				forwarded:
					exact.forwardedArgumentLimit === undefined
						? arguments_
						: arguments_.slice(0, exact.forwardedArgumentLimit),
				operation: operation as Candidate["operation"],
				known,
			});
		}
		if (candidates.length === 0) return undefined;
		const byCall = new Map(candidates.map((candidate) => [candidate.call, candidate]));
		const byProperty = new Map(
			candidates.map((candidate) => [candidate.property, candidate]),
		);
		const contained = new Set<CoreInstructionId>();
		for (const allocation of new Set(
			candidates.map((candidate) => candidate.allocation),
		)) {
			let valid = true;
			for (const instruction of fn.instructionIds()) {
				for (const [operandIndex, operand] of fn
					.instructionOperands(instruction)
					.entries()) {
					if (provenance.allocationOf(operand)?.instruction !== allocation) continue;
					const opcode =
						fn.instructionKind(instruction) === "operation"
							? fn.instructionOpcodeName(instruction)
							: undefined;
					const candidateCall = byCall.get(instruction);
					const candidateProperty = byProperty.get(instruction);
					const allowed =
						(candidateProperty?.allocation === allocation && operandIndex === 0) ||
						(candidateCall?.allocation === allocation && operandIndex === 1) ||
						((opcode === "loadProperty" || opcode === "storeProperty") &&
							operandIndex === 0 &&
							(fn.valueRepresentation(fn.instructionOperands(instruction)[1]!) ===
								"f64" ||
								fn.valueRepresentation(fn.instructionOperands(instruction)[1]!) ===
									"i32")) ||
						(opcode === "loadPropertyStatic" &&
							operandIndex === 0 &&
							typeof fn.instructionAttributes(instruction).stringIndex === "number" &&
							isLengthString(
								program,
								fn.instructionAttributes(instruction).stringIndex as number,
							));
					if (!allowed) valid = false;
				}
			}
			if (valid) contained.add(allocation);
		}
		const retained = candidates.filter((candidate) =>
			contained.has(candidate.allocation),
		);
		if (retained.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const candidate of retained) {
			editor.replaceInstruction(
				candidate.call,
				"callBuiltin",
				[candidate.receiver, ...candidate.forwarded],
				{
					attributes: {
						operation: candidate.operation,
						knownBuiltinCall: candidate.known as unknown as CoreAttributeValue,
					},
					sourcePosition: fn.instructionSourcePosition(candidate.call),
				},
			);
			editor.removeInstruction(candidate.property);
		}
		return editor.commit();
	},
};

function propertyBaseUse(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): boolean {
	if (fn.instructionKind(instruction) !== "operation") return false;
	return (fn.registry.byId(fn.instructionOpcode(instruction)).accesses ?? []).some(
		(access) => access.baseOperand === operand && access.family === "object-slot",
	);
}

function effectsPermitRemoval(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const effects = coreInstructionEffects(fn, instruction);
	return (
		!effects.mayThrow && !effects.maySuspend && !effects.mayGc && !effects.callsUserCode
	);
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
	const shared = [...fn.instructionIds()].some(
		(candidate) =>
			fn.instructionKind(candidate) === "operation" &&
			fn.instructionEffectRefinement(candidate)?.proof === proof,
	);
	if (!shared) editor.removeFact(proof);
}

interface RootedScalarAccess {
	readonly instruction: CoreInstructionId;
	readonly block: CoreBlockId;
	readonly index: number;
	readonly key: number;
	readonly value: CoreValueId;
}

function controlValue(payload: CoreTerminatorPayload): CoreValueId | undefined {
	switch (payload.kind) {
		case "branch":
		case "guard":
			return payload.condition;
		case "switch":
			return payload.discriminant;
		case "return":
		case "throw":
			return payload.value;
		case "jump":
		case "unreachable":
			return undefined;
	}
}

function scalarizeRootedLayout(
	program: CoreProgram,
	fn: CoreFunctionStore,
	layout: CoreNamedAllocationLayout,
	provenance: CoreProvenance,
	control: CoreControlFlow,
): CoreChangeSet | undefined {
	const allocationBlock = fn.instructionBlock(layout.instruction);
	if (
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		fn.blockHandler(allocationBlock) !== undefined ||
		control.loops.some(({ blocks }) => blocks.has(allocationBlock))
	)
		return undefined;
	const aliases = new Set<CoreValueId>();
	for (let rawValue = 0; rawValue < fn.valueCapacity; rawValue++) {
		const value = rawValue as CoreValueId;
		if (
			fn.isValueLive(value) &&
			provenance.allocationOf(value)?.instruction === layout.instruction
		) {
			aliases.add(value);
		}
	}
	const allocationInstructions = [...fn.bodyInstructionIds(allocationBlock)];
	const allocationIndex = allocationInstructions.indexOf(layout.instruction);
	if (allocationIndex < 0) return undefined;
	const stores: Array<RootedScalarAccess> = [];
	const loads: Array<RootedScalarAccess> = [];
	let valid = true;
	for (const block of control.reachable) {
		const payload = fn.terminatorPayload(fn.blockTerminator(block));
		const observed = controlValue(payload);
		if (observed !== undefined && aliases.has(observed)) {
			valid = false;
			break;
		}
		for (const edge of coreTerminatorEdges(payload)) {
			const parameters = fn.blockParameters(edge.block);
			if (
				edge.arguments.some(
					(argument, index) =>
						aliases.has(argument) && !aliases.has(parameters[index]!.value),
				)
			) {
				valid = false;
				break;
			}
		}
		if (!valid) break;
		const handler = fn.blockHandler(block);
		if (handler !== undefined) {
			const parameters = fn.blockParameters(handler.block);
			if (
				handler.arguments.some(
					(argument, index) =>
						aliases.has(argument) && !aliases.has(parameters[index + 1]!.value),
				)
			) {
				valid = false;
				break;
			}
		}
		for (const [index, instruction] of [...fn.bodyInstructionIds(block)].entries()) {
			const opcode = fn.instructionOpcodeName(instruction);
			const operands = fn.instructionOperands(instruction);
			for (const [position, operand] of operands.entries()) {
				if (!aliases.has(operand)) continue;
				if (
					position === 0 &&
					(opcode === "move" || opcode === "throwIfTdz" || opcode === "rootUse")
				)
					continue;
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				const mode =
					opcode === "loadPropertyStatic"
						? "read"
						: opcode === "storePropertyStatic"
							? "write"
							: undefined;
				const key =
					position === 0 &&
					mode !== undefined &&
					typeof stringIndex === "number" &&
					layout.keys.includes(stringIndex)
						? stringIndex
						: undefined;
				const accessValue =
					mode === "read" ? fn.instructionResults(instruction)[0] : operands[1];
				if (
					key === undefined ||
					accessValue === undefined ||
					fn.blockHandler(block) !== undefined ||
					(block === allocationBlock
						? index <= allocationIndex
						: !control.instructionDominatesBlock(allocationBlock, block))
				) {
					valid = false;
					break;
				}
				(mode === "read" ? loads : stores).push({
					instruction,
					block,
					index,
					key,
					value: accessValue,
				});
			}
			if (!valid) break;
		}
		if (!valid) break;
	}
	if (!valid || stores.length === 0) return undefined;
	if (new Set(stores.map(({ instruction }) => instruction)).size !== stores.length)
		return undefined;
	if (new Set(loads.map(({ instruction }) => instruction)).size !== loads.length)
		return undefined;

	const blocks = new Set<CoreBlockId>([...stores, ...loads].map(({ block }) => block));
	const worklist = [...blocks];
	while (worklist.length > 0 && valid) {
		const block = worklist.pop()!;
		if (block === allocationBlock) continue;
		for (const edge of control.predecessors[block] ?? []) {
			if (
				edge.from !== allocationBlock &&
				!control.instructionDominatesBlock(allocationBlock, edge.from)
			) {
				valid = false;
				break;
			}
			if (!blocks.has(edge.from)) {
				blocks.add(edge.from);
				worklist.push(edge.from);
			}
		}
	}
	if (
		!valid ||
		control.irreducibleCycles.some(({ blocks: cycle }) =>
			[...cycle].some((block) => blocks.has(block)),
		)
	)
		return undefined;

	const representationByKey = new Map<number, CoreRepresentation>();
	for (const [index, key] of layout.keys.entries()) {
		const values = [
			layout.initialValues[index]!,
			...stores.filter((store) => store.key === key).map(({ value }) => value),
		];
		const representation = fn.valueRepresentation(values[0]!);
		representationByKey.set(
			key,
			values.every((value) => fn.valueRepresentation(value) === representation)
				? representation
				: "boxed",
		);
	}
	const hasWeaklyHoldableOccupant = [
		...layout.initialValues,
		...stores.map(({ value }) => value),
	].some((value) => !provenance.cannotBeHeldWeakly(value));
	if (hasWeaklyHoldableOccupant) {
		const accesses = new Set([
			...stores.map(({ instruction }) => instruction),
			...loads.map(({ instruction }) => instruction),
		]);
		const hasRelevantSafepoint = [...blocks].some((block) => {
			const instructions = [...fn.bodyInstructionIds(block)];
			const start = block === allocationBlock ? allocationIndex + 1 : 0;
			const lastAccess = Math.max(
				-1,
				...stores.filter((store) => store.block === block).map(({ index }) => index),
				...loads.filter((load) => load.block === block).map(({ index }) => index),
			);
			const liveIntoSuccessor = (control.successors[block] ?? []).some(({ to }) =>
				blocks.has(to),
			);
			return instructions.some((instruction, index) => {
				if (
					index < start ||
					accesses.has(instruction) ||
					(index >= lastAccess && !liveIntoSuccessor)
				)
					return false;
				const effects = coreInstructionEffects(fn, instruction);
				return effects.mayGc || effects.maySuspend;
			});
		});
		if (!hasRelevantSafepoint) return undefined;
	}
	const editor = CoreEditor.open(program, fn.id);
	const handlerTargets = new Set(
		[...control.reachable].flatMap((block) => {
			const handler = fn.blockHandler(block);
			return handler === undefined ? [] : [handler.block];
		}),
	);
	const fieldParameters = new Map<CoreBlockId, Map<number, CoreValueId>>();
	for (const block of blocks) {
		if (block === allocationBlock) continue;
		const predecessors = control.predecessors[block] ?? [];
		if (
			predecessors.length === 1 &&
			predecessors[0]!.kind === "ordinary" &&
			!handlerTargets.has(block)
		)
			continue;
		const fields = new Map<number, CoreValueId>();
		for (const key of layout.keys) {
			fields.set(
				key,
				editor.appendBlockParameter(block, {
					representation: representationByKey.get(key)!,
				}),
			);
		}
		fieldParameters.set(block, fields);
	}

	const storesByInstruction = new Map(stores.map((store) => [store.instruction, store]));
	const loadsByInstruction = new Map(loads.map((load) => [load.instruction, load]));
	const replacements = new Map<CoreValueId, CoreValueId>();
	const resolve = (value: CoreValueId): CoreValueId => {
		const seen = new Set<CoreValueId>();
		let current = value;
		while (!seen.has(current)) {
			seen.add(current);
			const next = replacements.get(current);
			if (next === undefined) break;
			current = next;
		}
		return current;
	};
	const entryFields = new Map<CoreBlockId, Map<number, CoreValueId>>();
	const exitFields = new Map<CoreBlockId, Map<number, CoreValueId>>();
	const rootsAfter = new Map<CoreInstructionId, ReadonlyArray<CoreValueId>>();
	for (const block of control.reversePostorder) {
		if (!blocks.has(block)) continue;
		const parameters = fieldParameters.get(block);
		const current =
			block === allocationBlock
				? new Map(
						layout.keys.map((key, index) => [key, layout.initialValues[index]!] as const),
					)
				: parameters !== undefined
					? new Map(parameters)
					: new Map(exitFields.get(control.predecessors[block]![0]!.from));
		entryFields.set(block, new Map(current));
		const instructions = [...fn.bodyInstructionIds(block)];
		const start = block === allocationBlock ? allocationIndex + 1 : 0;
		const lastAccess = Math.max(
			-1,
			...stores.filter((store) => store.block === block).map(({ index }) => index),
			...loads.filter((load) => load.block === block).map(({ index }) => index),
		);
		const liveIntoSuccessor = (control.successors[block] ?? []).some(({ to }) =>
			blocks.has(to),
		);
		for (let index = start; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			const store = storesByInstruction.get(instruction);
			if (store !== undefined) {
				current.set(store.key, resolve(store.value));
				continue;
			}
			const load = loadsByInstruction.get(instruction);
			if (load !== undefined) {
				const source = current.get(load.key);
				if (source !== undefined) replacements.set(load.value, resolve(source));
				continue;
			}
			if (index >= lastAccess && !liveIntoSuccessor) continue;
			const effects = coreInstructionEffects(fn, instruction);
			if (!effects.mayGc && !effects.maySuspend) continue;
			const operands = fn.instructionOperands(instruction);
			const values = [
				...new Set(
					[...current.values()]
						.map(resolve)
						.filter(
							(value) =>
								!provenance.cannotBeHeldWeakly(value) &&
								(effects.maySuspend || !operands.includes(value)),
						),
				),
			];
			if (values.length > 0) rootsAfter.set(instruction, values);
		}
		exitFields.set(block, new Map(current));
	}
	for (const block of blocks) {
		const payload = fn.terminatorPayload(fn.blockTerminator(block));
		const exit = exitFields.get(block)!;
		const edgeValues = new Map<string, CoreValueId>();
		const edgeValue = (
			value: CoreValueId,
			representation: CoreRepresentation,
		): CoreValueId => {
			if (fn.valueRepresentation(value) === representation) return value;
			if (representation !== "boxed") {
				throw new Error("Virtual object field edge requires an unsupported conversion");
			}
			const key = `${value}:${representation}`;
			const existing = edgeValues.get(key);
			if (existing !== undefined) return existing;
			const converted = editor.appendInstruction(block, "move", [value], {
				outputRepresentations: [representation],
			}).outputs[0]!;
			edgeValues.set(key, converted);
			return converted;
		};
		editor.replaceTerminator(
			block,
			replaceTerminatorEdges(payload, (edge) => {
				const parameters = fieldParameters.get(edge.block);
				return parameters === undefined
					? edge
					: {
							block: edge.block,
							arguments: [
								...edge.arguments,
								...layout.keys.map((key) => {
									const value = resolve(exit.get(key)!);
									return edgeValue(value, representationByKey.get(key)!);
								}),
							],
						};
			}),
		);
		const handler = fn.blockHandler(block);
		if (handler !== undefined && fieldParameters.has(handler.block)) {
			const entry = entryFields.get(block)!;
			editor.setHandler(block, handler.block, [
				...handler.arguments,
				...layout.keys.map((key) => resolve(entry.get(key)!)),
			]);
		}
	}

	for (const [instruction, values] of rootsAfter) {
		editor.insertInstruction(
			fn.instructionBlock(instruction),
			fn.instructionNext(instruction),
			"rootUse",
			values.map(resolve),
			{ outputCount: 0 },
		);
	}
	for (const load of loads) {
		const source = resolve(replacements.get(load.value)!);
		if (fn.valueRepresentation(source) === fn.valueRepresentation(load.value)) {
			editor.replaceValueUses(load.value, source);
			removeInstructionAndOwnedProof(editor, fn, load.instruction);
		} else {
			const proof = fn.instructionEffectRefinement(load.instruction)?.proof;
			editor.replaceInstruction(load.instruction, "move", [source], {
				sourcePosition: fn.instructionSourcePosition(load.instruction),
			});
			removeUnsharedProof(editor, fn, proof);
		}
	}
	for (const store of stores)
		removeInstructionAndOwnedProof(editor, fn, store.instruction);
	editor.replaceInstruction(layout.instruction, "createUndefined", [], {
		sourcePosition: fn.instructionSourcePosition(layout.instruction),
	});
	return editor.commit();
}

const scalarizeRootedContainedObjects: CorePass = {
	name: "scalarize-rooted-contained-objects",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
		CORE_LOCAL_PROVENANCE_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	preserves: ["local-interprocedural-flow"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		const control = context.analysis(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS);
		for (const layout of provenance.layouts) {
			if (layout.kind !== "named-slots") continue;
			const changes = scalarizeRootedLayout(program, fn, layout, provenance, control);
			if (changes !== undefined) return changes;
		}
		return undefined;
	},
};

type CoreAggregateCellContent = "uninitialized" | "boxed" | "i32" | "f64" | "boolean";

function aggregateCellContent(
	representation: CoreRepresentation,
): CoreAggregateCellContent {
	return representation === "i32" ||
		representation === "f64" ||
		representation === "boolean"
		? representation
		: "boxed";
}

function joinAggregateCellContent(
	left: CoreAggregateCellContent,
	right: CoreAggregateCellContent,
): CoreAggregateCellContent {
	if (left === "uninitialized") return right;
	if (right === "uninitialized" || left === right) return left;
	return "boxed";
}

const refineStackObjectCellRepresentations: CorePass = {
	name: "refine-stack-object-cell-representations",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [
		CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "facts", "representations", "specializationInputs"],
	preserves: ["control-flow", "exception-control-flow", "local-interprocedural-flow"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const proofs = context.analysis(CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const refinements = new Map<CoreValueId, "i32" | "f64" | "boolean">();
		const canRefine = (
			value: CoreValueId,
			representation: "i32" | "f64" | "boolean",
			seen: ReadonlySet<CoreValueId> = new Set(),
		): boolean => {
			if (fn.valueRepresentation(value) === representation) return true;
			if (seen.has(value)) return false;
			const definition = fn.valueDefinition(value);
			if (definition.kind !== "instruction") return false;
			if (fn.instructionOpcodeName(definition.instruction) !== "move") return true;
			const source = fn.instructionOperands(definition.instruction)[0];
			return source === undefined
				? false
				: canRefine(source, representation, new Set([...seen, value]));
		};
		const cellContent = (value: CoreValueId): CoreAggregateCellContent => {
			const representation = aggregateCellContent(fn.valueRepresentation(value));
			if (representation !== "boxed") return representation;
			const content = (() => {
				switch (kinds.exactScalar(value)) {
					case "int32":
						return "i32";
					case "number":
						return "f64";
					case "boolean":
						return "boolean";
					case "string":
					case undefined:
						return "boxed";
				}
			})();
			return content === "boxed" || !canRefine(value, content) ? "boxed" : content;
		};
		for (const candidate of proofs.proofs) {
			if (candidate.mode !== "activation-local" || candidate.materializations.length > 0)
				continue;
			const contents = new Array<CoreAggregateCellContent>(candidate.slotCount).fill(
				"uninitialized",
			);
			for (const [slot, value] of fn
				.instructionOperands(candidate.allocation)
				.entries()) {
				if (slot >= contents.length) break;
				contents[slot] = joinAggregateCellContent(contents[slot]!, cellContent(value));
			}
			for (const access of candidate.accesses) {
				if (fn.instructionOpcodeName(access.instruction) !== "storePropertyStatic") {
					continue;
				}
				const value = fn.instructionOperands(access.instruction)[1];
				if (value === undefined) continue;
				contents[access.slot] = joinAggregateCellContent(
					contents[access.slot]!,
					cellContent(value),
				);
			}
			for (const [, value] of fn.instructionOperands(candidate.allocation).entries()) {
				const content = cellContent(value);
				if (
					(content === "i32" || content === "f64" || content === "boolean") &&
					canRefine(value, content)
				) {
					refinements.set(value, content);
				}
			}
			for (const access of candidate.accesses) {
				if (fn.instructionOpcodeName(access.instruction) !== "storePropertyStatic") {
					continue;
				}
				const value = fn.instructionOperands(access.instruction)[1];
				const content = value === undefined ? undefined : cellContent(value);
				if (
					value !== undefined &&
					(content === "i32" || content === "f64" || content === "boolean") &&
					canRefine(value, content)
				) {
					refinements.set(value, content);
				}
			}
			for (const access of candidate.accesses) {
				if (fn.instructionOpcodeName(access.instruction) !== "loadPropertyStatic") {
					continue;
				}
				const result = fn.instructionResults(access.instruction)[0];
				const content = contents[access.slot];
				if (
					result !== undefined &&
					fn.valueRepresentation(result) === "boxed" &&
					(content === "i32" || content === "f64" || content === "boolean") &&
					canRefine(result, content)
				) {
					refinements.set(result, content);
				}
			}
		}
		if (refinements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [value, representation] of refinements) {
			editor.setValueRepresentation(value, representation);
		}
		return editor.commit();
	},
};

const scalarReplaceContainedAggregates: CorePass = {
	name: "scalar-replace-contained-aggregates",
	stage: "memory",
	scope: "function",
	requiredAnalyses: [
		CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
		CORE_LOCAL_PROVENANCE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
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
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const cannotBeHeldWeakly = (value: CoreValueId): boolean =>
			provenance.cannotBeHeldWeakly(value) || kinds.exactScalar(value) !== undefined;
		const replacements = new Map<
			CoreInstructionId,
			{
				readonly result: CoreValueId;
				readonly value: CoreValueId;
				readonly kind: "eliminate" | "box";
			}
		>();
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				!effectsPermitRemoval(fn, instruction)
			)
				continue;
			const outputs = fn.instructionResults(instruction);
			if (outputs.length !== 1) continue;
			for (const access of coreMemoryAccesses(fn, instruction, {
				ownCell(base, key, mode) {
					const resolved = provenance.ownCell(base, key, mode);
					return resolved === undefined
						? undefined
						: { allocation: resolved.layout.instruction, cell: resolved.cell };
				},
			})) {
				if (access.mode !== "read" || !coreMemoryLocationIsExact(access.location))
					continue;
				const value = memory.valueForRead(
					instruction,
					coreMemoryPartition(access.location),
				);
				if (value === undefined || value === outputs[0]) continue;
				const sourceRepresentation = fn.valueRepresentation(value);
				const destinationRepresentation = fn.valueRepresentation(outputs[0]!);
				if (sourceRepresentation === destinationRepresentation) {
					replacements.set(instruction, {
						result: outputs[0]!,
						value,
						kind: "eliminate",
					});
				} else if (
					destinationRepresentation === "boxed" &&
					(sourceRepresentation === "f64" ||
						sourceRepresentation === "i32" ||
						sourceRepresentation === "boolean")
				) {
					replacements.set(instruction, { result: outputs[0]!, value, kind: "box" });
				}
			}
		}
		const removableStores = new Set<CoreInstructionId>();
		const removableAllocations = new Set<CoreInstructionId>();
		for (const layout of provenance.layouts) {
			if (provenance.escape(layout.instruction) !== "contained") continue;
			const initialValues = layout.kind === "named-slots" ? layout.initialValues : [];
			if (initialValues.some((value) => !cannotBeHeldWeakly(value))) continue;
			let removable = true;
			const stores: Array<CoreInstructionId> = [];
			const uses = new Map<string, CoreUse>();
			for (let rawValue = 0; rawValue < fn.valueCapacity; rawValue++) {
				const value = rawValue as CoreValueId;
				if (
					!fn.isValueLive(value) ||
					provenance.allocationOf(value)?.instruction !== layout.instruction
				)
					continue;
				for (const use of fn.uses(value)) {
					uses.set(`${use.instruction}:${use.operand}`, use);
				}
			}
			for (const use of uses.values()) {
				if (
					fn.instructionKind(use.instruction) === "operation" &&
					use.operand === 0 &&
					["move", "throwIfTdz", "rootUse"].includes(
						fn.instructionOpcodeName(use.instruction),
					)
				)
					continue;
				if (!propertyBaseUse(fn, use.instruction, use.operand)) {
					removable = false;
					break;
				}
				const accesses = coreMemoryAccesses(fn, use.instruction, {
					ownCell(base, key, mode) {
						const resolved = provenance.ownCell(base, key, mode);
						return resolved === undefined
							? undefined
							: { allocation: resolved.layout.instruction, cell: resolved.cell };
					},
				});
				const access = accesses.find((candidate) => candidate.base === layout.result);
				if (
					access === undefined ||
					!coreMemoryLocationIsExact(access.location) ||
					(access.location.kind !== "object-slot" &&
						access.location.kind !== "element") ||
					access.location.allocation !== layout.instruction ||
					!effectsPermitRemoval(fn, use.instruction)
				) {
					removable = false;
					break;
				}
				if (access.mode === "read") {
					if (!replacements.has(use.instruction)) {
						removable = false;
						break;
					}
				} else {
					if (access.value === undefined || !cannotBeHeldWeakly(access.value)) {
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
			if (fn.isInstructionLive(instruction))
				removeInstructionAndOwnedProof(editor, fn, instruction);
		}
		for (const instruction of removableAllocations) {
			if (!fn.isInstructionLive(instruction)) continue;
			if (
				fn.instructionResults(instruction).every((value) => fn.valueUseCount(value) === 0)
			)
				editor.removeInstruction(instruction);
			else
				editor.replaceInstruction(instruction, "createUndefined", [], {
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
		}
		return editor.commit();
	},
};

export const CORE_MEMORY_PASSES: ReadonlyArray<CorePass> = [
	foldExactAllocationObservations,
	forwardFreshOwnSlotPrefix,
	annotateKnownOwnSlots,
	refineContainedOwnSlotAccesses,
	forwardExactMemoryLoads,
	rewriteContainedFreshArrayBuiltins,
	refineExactCollectionAccesses,
	refineStackObjectCellRepresentations,
	scalarizeRootedContainedObjects,
	scalarReplaceContainedAggregates,
];
import { exactBuiltinCallDescriptor } from "../shared/builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
