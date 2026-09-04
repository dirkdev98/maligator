import { CoreEditor } from "./core-editor.ts";
import {
	CORE_FUNCTION_HAS_ALLOCATIONS,
	CORE_FUNCTION_HAS_MEMORY_ACCESSES,
} from "./core-function-features.ts";
import { CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE } from "./core-internal-attributes.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionInputsEqual } from "./core-ir-equality.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	coreMemoryAccesses,
	coreMemoryLocationIsExact,
} from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
	CORE_OWN_DATA_CELL_FACT,
} from "./core-ir-provenance.ts";
import type {
	CoreLocalFactIndex,
	CoreNamedAllocationLayout,
	CoreProvenance,
} from "./core-ir-provenance.ts";
import {
	CORE_EXACT_OWN_SLOT_ATTRIBUTE,
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
	CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
	coreKnownOwnSlotFromAttribute,
} from "./core-ir-shape-provenance.ts";
import {
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
	coreCollectionReceiverBrandForOperation,
	coreExactCollectionBuiltinEffects,
} from "./core-ir-value-classes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
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
import { coreInstructionId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";

const CONTAINED_FRESH_ARRAY_OPERATIONS = new Set([
	"Array.prototype.push",
	"Array.prototype.pop",
]);

const PROVENANCE_BUDGET = CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"];
const MEMORY_BUDGET = CORE_O2_PASS_BUDGETS["memory-ssa-load-store"];

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

function instructionOperandAt(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	offset: number,
): CoreValueId | undefined {
	if (offset < 0 || offset >= fn.kernel.instructionOperandCount(instruction))
		return undefined;
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + offset);
}

function instructionResultAt(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	offset: number,
): CoreValueId | undefined {
	if (offset < 0 || offset >= fn.kernel.instructionResultCount(instruction))
		return undefined;
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + offset);
}

function hasExactMemoryLoadForwardingOpportunity(fn: CoreFunctionStore): boolean {
	const candidatesByInputs = new Map<number, Array<CoreInstructionId>>();
	for (const instruction of fn.instructionIds()) {
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
		const result = instructionResultAt(fn, instruction, 0);
		if (result === undefined) continue;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		let inputHash = Math.imul(fn.instructionOpcode(instruction) + 1, 16_777_619);
		for (let index = 0; index < operandCount; index++) {
			inputHash = Math.imul(
				inputHash ^ (fn.kernel.operandAt(operandStart + index) + 1),
				16_777_619,
			);
		}
		inputHash = Math.imul(inputHash ^ operandCount, 16_777_619);
		const candidates = candidatesByInputs.get(inputHash) ?? [];
		if (
			candidates.some((candidate) => {
				const candidateResult = instructionResultAt(fn, candidate, 0);
				return (
					candidateResult !== undefined &&
					fn.valueRepresentation(candidateResult) === fn.valueRepresentation(result) &&
					coreInstructionInputsEqual(fn, candidate, instruction)
				);
			})
		)
			return true;
		candidates.push(instruction);
		candidatesByInputs.set(inputHash, candidates);
	}
	return false;
}

function materializeInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const values: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		values.push(fn.kernel.operandAt(start + index));
	return values;
}

function materializeEdge(fn: CoreFunctionStore, edge: number): CoreEdge {
	const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
	const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
	const arguments_: Array<CoreValueId> = [];
	for (let index = 0; index < argumentCount; index++)
		arguments_.push(fn.kernel.operandAt(argumentStart + index));
	return { block: fn.kernel.terminatorEdgeBlock(edge), arguments: arguments_ };
}

function replaceTerminatorEdges(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	replace: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorPayload {
	const kind = fn.instructionKind(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	switch (kind) {
		case "jump":
			return { kind, edge: replace(materializeEdge(fn, edgeStart)) };
		case "branch":
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				consequent: replace(materializeEdge(fn, edgeStart)),
				alternate: replace(materializeEdge(fn, edgeStart + 1)),
			};
		case "guard": {
			const fact = fn.kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error(`Core guard ${instruction} has no fact`);
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				fact,
				success: replace(materializeEdge(fn, edgeStart)),
				fallback: replace(materializeEdge(fn, edgeStart + 1)),
			};
		}
		case "switch": {
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			const cases: Array<
				Extract<CoreTerminatorPayload, { kind: "switch" }>["cases"][number]
			> = [];
			for (let index = 0; index < edgeCount - 1; index++) {
				const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + index);
				if (value === undefined)
					throw new Error(`Core switch ${instruction} has no case`);
				cases.push({ value, edge: replace(materializeEdge(fn, edgeStart + index)) });
			}
			return {
				kind,
				discriminant: fn.kernel.operandAt(operandStart),
				cases,
				default: replace(materializeEdge(fn, edgeStart + edgeCount - 1)),
			};
		}
		case "return":
		case "throw":
			return { kind, value: fn.kernel.operandAt(operandStart) };
		case "unreachable":
			return { kind };
		case "operation":
			throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
}

function mayResolveToAllocation(fn: CoreFunctionStore, value: CoreValueId): boolean {
	const seen = new Set<CoreValueId>();
	let current = value;
	while (!seen.has(current)) {
		seen.add(current);
		if (fn.kernel.valueDefinitionKind(current) !== 1) return true;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(current));
		if (fn.instructionKind(definition) !== "operation") return true;
		if (
			fn.registry.byId(fn.instructionOpcode(definition)).allocation !== undefined &&
			instructionResultAt(fn, definition, 0) === current
		)
			return true;
		if (fn.instructionOpcodeName(definition) !== "move") return false;
		const source = instructionOperandAt(fn, definition, 0);
		if (source === undefined) return true;
		current = source;
	}
	return true;
}

function hasExactAllocationObservationOpportunity(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operator = fn.instructionAttributes(instruction).operator;
		if (opcode === "unary" && operator === "typeof") {
			const operand = instructionOperandAt(fn, instruction, 0);
			if (operand !== undefined && mayResolveToAllocation(fn, operand)) return true;
		} else if (opcode === "binary" && (operator === "===" || operator === "!==")) {
			const left = instructionOperandAt(fn, instruction, 0);
			const right = instructionOperandAt(fn, instruction, 1);
			if (
				left !== undefined &&
				right !== undefined &&
				mayResolveToAllocation(fn, left) &&
				mayResolveToAllocation(fn, right)
			)
				return true;
		}
	}
	return false;
}

function hasShapedObjectLoadOpportunity(fn: CoreFunctionStore): boolean {
	let hasShapedObject = false;
	let hasStaticLoad = false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createObjectShaped") hasShapedObject = true;
		else if (opcode === "loadPropertyStatic") hasStaticLoad = true;
		if (hasShapedObject && hasStaticLoad) return true;
	}
	return false;
}

function hasContainedFreshArrayBuiltinOpportunity(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "call"
		)
			continue;
		const known = fn.instructionAttributes(instruction).knownBuiltinCall as unknown as
			| KnownBuiltinCall
			| undefined;
		const operation = known?.operation;
		if (
			known !== undefined &&
			typeof operation === "string" &&
			CONTAINED_FRESH_ARRAY_OPERATIONS.has(operation) &&
			knownBuiltinCallProves(known, operation) &&
			compilerFactIsWorldInvariant(known.identity)
		)
			return true;
	}
	return false;
}

const CONTAINED_PROPERTY_ACCESS_OPCODES = new Set([
	"loadProperty",
	"loadPropertyStatic",
	"storeProperty",
	"storePropertyStatic",
	"defineProperty",
]);

function hasUnannotatedStaticOwnSlotConsumer(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadPropertyStatic" && opcode !== "storePropertyStatic") continue;
		const attributes = fn.instructionAttributes(instruction);
		if (
			typeof attributes.stringIndex === "number" &&
			!coreKnownOwnSlotFromAttribute(attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE])
		)
			return true;
	}
	return false;
}

function hasUnrefinedContainedPropertyConsumer(fn: CoreFunctionStore): boolean {
	let allocation = false;
	let property = false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
		if (descriptor.allocation !== undefined) allocation = true;
		if (
			CONTAINED_PROPERTY_ACCESS_OPCODES.has(fn.instructionOpcodeName(instruction)) &&
			fn.instructionEffectRefinement(instruction) === undefined
		)
			property = true;
		if (allocation && property) return true;
	}
	return false;
}

function hasExactCollectionEffectConsumer(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "callBuiltin" ||
			fn.instructionEffectRefinement(instruction) !== undefined
		)
			continue;
		const operation = fn.instructionAttributes(instruction).operation;
		if (
			typeof operation === "string" &&
			coreCollectionReceiverBrandForOperation(operation) !== undefined
		)
			return true;
	}
	return false;
}

function hasStackCellRepresentationConsumer(fn: CoreFunctionStore): boolean {
	let shapedAllocation = false;
	let scalarCell = false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createObjectShaped") shapedAllocation = true;
		if (opcode === "storePropertyStatic") {
			const value = instructionOperandAt(fn, instruction, 1);
			if (value !== undefined && fn.valueRepresentation(value) === "boxed") {
				scalarCell = true;
			}
		} else if (opcode === "loadPropertyStatic") {
			const result = instructionResultAt(fn, instruction, 0);
			if (result !== undefined && fn.valueRepresentation(result) === "boxed") {
				scalarCell = true;
			}
		}
		if (shapedAllocation && scalarCell) return true;
	}
	return false;
}

function hasAggregateScalarReplacementConsumer(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			fn.kernel.instructionResultCount(instruction) === 1 &&
			effectsPermitRemoval(fn, instruction) &&
			coreMemoryAccesses(fn, instruction).some(
				(access) => access.mode === "read" && coreMemoryLocationIsExact(access.location),
			)
		)
			return true;
		if (CONTAINED_PROPERTY_ACCESS_OPCODES.has(opcode)) {
			const base = instructionOperandAt(fn, instruction, 0);
			if (base !== undefined && mayResolveToAllocation(fn, base)) return true;
		}
	}
	return false;
}

const foldExactAllocationObservations: CoreFunctionPass = {
	name: "fold-exact-allocation-observations",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["unary", "binary"],
	admission: {
		predicate: "fresh allocation and typeof or strict-identity observation",
		hasOpportunity({ program, function: functionId }) {
			return hasExactAllocationObservationOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
		const objectStringIndex = program.stringConstants.findIndex(
			(units) =>
				units.length === 6 &&
				units.every((unit, index) => unit === "object".charCodeAt(index)),
		);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const operator = fn.instructionAttributes(instruction).operator;
			const leftOperand = instructionOperandAt(fn, instruction, 0);
			const rightOperand = instructionOperandAt(fn, instruction, 1);
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
				leftOperand !== undefined &&
				provenance.allocationOf(leftOperand) !== undefined &&
				objectStringIndex >= 0
			) {
				replacement = {
					opcode: "createString",
					attributes: { stringIndex: objectStringIndex },
				};
			} else if (
				opcode === "binary" &&
				(operator === "===" || operator === "!==") &&
				leftOperand !== undefined &&
				rightOperand !== undefined
			) {
				const left = provenance.allocationOf(leftOperand);
				const right = provenance.allocationOf(rightOperand);
				if (left !== undefined && right !== undefined) {
					const same = right.instruction === left.instruction;
					replacement = {
						opcode: "createBoolean",
						attributes: { value: operator === "===" ? same : !same },
					};
				}
			}
			if (replacement === undefined) continue;
			editor ??= CoreEditor.open(program, item.function);
			editor.replaceInstruction(instruction, replacement.opcode, [], {
				attributes: replacement.attributes,
				sourcePosition: fn.instructionSourcePosition(instruction),
			});
		}
		return editor?.commit();
	},
};

const forwardFreshOwnSlotPrefix: CoreFunctionPass = {
	name: "forward-fresh-own-slot-prefix",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createObjectShaped"],
	admission: {
		predicate: "shaped-object allocation followed by a static own-slot load",
		hasOpportunity({ program, function: functionId }) {
			return hasShapedObjectLoadOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
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
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				const aliases: Array<boolean> = [];
				for (let index = 0; index < operandCount; index++) {
					aliases.push(
						provenance.allocationOf(fn.kernel.operandAt(operandStart + index))
							?.instruction === layout.instruction,
					);
				}
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
					const stored = instructionOperandAt(fn, instruction, 1);
					if (stored !== undefined) values.set(stringIndex, stored);
					continue;
				}
				const result = instructionResultAt(fn, instruction, 0);
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

const annotateKnownOwnSlots: CoreFunctionPass = {
	name: "annotate-known-own-slots",
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadPropertyStatic", "storePropertyStatic"],
	admission: {
		predicate: "unannotated static property access with a named slot key",
		hasOpportunity({ program, function: functionId }) {
			return hasUnannotatedStaticOwnSlotConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS],
	wakesOn: ["body", "memoryEffects"],
	changes: { cfg: false, calls: false, facts: false, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const shapes = context.analysis(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "loadPropertyStatic" && opcode !== "storePropertyStatic") continue;
			const attributes = fn.instructionAttributes(instruction);
			if (coreKnownOwnSlotFromAttribute(attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE])) {
				continue;
			}
			const stringIndex = attributes.stringIndex;
			const base = instructionOperandAt(fn, instruction, 0);
			if (typeof stringIndex !== "number" || base === undefined) continue;
			const shape = shapes.candidates(
				base,
				opcode === "loadPropertyStatic" ? "read" : "write",
			);
			if (shape.opaque || shape.origins.length === 0) continue;
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
			if (candidates.length !== shape.origins.length) continue;
			editor ??= CoreEditor.open(program, item.function);
			editor.replaceInstruction(
				instruction,
				opcode,
				materializeInstructionOperands(fn, instruction),
				{
					attributes: {
						...attributes,
						[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: { candidates },
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				},
			);
		}
		return editor?.commit();
	},
};

const refineContainedOwnSlotAccesses: CoreFunctionPass = {
	name: "refine-contained-own-slot-accesses",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: [
		"loadProperty",
		"loadPropertyStatic",
		"storeProperty",
		"storePropertyStatic",
		"defineProperty",
	],
	admission: {
		predicate: "fresh allocation and unrefined property-access consumer",
		hasOpportunity({ program, function: functionId }) {
			return hasUnrefinedContainedPropertyConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [
		CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
		CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
		const shape = context.analysis(CORE_LOCAL_SHAPE_PROVENANCE_ANALYSIS);
		let kinds: CoreValueKindAnalysis | undefined;
		const plans: Array<{
			readonly instruction: CoreInstructionId;
			readonly opcode: string;
			readonly attributes: Readonly<Record<string, CoreAttributeValue>>;
			readonly allocation: CoreInstructionId;
			readonly slot: number;
			readonly named: boolean;
			readonly effects: CoreInstructionEffects;
		}> = [];
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionEffectRefinement(instruction) !== undefined
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const mode =
				opcode === "loadProperty" || opcode === "loadPropertyStatic"
					? "read"
					: opcode === "storeProperty" ||
						  opcode === "storePropertyStatic" ||
						  opcode === "defineProperty"
						? "write"
						: undefined;
			if (mode === undefined) continue;
			const base = instructionOperandAt(fn, instruction, 0);
			if (base === undefined) continue;
			const attributes = fn.instructionAttributes(instruction);
			const stringIndex = attributes.stringIndex;
			const namedExact =
				typeof stringIndex === "number" && Number.isSafeInteger(stringIndex)
					? shape.exactOwnSlot(
							base,
							{ kind: "string-constant", index: stringIndex },
							mode,
						)
					: undefined;
			const indexedLayout = provenance.allocationOf(base);
			const indexedAccess = coreMemoryAccesses(fn, instruction, {
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
					(access.location.kind === "element" ||
						access.location.kind === "object-slot") &&
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
			if (exact === undefined) continue;
			if (mode === "write") {
				kinds ??= context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
				const cannotBeHeldWeakly = (value: CoreValueId): boolean =>
					provenance.cannotBeHeldWeakly(value) || kinds!.exactScalar(value) !== undefined;
				const initial =
					exact.layout.kind === "named-slots"
						? exact.layout.initialValues[exact.slot]
						: exact.layout.elements.get(exact.slot)?.value;
				if (initial === undefined) continue;
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
				if (occupants.some((value) => !cannotBeHeldWeakly(value))) continue;
			}
			plans.push({
				instruction,
				opcode,
				attributes,
				allocation: exact.layout.instruction,
				slot: exact.slot,
				named: namedExact !== undefined,
				effects: exactAccessEffects(mode),
			});
		}
		if (plans.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const plan of plans) {
			const proof = editor.addFact({
				kind: CORE_OWN_DATA_CELL_FACT,
				value: Object.freeze({ allocation: plan.allocation, slot: plan.slot }),
				claims: [
					{ kind: "effect", instruction: plan.instruction, effects: plan.effects },
				],
				validity: {
					kind: "summary",
					digest: `contained-allocation:${plan.allocation}`,
				},
				obligations: [],
				origin: "local-shape-provenance",
			});
			editor.replaceInstruction(
				plan.instruction,
				plan.opcode,
				materializeInstructionOperands(fn, plan.instruction),
				{
					attributes: {
						...plan.attributes,
						...(plan.named ? { [CORE_EXACT_OWN_SLOT_ATTRIBUTE]: plan.slot } : {}),
					},
					sourcePosition: fn.instructionSourcePosition(plan.instruction),
					effectRefinement: { effects: plan.effects, proof },
				},
			);
		}
		return editor.commit();
	},
};

const forwardExactMemoryLoads: CoreFunctionPass = {
	name: "forward-exact-memory-loads",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_MEMORY_ACCESSES,
	admission: {
		predicate:
			"repeated removable read with identical opcode, attributes, operands and representation",
		hasOpportunity({ program, function: functionId }) {
			return hasExactMemoryLoadForwardingOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "memoryEffects"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: MEMORY_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).ordinary();
		const memory = context.analysis(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS);
		const available = new Map<
			number,
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
				const result = instructionResultAt(fn, instruction, 0);
				const readHash = memory.readHash(instruction);
				if (result === undefined || readHash === undefined) continue;
				const prior = (available.get(readHash) ?? []).findLast(
					(candidate) =>
						fn.valueRepresentation(candidate.value) === fn.valueRepresentation(result) &&
						memory.readsEquivalent(candidate.instruction, instruction) &&
						coreInstructionInputsEqual(fn, candidate.instruction, instruction) &&
						(fn.instructionBlock(candidate.instruction) === block ||
							control.instructionDominatesBlock(
								fn.instructionBlock(candidate.instruction),
								block,
							)),
				);
				if (prior !== undefined) {
					const editor = CoreEditor.open(program, item.function);
					editor.replaceValueUses(result, prior.value);
					removeInstructionAndOwnedProof(editor, fn, instruction);
					return editor.commit();
				}
				const candidates = available.get(readHash) ?? [];
				candidates.push({ instruction, value: result });
				available.set(readHash, candidates);
			}
		}
		return undefined;
	},
};

const refineExactCollectionAccesses: CoreFunctionPass = {
	name: "refine-exact-collection-accesses",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callBuiltin"],
	admission: {
		predicate: "unrefined builtin call with a supported collection receiver brand",
		hasOpportunity({ program, function: functionId }) {
			return hasExactCollectionEffectConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const classes = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).valueClasses;
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionEffectRefinement(instruction) !== undefined ||
				fn.instructionOpcodeName(instruction) !== "callBuiltin"
			)
				continue;
			const operation = fn.instructionAttributes(instruction).operation;
			if (typeof operation !== "string") continue;
			const expected = coreCollectionReceiverBrandForOperation(operation);
			const receiver = instructionOperandAt(fn, instruction, 0);
			const exact =
				receiver === undefined
					? undefined
					: classes.containedCollection(receiver, instruction);
			if (exact === undefined || exact !== expected) continue;
			const effects = coreExactCollectionBuiltinEffects(fn, instruction, exact);
			if (effects === undefined) continue;
			editor ??= CoreEditor.open(program, item.function);
			const proof = editor.addFact({
				kind: CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
				value: operation,
				claims: [{ kind: "effect", instruction, effects }],
				validity: {
					kind: "summary",
					digest: `exact-collection-builtin:${operation}`,
				},
				obligations: [],
				origin: "local-value-classes",
			});
			editor.replaceInstruction(
				instruction,
				"callBuiltin",
				materializeInstructionOperands(fn, instruction),
				{
					attributes: {
						...fn.instructionAttributes(instruction),
						[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE]: exact,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: { effects, proof },
				},
			);
		}
		return editor?.commit();
	},
};

const rewriteContainedFreshArrayBuiltins: CoreFunctionPass = {
	name: "rewrite-contained-fresh-array-builtins",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createArray"],
	admission: {
		predicate: "fresh array and proven push or pop call consumer in a locked world",
		hasOpportunity({ program, compilationContext, function: functionId }) {
			return (
				compilationContext.facts.world.primordialPolicy === "locked" &&
				hasContainedFreshArrayBuiltinOpportunity(program.function(functionId))
			);
		},
	},
	requiredAnalyses: [CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "representations"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		if (compilationContext.facts.world.primordialPolicy !== "locked") return undefined;
		const fn = program.function(item.function);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
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
			const callee = instructionOperandAt(fn, call, 0);
			const receiver = instructionOperandAt(fn, call, 1);
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
			if (fn.kernel.valueDefinitionKind(callee) !== 1) continue;
			const property = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
			if (
				fn.instructionKind(property) !== "operation" ||
				fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
				fn.valueUseCount(callee) + fn.kernel.valueHandlerUseCount(callee) !== 1
			)
				continue;
			const layout = provenance.allocationOf(receiver);
			const propertyBase = instructionOperandAt(fn, property, 0);
			if (
				layout?.kind !== "indexed" ||
				propertyBase === undefined ||
				provenance.allocationOf(propertyBase)?.instruction !== layout.instruction
			)
				continue;
			const operandStart = fn.kernel.instructionOperandStart(call);
			const operandCount = fn.kernel.instructionOperandCount(call);
			const forwarded: Array<CoreValueId> = [];
			const forwardedCount =
				exact.forwardedArgumentLimit === undefined
					? operandCount - 2
					: Math.min(operandCount - 2, exact.forwardedArgumentLimit);
			for (let index = 0; index < forwardedCount; index++)
				forwarded.push(fn.kernel.operandAt(operandStart + 2 + index));
			candidates.push({
				call,
				property,
				allocation: layout.instruction,
				receiver,
				forwarded,
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
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				for (let operandIndex = 0; operandIndex < operandCount; operandIndex++) {
					const operand = fn.kernel.operandAt(operandStart + operandIndex);
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
							(() => {
								const key = instructionOperandAt(fn, instruction, 1);
								if (key === undefined) return false;
								const representation = fn.valueRepresentation(key);
								return representation === "f64" || representation === "i32";
							})()) ||
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

function hasShapedObjectStoreOpportunity(fn: CoreFunctionStore): boolean {
	let hasShapedObject = false;
	let hasStaticStore = false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createObjectShaped") hasShapedObject = true;
		else if (opcode === "storePropertyStatic") hasStaticStore = true;
		if (hasShapedObject && hasStaticStore) return true;
	}
	return false;
}

interface RootedScalarAccess {
	readonly instruction: CoreInstructionId;
	readonly block: CoreBlockId;
	readonly index: number;
	readonly key: number;
	readonly value: CoreValueId;
}

function controlValue(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreValueId | undefined {
	switch (fn.instructionKind(instruction)) {
		case "branch":
		case "guard":
		case "switch":
		case "return":
		case "throw":
			return instructionOperandAt(fn, instruction, 0);
		case "jump":
		case "unreachable":
			return undefined;
		case "operation":
			throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
}

function scalarizeRootedLayout(
	program: CoreProgram,
	fn: CoreFunctionStore,
	layout: CoreNamedAllocationLayout,
	provenance: CoreProvenance,
	control: CoreControlFlow,
	aliases: ReadonlySet<CoreValueId>,
	operationUses: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly position: number;
	}>,
	index: CoreLocalFactIndex,
): CoreChangeSet | undefined {
	const allocationBlock = fn.instructionBlock(layout.instruction);
	if (
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		fn.kernel.blockHandlerBlock(allocationBlock) !== undefined ||
		control.loops.some(({ blocks }) => blocks.has(allocationBlock))
	)
		return undefined;
	const allocationInstructions = [...fn.bodyInstructionIds(allocationBlock)];
	const allocationIndex = allocationInstructions.indexOf(layout.instruction);
	if (allocationIndex < 0) return undefined;
	const stores: Array<RootedScalarAccess> = [];
	const loads: Array<RootedScalarAccess> = [];
	let valid = true;
	for (const block of control.reachable) {
		const terminator = fn.blockTerminator(block);
		const observed = controlValue(fn, terminator);
		if (observed !== undefined && aliases.has(observed)) {
			valid = false;
			break;
		}
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
			const edge = edgeStart + edgeOffset;
			const target = fn.kernel.terminatorEdgeBlock(edge);
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
			const parameterStart = fn.kernel.blockParameterStart(target);
			for (let index = 0; index < argumentCount; index++) {
				if (
					aliases.has(fn.kernel.operandAt(argumentStart + index)) &&
					!aliases.has(fn.kernel.blockParameterValue(parameterStart + index))
				) {
					valid = false;
					break;
				}
			}
			if (!valid) break;
		}
		if (!valid) break;
		const handlerBlock = fn.kernel.blockHandlerBlock(block);
		if (handlerBlock !== undefined) {
			const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
			const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
			const parameterStart = fn.kernel.blockParameterStart(handlerBlock);
			for (let index = 0; index < argumentCount; index++) {
				if (
					aliases.has(fn.kernel.handlerArgumentAt(argumentStart + index)) &&
					!aliases.has(fn.kernel.blockParameterValue(parameterStart + 1 + index))
				) {
					valid = false;
					break;
				}
			}
			if (!valid) break;
		}
	}
	if (!valid) return undefined;
	for (const { instruction, position } of operationUses) {
		const location = index.location.get(instruction);
		if (location === undefined || !control.reachable.has(location.block)) continue;
		const opcode = fn.instructionOpcodeName(instruction);
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
			mode === "read"
				? instructionResultAt(fn, instruction, 0)
				: instructionOperandAt(fn, instruction, 1);
		if (
			key === undefined ||
			accessValue === undefined ||
			fn.kernel.blockHandlerBlock(location.block) !== undefined ||
			(location.block === allocationBlock
				? location.index <= allocationIndex
				: !control.instructionDominatesBlock(allocationBlock, location.block))
		) {
			valid = false;
			break;
		}
		(mode === "read" ? loads : stores).push({
			instruction,
			block: location.block,
			index: location.index,
			key,
			value: accessValue,
		});
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
			const handler = fn.kernel.blockHandlerBlock(block);
			return handler === undefined ? [] : [handler];
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
			const values = [
				...new Set(
					[...current.values()].map(resolve).filter(
						(value) =>
							!provenance.cannotBeHeldWeakly(value) &&
							(effects.maySuspend ||
								!(() => {
									const operandStart = fn.kernel.instructionOperandStart(instruction);
									const operandCount = fn.kernel.instructionOperandCount(instruction);
									for (let index = 0; index < operandCount; index++) {
										if (fn.kernel.operandAt(operandStart + index) === value) return true;
									}
									return false;
								})()),
					),
				),
			];
			if (values.length > 0) rootsAfter.set(instruction, values);
		}
		exitFields.set(block, new Map(current));
	}
	for (const block of blocks) {
		const terminator = fn.blockTerminator(block);
		const exit = exitFields.get(block)!;
		const edgeValues = new Map<CoreValueId, Map<CoreRepresentation, CoreValueId>>();
		const edgeValue = (
			value: CoreValueId,
			representation: CoreRepresentation,
		): CoreValueId => {
			if (fn.valueRepresentation(value) === representation) return value;
			if (representation !== "boxed") {
				throw new Error("Virtual object field edge requires an unsupported conversion");
			}
			const representations = edgeValues.get(value);
			const existing = representations?.get(representation);
			if (existing !== undefined) return existing;
			const converted = editor.appendInstruction(block, "move", [value], {
				outputRepresentations: [representation],
			}).outputs[0]!;
			const cached = representations ?? new Map<CoreRepresentation, CoreValueId>();
			cached.set(representation, converted);
			edgeValues.set(value, cached);
			return converted;
		};
		editor.replaceTerminator(
			block,
			replaceTerminatorEdges(fn, terminator, (edge) => {
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
		const handlerBlock = fn.kernel.blockHandlerBlock(block);
		if (handlerBlock !== undefined && fieldParameters.has(handlerBlock)) {
			const entry = entryFields.get(block)!;
			const arguments_: Array<CoreValueId> = [];
			const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
			const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
			for (let index = 0; index < argumentCount; index++)
				arguments_.push(fn.kernel.handlerArgumentAt(argumentStart + index));
			for (const key of layout.keys) arguments_.push(resolve(entry.get(key)!));
			editor.setHandler(block, handlerBlock, arguments_);
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

const scalarizeRootedContainedObjects: CoreFunctionPass = {
	name: "scalarize-rooted-contained-objects",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createObjectShaped"],
	admission: {
		predicate: "shaped-object allocation with a static own-slot store consumer",
		hasOpportunity({ program, function: functionId }) {
			return hasShapedObjectStoreOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const facts = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS);
		const provenance = facts.provenance;
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		for (const layout of provenance.layouts) {
			if (layout.kind !== "named-slots") continue;
			if (provenance.allocationOf(layout.result) !== layout) continue;
			const root = facts.roots.get(layout.result) ?? layout.result;
			const aliases = facts.index.valuesByRoot.get(root);
			if (aliases === undefined) continue;
			const changes = scalarizeRootedLayout(
				program,
				fn,
				layout,
				provenance,
				control,
				new Set(aliases),
				facts.index.uses.get(root) ?? [],
				facts.index,
			);
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

const refineStackObjectCellRepresentations: CoreFunctionPass = {
	name: "refine-stack-object-cell-representations",
	stage: "memory",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_ALLOCATIONS,
	requiredFunctionOpcodesAny: ["createObjectShaped"],
	admission: {
		predicate: "shaped allocation with a boxed static-slot load or store consumer",
		hasOpportunity({ program, function: functionId }) {
			return hasStackCellRepresentationConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [
		CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "facts", "representations", "specializationInputs"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
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
			if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			if (fn.instructionOpcodeName(definition) !== "move") return true;
			const source = instructionOperandAt(fn, definition, 0);
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
			const allocationOperandStart = fn.kernel.instructionOperandStart(
				candidate.allocation,
			);
			const allocationOperandCount = fn.kernel.instructionOperandCount(
				candidate.allocation,
			);
			for (let slot = 0; slot < allocationOperandCount; slot++) {
				if (slot >= contents.length) break;
				const value = fn.kernel.operandAt(allocationOperandStart + slot);
				contents[slot] = joinAggregateCellContent(contents[slot]!, cellContent(value));
			}
			for (const access of candidate.accesses) {
				if (fn.instructionOpcodeName(access.instruction) !== "storePropertyStatic") {
					continue;
				}
				const value = instructionOperandAt(fn, access.instruction, 1);
				if (value === undefined) continue;
				contents[access.slot] = joinAggregateCellContent(
					contents[access.slot]!,
					cellContent(value),
				);
			}
			for (let index = 0; index < allocationOperandCount; index++) {
				const value = fn.kernel.operandAt(allocationOperandStart + index);
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
				const value = instructionOperandAt(fn, access.instruction, 1);
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
				const result = instructionResultAt(fn, access.instruction, 0);
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

const scalarReplaceContainedAggregates: CoreFunctionPass = {
	name: "scalar-replace-contained-aggregates",
	stage: "memory",
	admission: {
		predicate: "removable exact read or fresh allocation with a property consumer",
		hasOpportunity({ program, function: functionId }) {
			return hasAggregateScalarReplacementConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [
		CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
		CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROVENANCE_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const memory = context.analysis(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
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
			if (fn.kernel.instructionResultCount(instruction) !== 1) continue;
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
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
				const value = memory.valueForRead(instruction, access.location);
				if (value === undefined || value === output) continue;
				const sourceRepresentation = fn.valueRepresentation(value);
				const destinationRepresentation = fn.valueRepresentation(output);
				if (sourceRepresentation === destinationRepresentation) {
					replacements.set(instruction, {
						result: output,
						value,
						kind: "eliminate",
					});
				} else if (
					destinationRepresentation === "boxed" &&
					(sourceRepresentation === "f64" ||
						sourceRepresentation === "i32" ||
						sourceRepresentation === "boolean")
				) {
					replacements.set(instruction, { result: output, value, kind: "box" });
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
			const uses = new Map<
				string,
				{ readonly instruction: CoreInstructionId; readonly operand: number }
			>();
			for (const value of fn.valueIds()) {
				if (provenance.allocationOf(value)?.instruction !== layout.instruction) continue;
				let use = fn.kernel.valueFirstUse(value);
				while (use >= 0) {
					const instruction = fn.kernel.useInstruction(use);
					const operand = fn.kernel.useOperand(use);
					uses.set(`${instruction}:${operand}`, { instruction, operand });
					use = fn.kernel.useNext(use);
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
			let hasUses = false;
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				const result = fn.kernel.resultAt(resultStart + index);
				if (fn.valueUseCount(result) + fn.kernel.valueHandlerUseCount(result) !== 0) {
					hasUses = true;
					break;
				}
			}
			if (!hasUses) editor.removeInstruction(instruction);
			else
				editor.replaceInstruction(instruction, "createUndefined", [], {
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
		}
		return editor.commit();
	},
};

export const CORE_PROVENANCE_PASSES: ReadonlyArray<CoreFunctionPass> = [
	foldExactAllocationObservations,
	forwardFreshOwnSlotPrefix,
	annotateKnownOwnSlots,
	refineContainedOwnSlotAccesses,
	rewriteContainedFreshArrayBuiltins,
	refineExactCollectionAccesses,
	refineStackObjectCellRepresentations,
	scalarizeRootedContainedObjects,
	scalarReplaceContainedAggregates,
];

export const CORE_MEMORY_SSA_PASSES: ReadonlyArray<CoreFunctionPass> = [
	forwardExactMemoryLoads,
];

export const CORE_MEMORY_PASSES: ReadonlyArray<CoreFunctionPass> = [
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
