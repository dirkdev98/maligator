import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import { coreValueId } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreFunctionId,
	CoreInstructionId,
	CoreOpcodeAccess,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_OWN_DATA_CELL_FACT = "own-data-cell";
export const CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT = "contained-aggregate-own-slot";
export const CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE = "freshArrayLengthNumber";
export const CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE =
	"containedDenseArrayElementRead";

export type CoreAccessKey =
	| { readonly kind: "string-constant"; readonly index: number }
	| { readonly kind: "operand"; readonly value: CoreValueId };

export type CoreOwnCell =
	| { readonly kind: "object-slot"; readonly key: number }
	| { readonly kind: "element"; readonly index: number };

interface CoreAllocationLayoutBase {
	readonly instruction: CoreInstructionId;
	readonly result: CoreValueId;
	readonly kind: "named-slots" | "indexed";
}

export interface CoreNamedAllocationLayout extends CoreAllocationLayoutBase {
	readonly kind: "named-slots";
	readonly keys: ReadonlyArray<number>;
	readonly initialValues: ReadonlyArray<CoreValueId>;
}

export interface CoreArrayElementLayout {
	readonly index: number;
	readonly value: CoreValueId;
	readonly definition: CoreInstructionId;
}

export interface CoreIndexedAllocationLayout extends CoreAllocationLayoutBase {
	readonly kind: "indexed";
	readonly length: number;
	readonly elements: ReadonlyMap<number, CoreArrayElementLayout>;
}

export type CoreAllocationLayout =
	| CoreNamedAllocationLayout
	| CoreIndexedAllocationLayout;

export type CoreAllocationEscape = "contained" | "escaped";

export interface CoreProvenance {
	readonly function: CoreFunctionId;
	readonly layouts: ReadonlyArray<CoreAllocationLayout>;
	readonly statistics: {
		readonly allocations: number;
		readonly contained: number;
		readonly escaped: number;
		readonly valueQueries: number;
	};
	allocationOf(value: CoreValueId): CoreAllocationLayout | undefined;
	escape(allocation: CoreInstructionId): CoreAllocationEscape;
	ownCell(
		base: CoreValueId,
		key: CoreAccessKey,
		mode: CoreAccessMode,
	): { readonly layout: CoreAllocationLayout; readonly cell: CoreOwnCell } | undefined;
	cannotBeHeldWeakly(value: CoreValueId): boolean;
}

export interface CoreContainedAggregateOwnSlot {
	readonly slot: number;
	readonly origins: ReadonlyArray<CoreInstructionId>;
}

export interface CoreContainedAggregateProvenance {
	ownSlot(instruction: CoreInstructionId): CoreContainedAggregateOwnSlot | undefined;
	isInBounds(instruction: CoreInstructionId): boolean;
}

export interface CoreProvenanceOptions {
	readonly canonicalRoots?: ReadonlyMap<CoreValueId, CoreValueId>;
}

function numberArray(value: unknown): ReadonlyArray<number> | undefined {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry))
		? value
		: undefined;
}

function canonicalArrayIndex(
	units: ReadonlyArray<number> | undefined,
): number | undefined {
	if (units === undefined || units.length === 0) return undefined;
	if (units.length > 1 && units[0] === 0x30) return undefined;
	let value = 0;
	for (const unit of units) {
		if (unit < 0x30 || unit > 0x39) return undefined;
		value = value * 10 + unit - 0x30;
		if (value > 0xffff_ffff) return undefined;
	}
	return value === 0xffff_ffff ? undefined : value;
}

export function coreOwnCellsEqual(left: CoreOwnCell, right: CoreOwnCell): boolean {
	return left.kind === right.kind &&
		(left.kind === "element"
			? left.index === (right as { readonly kind: "element"; readonly index: number }).index
			: left.key === (right as { readonly kind: "object-slot"; readonly key: number }).key);
}

export function coreOwnCellResolver(
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): (index: number) => CoreOwnCell | undefined {
	const canonicalBySpelling = new Map<string, number>();
	const canonicalByIndex = new Int32Array(stringConstants.length);
	canonicalByIndex.fill(-1);
	for (const [index, units] of stringConstants.entries()) {
		const spelling = units.join(",");
		const canonical = canonicalBySpelling.get(spelling) ?? index;
		canonicalBySpelling.set(spelling, canonical);
		canonicalByIndex[index] = canonical;
	}
	return (index): CoreOwnCell | undefined => {
		if (!Number.isSafeInteger(index) || index < 0) return undefined;
		const canonical = canonicalByIndex[index] ?? -1;
		const normalized = canonical < 0 ? index : canonical;
		const element = canonicalArrayIndex(stringConstants[normalized]);
		return element === undefined
			? { kind: "object-slot", key: normalized }
			: { kind: "element", index: element };
	};
}

function accessKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	access: CoreOpcodeAccess,
): CoreAccessKey | undefined {
	const attributes = fn.instructionAttributes(instruction);
	if (access.keyAttribute !== undefined) {
		const index = attributes[access.keyAttribute];
		return typeof index === "number" && Number.isSafeInteger(index)
			? { kind: "string-constant", index }
			: undefined;
	}
	if (access.keyOperand !== undefined) {
		const value = fn.instructionOperands(instruction)[access.keyOperand];
		return value === undefined ? undefined : { kind: "operand", value };
	}
	return undefined;
}

function allocationLayout(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreAllocationLayout | undefined {
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	const allocation = descriptor.allocation;
	const result = fn.instructionResults(instruction)[0];
	if (allocation === undefined || result === undefined) return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (allocation.kind === "indexed") {
		const length = attributes[allocation.lengthAttribute];
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
			return undefined;
		}
		return Object.freeze({
			kind: "indexed",
			instruction,
			result,
			length,
			elements: new Map<number, CoreArrayElementLayout>(),
		});
	}
	const keys = numberArray(attributes[allocation.keysAttribute]);
	if (keys === undefined || new Set(keys).size !== keys.length) return undefined;
	const values = fn.instructionOperands(instruction).slice(allocation.firstValueOperand);
	if (values.length !== keys.length) return undefined;
	return Object.freeze({
		kind: "named-slots",
		instruction,
		result,
		keys: Object.freeze([...keys]),
		initialValues: Object.freeze(values),
	});
}

function observesWithoutRetention(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	if (descriptor.observesOperands === true) return true;
	const operator = fn.instructionAttributes(instruction).operator;
	return (descriptor.opcode === "binary" && (operator === "===" || operator === "!==")) ||
		(descriptor.opcode === "unary" && operator === "typeof");
}

function isLengthCell(
	cell: CoreOwnCell,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
	if (cell.kind !== "object-slot") return false;
	const units = stringConstants[cell.key];
	const length = [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68];
	return units?.length === length.length && units.every((unit, index) => unit === length[index]);
}

function baseAccessForOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): CoreOpcodeAccess | undefined {
	let matched: CoreOpcodeAccess | undefined;
	for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ?? []) {
		if (access.baseOperand !== operand ||
			!CORE_MEMORY_FAMILY_DOMAINS[access.family].includes("object-property")) continue;
		if (matched !== undefined &&
			(matched.family !== access.family || matched.mode !== access.mode ||
				matched.keyAttribute !== access.keyAttribute || matched.keyOperand !== access.keyOperand)) {
			return undefined;
		}
		matched = access;
	}
	return matched;
}

function provenance(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	options: CoreProvenanceOptions = {},
): CoreProvenance {
	const roots = options.canonicalRoots ?? coreCanonicalValueRoots(fn, cfg);
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const layouts = [...fn.instructionIds()]
		.filter((instruction) => fn.instructionKind(instruction) === "operation")
		.map((instruction) => allocationLayout(fn, instruction))
		.filter((layout): layout is CoreAllocationLayout => layout !== undefined);
	const layoutByRoot = new Array<CoreAllocationLayout | null | undefined>(fn.valueCapacity);
	for (const layout of layouts) {
		const valueRoot = root(layout.result);
		layoutByRoot[valueRoot] = layoutByRoot[valueRoot] === undefined
			? layout
			: null;
	}
	let valueQueries = 0;
	const allocationOf = (value: CoreValueId): CoreAllocationLayout | undefined => {
		valueQueries++;
		return layoutByRoot[root(value)] ?? undefined;
	};
	const cellForString = coreOwnCellResolver(program.stringConstants);
	const keyCells = new Array<CoreOwnCell | null | undefined>(fn.valueCapacity);
	const cellForValue = (value: CoreValueId): CoreOwnCell | undefined => {
		const valueRoot = root(value);
		const cached = keyCells[valueRoot];
		if (cached !== undefined) return cached ?? undefined;
		const definition = fn.valueDefinition(valueRoot);
		if (definition.kind !== "instruction" || fn.instructionKind(definition.instruction) !== "operation") {
			keyCells[valueRoot] = null;
			return undefined;
		}
		const opcode = fn.instructionOpcodeName(definition.instruction);
		const immediate = fn.instructionAttributes(definition.instruction);
		let cell: CoreOwnCell | undefined;
		if (opcode === "createString" && typeof immediate.stringIndex === "number") {
			cell = cellForString(immediate.stringIndex);
		} else if ((opcode === "createNumber" || opcode === "createF64") &&
			typeof immediate.value === "number" && Number.isInteger(immediate.value) &&
			immediate.value >= 0 && immediate.value <= 0xffff_fffe) {
			cell = { kind: "element", index: Object.is(immediate.value, -0) ? 0 : immediate.value };
		}
		keyCells[valueRoot] = cell ?? null;
		return cell;
	};
	const cellForKey = (key: CoreAccessKey): CoreOwnCell | undefined =>
		key.kind === "string-constant" ? cellForString(key.index) : cellForValue(key.value);
	const cellBelongs = (
		layout: CoreAllocationLayout,
		cell: CoreOwnCell,
		mode: CoreAccessMode,
	): boolean => layout.kind === "named-slots"
		? cell.kind === "object-slot" && layout.keys.includes(cell.key)
		: isLengthCell(cell, program.stringConstants) && mode === "read";

	const escaped = new Uint8Array(fn.instructionCapacity);
	for (let valueIndex = 0; valueIndex < fn.valueCapacity; valueIndex++) {
		const value = coreValueId(valueIndex);
		if (!fn.isValueLive(value)) continue;
		const layout = allocationOf(value);
		if (layout === undefined) continue;
		for (const use of fn.uses(value)) {
			if (fn.instructionKind(use.instruction) !== "operation") {
				escaped[layout.instruction] = 1;
				continue;
			}
			const opcode = fn.instructionOpcodeName(use.instruction);
			if (opcode === "move" || opcode === "rootUse" || observesWithoutRetention(fn, use.instruction)) {
				continue;
			}
			const access = baseAccessForOperand(fn, use.instruction, use.operand);
			const key = access === undefined ? undefined : accessKey(fn, use.instruction, access);
			const cell = key === undefined ? undefined : cellForKey(key);
			if (access === undefined || cell === undefined || !cellBelongs(layout, cell, access.mode)) {
				escaped[layout.instruction] = 1;
			}
		}
	}
	const escape = (allocation: CoreInstructionId): CoreAllocationEscape =>
		escaped[allocation] === 0 ? "contained" : "escaped";
	const ownCell = (
		base: CoreValueId,
		key: CoreAccessKey,
		mode: CoreAccessMode,
	): { readonly layout: CoreAllocationLayout; readonly cell: CoreOwnCell } | undefined => {
		const layout = allocationOf(base);
		const cell = cellForKey(key);
		return layout !== undefined && cell !== undefined && escape(layout.instruction) === "contained" &&
			cellBelongs(layout, cell, mode)
			? { layout, cell }
			: undefined;
	};
	const cannotBeHeldWeakly = (value: CoreValueId): boolean => {
		if (fn.valueRepresentation(value) !== "boxed") return true;
		const definition = fn.valueDefinition(root(value));
		return definition.kind === "instruction" &&
			fn.instructionKind(definition.instruction) === "operation" &&
			fn.registry.byId(fn.instructionOpcode(definition.instruction)).resultCannotBeHeldWeakly === true;
	};
	const contained = layouts.filter((layout) => escape(layout.instruction) === "contained").length;
	const result: CoreProvenance = {
		function: fn.id,
		layouts: Object.freeze(layouts),
		statistics: {
			allocations: layouts.length,
			contained,
			escaped: layouts.length - contained,
			get valueQueries() { return valueQueries; },
		},
		allocationOf,
		escape,
		ownCell,
		cannotBeHeldWeakly,
	};
	return Object.freeze(result);
}

export function analyzeCoreProvenance(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: CoreProvenanceOptions = {},
): CoreProvenance {
	const fn = program.function(functionId);
	return provenance(program, fn, buildCoreControlFlow(program, functionId), options);
}

export const coreProvenance = analyzeCoreProvenance;

export const CORE_LOCAL_PROVENANCE_ANALYSIS: CoreAnalysisDefinition<CoreProvenance> = {
	key: "local-provenance",
	scope: "function",
	functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	programDependencies: ["data"],
	compute({ program, request }) {
		if (request.scope !== "function") throw new Error("Expected function analysis request");
		return analyzeCoreProvenance(program, request.function);
	},
};

export function coreContainedAggregateProvenance(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreContainedAggregateProvenance {
	const fn = program.function(functionId);
	const analysis = analyzeCoreProvenance(program, functionId);
	const result: CoreContainedAggregateProvenance = {
		ownSlot(instruction) {
			if (!fn.isInstructionLive(instruction) || fn.instructionKind(instruction) !== "operation") return undefined;
			const operands = fn.instructionOperands(instruction);
			for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ?? []) {
				if (access.baseOperand === undefined) continue;
				const base = operands[access.baseOperand];
				const key = accessKey(fn, instruction, access);
				if (base === undefined || key === undefined) continue;
				const resolved = analysis.ownCell(base, key, access.mode);
				if (resolved?.layout.kind !== "named-slots" || resolved.cell.kind !== "object-slot") continue;
				const slot = resolved.layout.keys.indexOf(resolved.cell.key);
				if (slot >= 0) return Object.freeze({ slot, origins: Object.freeze([resolved.layout.instruction]) });
			}
			return undefined;
		},
		isInBounds: () => false,
	};
	return Object.freeze(result);
}

export type CoreLocalSpecializationCandidateKind =
	| "stack-object"
	| "dense-array"
	| "numeric-fusion";

export interface CoreLocalSpecializationCandidate {
	readonly key: string;
	readonly kind: CoreLocalSpecializationCandidateKind;
	readonly function: CoreFunctionId;
	readonly root: CoreInstructionId;
	readonly allocation?: CoreInstructionId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly fanOut: number;
}

export interface CoreLocalSpecializationCandidates {
	readonly candidates: ReadonlyArray<CoreLocalSpecializationCandidate>;
	readonly largestFanOut: number;
}

function discoverCandidates(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreLocalSpecializationCandidates {
	const fn = program.function(functionId);
	const provenanceAnalysis = analyzeCoreProvenance(program, functionId);
	const candidates = new Map<string, CoreLocalSpecializationCandidate>();
	const add = (
		kind: CoreLocalSpecializationCandidateKind,
		root: CoreInstructionId,
		instructions: ReadonlyArray<CoreInstructionId>,
		allocation?: CoreInstructionId,
	): void => {
		const key = `${kind}:${functionId}:${root}`;
		if (candidates.has(key)) return;
		const stableInstructions = Object.freeze([...new Set(instructions)].sort((left, right) => left - right));
		candidates.set(key, Object.freeze({
			key,
			kind,
			function: functionId,
			root,
			...(allocation === undefined ? {} : { allocation }),
			instructions: stableInstructions,
			fanOut: Math.max(0, stableInstructions.length - 1),
		}));
	};
	for (const layout of provenanceAnalysis.layouts) {
		if (provenanceAnalysis.escape(layout.instruction) !== "contained") continue;
		const uses = [...fn.uses(layout.result)].map(({ instruction }) => instruction);
		add(layout.kind === "named-slots" ? "stack-object" : "dense-array", layout.instruction, [layout.instruction, ...uses], layout.instruction);
	}
	const numericOpcodes = new Set(["binary", "unary", "mathBinaryNumber", "mathUnaryNumber"]);
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation" ||
			!numericOpcodes.has(fn.instructionOpcodeName(instruction))) continue;
		const output = fn.instructionResults(instruction)[0];
		if (output === undefined || !["i32", "f64"].includes(fn.valueRepresentation(output))) continue;
		const users = [...fn.uses(output)]
			.map(({ instruction: user }) => user)
			.filter((user) => fn.instructionKind(user) === "operation" && numericOpcodes.has(fn.instructionOpcodeName(user)));
		if (users.length > 0) add("numeric-fusion", instruction, [instruction, ...users]);
	}
	const values = Object.freeze([...candidates.values()]);
	return Object.freeze({
		candidates: values,
		largestFanOut: values.reduce((largest, candidate) => Math.max(largest, candidate.fanOut), 0),
	});
}

export function discoverCoreLocalSpecializationCandidates(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreLocalSpecializationCandidates {
	return discoverCandidates(program, functionId);
}

export const CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS: CoreAnalysisDefinition<CoreLocalSpecializationCandidates> = {
	key: "local-specialization-candidates",
	scope: "function",
	functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations", "specializationInputs"],
	programDependencies: ["data"],
	compute({ program, request }) {
		if (request.scope !== "function") throw new Error("Expected function analysis request");
		return discoverCandidates(program, request.function);
	},
};
