import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	analyzeCoreLoopInductions,
	CORE_LOOP_INDUCTION_ANALYSIS,
} from "./core-ir-loops.ts";
import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import { coreTargetSupportsNumericFusionOperator } from "./core-ir-region-strategies.ts";
import type {
	CoreCollectionBuiltinOperation,
	CorePlanIteratorCursorKind,
	CorePlanIteratorCursorProtocol,
} from "./core-ir-regions.ts";
import type { CoreExactCollectionBrand } from "./core-ir-value-classes.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreFunctionId, coreValueId } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreBlockId,
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

function literalArrayIndex(
	fn: CoreFunctionStore,
	value: CoreValueId,
): number | undefined {
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const immediate = fn.instructionAttributes(definition.instruction).value;
	return (opcode === "createNumber" || opcode === "createF64") &&
		typeof immediate === "number" &&
		Number.isInteger(immediate) &&
		immediate >= 0 &&
		immediate <= 0xffff_fffe
		? Object.is(immediate, -0)
			? 0
			: immediate
		: undefined;
}

export function coreOwnCellsEqual(left: CoreOwnCell, right: CoreOwnCell): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "element"
			? left.index ===
				(right as { readonly kind: "element"; readonly index: number }).index
			: left.key ===
				(right as { readonly kind: "object-slot"; readonly key: number }).key)
	);
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
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > 0xffff_ffff
		) {
			return undefined;
		}
		const elements = new Map<number, CoreArrayElementLayout>();
		const block = fn.instructionBlock(instruction);
		for (
			let candidate = fn.instructionNext(instruction);
			candidate !== undefined && fn.instructionBlock(candidate) === block;
			candidate = fn.instructionNext(candidate)
		) {
			if (fn.instructionKind(candidate) !== "operation") break;
			const operands = fn.instructionOperands(candidate);
			const baseUses = operands.flatMap((operand, operandIndex) =>
				operand === result ? [operandIndex] : [],
			);
			if (baseUses.length === 0) continue;
			const opcode = fn.instructionOpcodeName(candidate);
			if (opcode === "throwIfTdz" && baseUses.length === 1 && baseUses[0] === 0) continue;
			if (opcode !== "defineProperty" || baseUses.length !== 1 || baseUses[0] !== 0)
				break;
			const index =
				operands[1] === undefined ? undefined : literalArrayIndex(fn, operands[1]);
			const value = operands[2];
			if (index === undefined || index >= length || value === undefined) break;
			if (!elements.has(index)) {
				elements.set(index, { index, value, definition: candidate });
			}
		}
		return Object.freeze({
			kind: "indexed",
			instruction,
			result,
			length,
			elements,
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
	return (
		(descriptor.opcode === "binary" && (operator === "===" || operator === "!==")) ||
		(descriptor.opcode === "unary" && operator === "typeof")
	);
}

function isLengthCell(
	cell: CoreOwnCell,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
	if (cell.kind !== "object-slot") return false;
	const units = stringConstants[cell.key];
	const length = [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68];
	return (
		units?.length === length.length &&
		units.every((unit, index) => unit === length[index])
	);
}

function baseAccessForOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): CoreOpcodeAccess | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		![
			"defineProperty",
			"loadProperty",
			"loadPropertyStatic",
			"loadPropertyStaticShapeCase",
			"storeProperty",
			"storePropertyStatic",
		].includes(opcode)
	)
		return undefined;
	let matched: CoreOpcodeAccess | undefined;
	for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ??
		[]) {
		if (access.baseOperand !== operand || access.family !== "object-slot") continue;
		if (
			matched !== undefined &&
			(matched.family !== access.family ||
				matched.mode !== access.mode ||
				matched.keyAttribute !== access.keyAttribute ||
				matched.keyOperand !== access.keyOperand)
		) {
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
	const layoutByRoot = new Array<CoreAllocationLayout | null | undefined>(
		fn.valueCapacity,
	);
	for (const layout of layouts) {
		const valueRoot = root(layout.result);
		layoutByRoot[valueRoot] = layoutByRoot[valueRoot] === undefined ? layout : null;
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
		if (
			definition.kind !== "instruction" ||
			fn.instructionKind(definition.instruction) !== "operation"
		) {
			keyCells[valueRoot] = null;
			return undefined;
		}
		const opcode = fn.instructionOpcodeName(definition.instruction);
		const immediate = fn.instructionAttributes(definition.instruction);
		let cell: CoreOwnCell | undefined;
		if (opcode === "createString" && typeof immediate.stringIndex === "number") {
			cell = cellForString(immediate.stringIndex);
		} else if (
			(opcode === "createNumber" || opcode === "createF64") &&
			typeof immediate.value === "number" &&
			Number.isInteger(immediate.value) &&
			immediate.value >= 0 &&
			immediate.value <= 0xffff_fffe
		) {
			cell = {
				kind: "element",
				index: Object.is(immediate.value, -0) ? 0 : immediate.value,
			};
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
	): boolean =>
		layout.kind === "named-slots"
			? cell.kind === "object-slot" && layout.keys.includes(cell.key)
			: (isLengthCell(cell, program.stringConstants) && mode === "read") ||
				(cell.kind === "element" && layout.elements.has(cell.index));

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
			if (
				opcode === "move" ||
				opcode === "throwIfTdz" ||
				opcode === "rootUse" ||
				observesWithoutRetention(fn, use.instruction)
			) {
				continue;
			}
			const access = baseAccessForOperand(fn, use.instruction, use.operand);
			const key =
				access === undefined ? undefined : accessKey(fn, use.instruction, access);
			const cell = key === undefined ? undefined : cellForKey(key);
			if (
				access === undefined ||
				cell === undefined ||
				!cellBelongs(layout, cell, access.mode)
			) {
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
	):
		| { readonly layout: CoreAllocationLayout; readonly cell: CoreOwnCell }
		| undefined => {
		const layout = allocationOf(base);
		const cell = cellForKey(key);
		return layout !== undefined &&
			cell !== undefined &&
			escape(layout.instruction) === "contained" &&
			cellBelongs(layout, cell, mode)
			? { layout, cell }
			: undefined;
	};
	const cannotBeHeldWeakly = (value: CoreValueId): boolean => {
		if (fn.valueRepresentation(value) !== "boxed") return true;
		const definition = fn.valueDefinition(root(value));
		return (
			definition.kind === "instruction" &&
			fn.instructionKind(definition.instruction) === "operation" &&
			fn.registry.byId(fn.instructionOpcode(definition.instruction))
				.resultCannotBeHeldWeakly === true
		);
	};
	const contained = layouts.filter(
		(layout) => escape(layout.instruction) === "contained",
	).length;
	const result: CoreProvenance = {
		function: fn.id,
		layouts: Object.freeze(layouts),
		statistics: {
			allocations: layouts.length,
			contained,
			escaped: layouts.length - contained,
			get valueQueries() {
				return valueQueries;
			},
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
	functionDependencies: [
		"body",
		"cfg",
		"exceptionFlow",
		"memoryEffects",
		"representations",
	],
	programDependencies: ["data"],
	compute({ program, request, get }) {
		if (request.scope !== "function")
			throw new Error("Expected function analysis request");
		return provenance(
			program,
			program.function(request.function),
			get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request),
		);
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
			if (
				!fn.isInstructionLive(instruction) ||
				fn.instructionKind(instruction) !== "operation"
			)
				return undefined;
			const operands = fn.instructionOperands(instruction);
			for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ??
				[]) {
				if (access.baseOperand === undefined) continue;
				const base = operands[access.baseOperand];
				const key = accessKey(fn, instruction, access);
				if (base === undefined || key === undefined) continue;
				const resolved = analysis.ownCell(base, key, access.mode);
				if (
					resolved?.layout.kind !== "named-slots" ||
					resolved.cell.kind !== "object-slot"
				)
					continue;
				const slot = resolved.layout.keys.indexOf(resolved.cell.key);
				if (slot >= 0)
					return Object.freeze({
						slot,
						origins: Object.freeze([resolved.layout.instruction]),
					});
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
	| "numeric-fusion"
	| "string-split-projection"
	| "string-slice-number"
	| "regexp-exec-projection"
	| "regexp-iterator-projection"
	| "string-char-code-at-chain"
	| "builtin-collection-call-chain"
	| CorePlanIteratorCursorKind
	| "iterator-result-virtualization"
	| "iterator-entry-pair-virtualization"
	| "fresh-array-length"
	| "indexed-length-loop"
	| "function-call-chain"
	| "string-split-cursor";

interface CoreLocalSpecializationCandidateBase<
	Kind extends CoreLocalSpecializationCandidateKind,
> {
	readonly key: string;
	readonly kind: Kind;
	readonly function: CoreFunctionId;
	readonly root: CoreInstructionId;
	readonly allocation?: CoreInstructionId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly fanOut: number;
}

export interface CoreStackObjectCandidate extends CoreLocalSpecializationCandidateBase<"stack-object"> {
	readonly allocation: CoreInstructionId;
	readonly mode: "elided" | "activation-local";
	readonly slotCount: number;
	readonly accesses: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly slot: number;
	}>;
	readonly materializations: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly kind: "return";
	}>;
}

export interface CoreContainedDenseArrayCandidate extends CoreLocalSpecializationCandidateBase<"dense-array"> {
	readonly mode: "contained";
	readonly allocation: CoreInstructionId;
}

export interface CoreFreshDenseArrayCandidate extends CoreLocalSpecializationCandidateBase<"dense-array"> {
	readonly mode: "fresh-indexed-fill";
	readonly allocation: CoreInstructionId;
	readonly store: CoreInstructionId;
	readonly loopHeader: CoreBlockId;
	readonly length: number;
}

export type CoreDenseArrayCandidate =
	| CoreContainedDenseArrayCandidate
	| CoreFreshDenseArrayCandidate;

export interface CoreStringSplitProjectionCandidate extends CoreLocalSpecializationCandidateBase<"string-split-projection"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly separator: CoreInstructionId;
	readonly separatorStringIndex: number;
	readonly resultValues: ReadonlyArray<CoreValueId>;
	readonly loads: ReadonlyArray<
		| {
				readonly instruction: CoreInstructionId;
				readonly kind: "element";
				readonly index: number;
				readonly key: CoreInstructionId;
		  }
		| {
				readonly instruction: CoreInstructionId;
				readonly kind: "length";
		  }
	>;
}

export interface CoreStringSliceNumberCandidate extends CoreLocalSpecializationCandidateBase<"string-slice-number"> {
	readonly property: CoreInstructionId;
	readonly sliceCall: CoreInstructionId;
	readonly sliceStartInstruction: CoreInstructionId;
	readonly numberIntrinsic: CoreInstructionId;
	readonly numberCall: CoreInstructionId;
	readonly sliceStart: number;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreRegExpExecProjectionCandidate extends CoreLocalSpecializationCandidateBase<"regexp-exec-projection"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly resultValues: ReadonlyArray<CoreValueId>;
	readonly nullChecks: ReadonlyArray<{
		readonly comparison: CoreInstructionId;
		readonly nullValue: CoreInstructionId;
	}>;
	readonly lockedLiteral?: {
		readonly constructorIntrinsic: CoreInstructionId;
		readonly construct: CoreInstructionId;
	};
	readonly loads: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly key: CoreInstructionId;
		readonly captureIndex: number;
		readonly consumer?:
			| { readonly kind: "length"; readonly property: CoreInstructionId }
			| {
					readonly kind: "charCodeAtZero";
					readonly property: CoreInstructionId;
					readonly call: CoreInstructionId;
					readonly zero?: CoreInstructionId;
			  }
			| {
					readonly kind: "number";
					readonly intrinsic: CoreInstructionId;
					readonly call: CoreInstructionId;
			  }
			| {
					readonly kind: "asciiCaseLength";
					readonly upperProperty: CoreInstructionId;
					readonly upperCall: CoreInstructionId;
					readonly lowerProperty: CoreInstructionId;
					readonly lowerCall: CoreInstructionId;
					readonly resultMoves: ReadonlyArray<CoreInstructionId>;
					readonly lengthProperty: CoreInstructionId;
			  };
	}>;
}

export interface CoreRegExpIteratorProjectionCandidate extends CoreLocalSpecializationCandidateBase<"regexp-iterator-projection"> {
	readonly step: CoreInstructionId;
	readonly doneBranch: CoreInstructionId;
	readonly exitBlock: CoreBlockId;
	readonly resultValues: ReadonlyArray<CoreValueId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
	readonly loads: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly key: CoreInstructionId;
		readonly captureIndex: number;
		readonly numberIntrinsic: CoreInstructionId;
		readonly numberCall: CoreInstructionId;
	}>;
}

export interface CoreStringCharCodeAtCandidate extends CoreLocalSpecializationCandidateBase<"string-char-code-at-chain"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly bounded?: {
		readonly length: CoreInstructionId;
		readonly comparison: CoreInstructionId;
		readonly update: CoreInstructionId;
	};
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreBuiltinCollectionCallCandidate extends CoreLocalSpecializationCandidateBase<"builtin-collection-call-chain"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly operation: CoreCollectionBuiltinOperation;
	readonly exactReceiver?: CoreExactCollectionBrand;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreIteratorCursorCandidate extends CoreLocalSpecializationCandidateBase<CorePlanIteratorCursorKind> {
	readonly initialize: CoreInstructionId;
	readonly steps: ReadonlyArray<CoreInstructionId>;
	readonly protocol: CorePlanIteratorCursorProtocol;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreIteratorResultVirtualizationCandidate extends CoreLocalSpecializationCandidateBase<"iterator-result-virtualization"> {
	readonly steps: ReadonlyArray<CoreInstructionId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreIteratorEntryPairVirtualizationCandidate extends CoreLocalSpecializationCandidateBase<"iterator-entry-pair-virtualization"> {
	readonly cursorInitialize: CoreInstructionId;
	readonly outerStep: CoreInstructionId;
	readonly innerInitialize: CoreInstructionId;
	readonly innerSteps: readonly [CoreInstructionId, CoreInstructionId];
	readonly innerCloses: ReadonlyArray<CoreInstructionId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreFreshArrayLengthCandidate extends CoreLocalSpecializationCandidateBase<"fresh-array-length"> {
	readonly allocation: CoreInstructionId;
	readonly load: CoreInstructionId;
	readonly length: number;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreIndexedLengthLoopCandidate extends CoreLocalSpecializationCandidateBase<"indexed-length-loop"> {
	readonly load: CoreInstructionId;
	readonly comparison: CoreInstructionId;
	readonly lengthPosition: 1 | 2;
	readonly elements: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly kind: "load" | "store";
	}>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreFunctionCallChainCandidate extends CoreLocalSpecializationCandidateBase<"function-call-chain"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly targetFunction?: CoreFunctionId;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export interface CoreStringSplitCursorCandidate extends CoreLocalSpecializationCandidateBase<"string-split-cursor"> {
	readonly property: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly length: CoreInstructionId;
	readonly compare: CoreInstructionId;
	readonly branch: CoreInstructionId;
	readonly element: CoreInstructionId;
	readonly trimProperty: CoreInstructionId;
	readonly trimCall: CoreInstructionId;
	readonly advance?: CoreInstructionId;
	readonly increment: CoreInstructionId;
	readonly backedge: CoreInstructionId;
	readonly resultValues: ReadonlyArray<CoreValueId>;
	readonly primitiveStringLengths: ReadonlyArray<CoreInstructionId>;
	readonly exitBlock: CoreBlockId;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

export type CoreLocalSpecializationCandidate =
	| CoreLocalSpecializationCandidateBase<"numeric-fusion">
	| CoreStackObjectCandidate
	| CoreDenseArrayCandidate
	| CoreStringSplitProjectionCandidate
	| CoreStringSliceNumberCandidate
	| CoreRegExpExecProjectionCandidate
	| CoreRegExpIteratorProjectionCandidate
	| CoreStringCharCodeAtCandidate
	| CoreBuiltinCollectionCallCandidate
	| CoreIteratorCursorCandidate
	| CoreIteratorResultVirtualizationCandidate
	| CoreIteratorEntryPairVirtualizationCandidate
	| CoreFreshArrayLengthCandidate
	| CoreIndexedLengthLoopCandidate
	| CoreFunctionCallChainCandidate
	| CoreStringSplitCursorCandidate;

export interface CoreLocalSpecializationCandidates {
	readonly candidates: ReadonlyArray<CoreLocalSpecializationCandidate>;
	readonly largestFanOut: number;
}

const MAX_FRESH_DENSE_INDEXED_RESERVE = 65_536;
const FRESH_DENSE_NUMERIC_OPERATORS: ReadonlySet<string> = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function stackObjectCandidate(
	fn: CoreFunctionStore,
	layout: CoreNamedAllocationLayout,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreStackObjectCandidate | undefined {
	if (
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		!control.reachable.has(fn.instructionBlock(layout.instruction))
	)
		return undefined;
	const allocationRoot = roots.get(layout.result) ?? layout.result;
	const aliasesAllocation = (value: CoreValueId): boolean =>
		(roots.get(value) ?? value) === allocationRoot;
	for (const block of control.reachable) {
		if (fn.blockHandler(block)?.arguments.some(aliasesAllocation) === true) {
			return undefined;
		}
		const incoming = control.predecessors[block] ?? [];
		for (const [index, parameter] of fn.blockParameters(block).entries()) {
			if (aliasesAllocation(parameter.value)) continue;
			if (
				incoming.some((edge) => {
					const argument =
						edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
					return argument !== undefined && aliasesAllocation(argument);
				})
			) {
				return undefined;
			}
		}
	}

	const slotByStringIndex = new Map(
		layout.keys.map((stringIndex, slot) => [stringIndex, slot] as const),
	);
	const accesses = new Map<
		CoreInstructionId,
		{ readonly instruction: CoreInstructionId; readonly slot: number }
	>();
	let requiresObjectIdentity = false;
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			!control.reachable.has(fn.instructionBlock(instruction))
		)
			continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operator = fn.instructionAttributes(instruction).operator;
		for (const [position, operand] of fn.instructionOperands(instruction).entries()) {
			if (!aliasesAllocation(operand)) continue;
			if (
				(opcode === "move" && position === 0) ||
				(opcode === "throwIfTdz" && position === 0) ||
				opcode === "rootUse"
			) {
				continue;
			}
			if (
				(opcode === "binary" && (operator === "===" || operator === "!==")) ||
				((opcode === "loadPrototype" || opcode === "typeofCompare") && position === 0) ||
				(opcode === "unary" && operator === "typeof" && position === 0)
			) {
				requiresObjectIdentity = true;
				continue;
			}
			if (
				(opcode === "loadPropertyStatic" || opcode === "storePropertyStatic") &&
				position === 0
			) {
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				const slot =
					typeof stringIndex === "number"
						? slotByStringIndex.get(stringIndex)
						: undefined;
				if (slot === undefined) return undefined;
				accesses.set(instruction, { instruction, slot });
				continue;
			}
			return undefined;
		}
	}

	const materializations: Array<{
		readonly instruction: CoreInstructionId;
		readonly kind: "return";
	}> = [];
	for (const block of control.reachable) {
		const terminatorId = fn.blockTerminator(block);
		const terminator = fn.terminatorPayload(terminatorId);
		if (terminator.kind === "return" && aliasesAllocation(terminator.value)) {
			materializations.push({ instruction: terminatorId, kind: "return" });
		} else if (
			(terminator.kind === "throw" && aliasesAllocation(terminator.value)) ||
			((terminator.kind === "branch" || terminator.kind === "guard") &&
				aliasesAllocation(terminator.condition)) ||
			(terminator.kind === "switch" && aliasesAllocation(terminator.discriminant))
		) {
			return undefined;
		}
	}
	const stableAccesses = Object.freeze(
		[...accesses.values()].sort((left, right) => left.instruction - right.instruction),
	);
	const stableMaterializations = Object.freeze(
		materializations.sort((left, right) => left.instruction - right.instruction),
	);
	const instructions = Object.freeze([
		layout.instruction,
		...stableAccesses.map(({ instruction }) => instruction),
		...stableMaterializations.map(({ instruction }) => instruction),
	]);
	return Object.freeze({
		key: `stack-object:${fn.id}:${layout.instruction}:${instructions.join(",")}`,
		kind: "stack-object",
		function: fn.id,
		root: layout.instruction,
		allocation: layout.instruction,
		mode:
			!requiresObjectIdentity &&
			stableAccesses.length === 0 &&
			stableMaterializations.length === 0
				? "elided"
				: "activation-local",
		instructions,
		fanOut: Math.max(0, instructions.length - 1),
		slotCount: layout.keys.length,
		accesses: stableAccesses,
		materializations: stableMaterializations,
	});
}

export interface CoreStackObjectProof {
	readonly allocation: CoreInstructionId;
	readonly mode: "elided" | "activation-local";
	readonly slotCount: number;
	readonly accesses: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly slot: number;
	}>;
	readonly materializations: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly kind: "return";
	}>;
}

export interface CoreStackObjectProofs {
	readonly proofs: ReadonlyArray<CoreStackObjectProof>;
}

export const CORE_LOCAL_STACK_OBJECT_PROOFS_ANALYSIS: CoreAnalysisDefinition<CoreStackObjectProofs> =
	{
		key: "local-stack-object-proofs",
		scope: "function",
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"memoryEffects",
			"representations",
		],
		programDependencies: ["data"],
		compute({ program, request, get }) {
			if (request.scope !== "function") {
				throw new Error("Expected function analysis request");
			}
			const fn = program.function(request.function);
			const provenanceAnalysis = get(CORE_LOCAL_PROVENANCE_ANALYSIS, request);
			const control = get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request);
			const roots = get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request);
			const proofs = provenanceAnalysis.layouts.flatMap((layout) => {
				if (layout.kind !== "named-slots") return [];
				const candidate = stackObjectCandidate(fn, layout, control, roots);
				return candidate === undefined
					? []
					: [
							Object.freeze({
								allocation: candidate.allocation,
								mode: candidate.mode,
								slotCount: candidate.slotCount,
								accesses: candidate.accesses,
								materializations: candidate.materializations,
							}),
						];
			});
			return Object.freeze({ proofs: Object.freeze(proofs) });
		},
	};

function provenNumericValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	numericRoots: ReadonlySet<CoreValueId>,
	memo = new Map<CoreValueId, boolean>(),
): boolean {
	if (
		fn.valueRepresentation(value) === "i32" ||
		fn.valueRepresentation(value) === "f64"
	) {
		return true;
	}
	const root = roots.get(value) ?? value;
	if (numericRoots.has(root)) return true;
	const cached = memo.get(root);
	if (cached !== undefined) return cached;
	memo.set(root, false);
	const definition = fn.valueDefinition(root);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return false;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const operands = fn.instructionOperands(definition.instruction);
	const operator = fn.instructionAttributes(definition.instruction).operator;
	const proven =
		opcode === "createNumber" ||
		opcode === "createF64" ||
		(opcode === "move" &&
			operands.length === 1 &&
			provenNumericValue(fn, operands[0]!, roots, numericRoots, memo)) ||
		(opcode === "unary" &&
			typeof operator === "string" &&
			["+", "-", "~", "tonumeric"].includes(operator) &&
			operands.length === 1 &&
			provenNumericValue(fn, operands[0]!, roots, numericRoots, memo)) ||
		(opcode === "binary" &&
			typeof operator === "string" &&
			FRESH_DENSE_NUMERIC_OPERATORS.has(operator) &&
			operands.length === 2 &&
			operands.every((operand) =>
				provenNumericValue(fn, operand, roots, numericRoots, memo),
			));
	memo.set(root, proven);
	return proven;
}

function exactIntegerValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): number | undefined {
	const definition = fn.valueDefinition(roots.get(value) ?? value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation" ||
		(fn.instructionOpcodeName(definition.instruction) !== "createNumber" &&
			fn.instructionOpcodeName(definition.instruction) !== "createF64")
	)
		return undefined;
	const immediate = fn.instructionAttributes(definition.instruction).value;
	return typeof immediate === "number" && Number.isSafeInteger(immediate)
		? immediate
		: undefined;
}

function denseArrayCandidates(
	fn: CoreFunctionStore,
	layout: CoreIndexedAllocationLayout,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): ReadonlyArray<CoreDenseArrayCandidate> {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		layout.length !== 0 ||
		fn.instructionOpcodeName(layout.instruction) !== "createArray" ||
		!control.reachable.has(fn.instructionBlock(layout.instruction))
	)
		return [];
	const allocationBlock = fn.instructionBlock(layout.instruction);
	const allocationRoot = roots.get(layout.result) ?? layout.result;
	const aliasesAllocation = (value: CoreValueId): boolean =>
		(roots.get(value) ?? value) === allocationRoot;
	const allocationInstructions = [...fn.bodyInstructionIds(allocationBlock)];
	const allocationIndex = allocationInstructions.indexOf(layout.instruction);
	if (
		allocationIndex < 0 ||
		allocationInstructions.slice(allocationIndex + 1).some((instruction) => {
			const opcode = fn.instructionOpcodeName(instruction);
			return opcode !== "createNumber" && opcode !== "createF64" && opcode !== "move";
		})
	)
		return [];

	const candidates: Array<CoreDenseArrayCandidate> = [];
	for (const loop of control.loops) {
		if (
			!loop.canonical ||
			loop.preheader === undefined ||
			(loop.blocks.size !== 2 && loop.blocks.size !== 3) ||
			loop.latches.size !== 1 ||
			loop.blocks.has(allocationBlock) ||
			!control.dominates(allocationBlock, loop.header)
		)
			continue;
		const headerTerminator = fn.terminatorPayload(fn.blockTerminator(loop.header));
		if (headerTerminator.kind !== "branch") continue;
		const condition = fn.valueDefinition(
			roots.get(headerTerminator.condition) ?? headerTerminator.condition,
		);
		if (
			condition.kind !== "instruction" ||
			fn.instructionKind(condition.instruction) !== "operation" ||
			fn.instructionOpcodeName(condition.instruction) !== "binary" ||
			fn.instructionAttributes(condition.instruction).operator !== "<"
		)
			continue;
		const comparisonOperands = fn.instructionOperands(condition.instruction);
		const counter = comparisonOperands[0];
		const length =
			comparisonOperands[1] === undefined
				? undefined
				: exactIntegerValue(fn, comparisonOperands[1], roots);
		const parameters = fn.blockParameters(loop.header);
		const counterParameter =
			counter === undefined ? -1 : parameters.findIndex(({ value }) => value === counter);
		const latch = [...loop.latches][0]!;
		const incoming = (control.predecessors[loop.header] ?? []).filter(
			({ kind }) => kind === "ordinary",
		);
		const initialEdge = incoming.find(({ from }) => from === loop.preheader);
		const updateEdge = incoming.find(({ from }) => from === latch);
		if (
			counter === undefined ||
			counterParameter < 0 ||
			length === undefined ||
			length <= 0 ||
			length > MAX_FRESH_DENSE_INDEXED_RESERVE ||
			initialEdge === undefined ||
			updateEdge === undefined ||
			exactIntegerValue(fn, initialEdge.arguments[counterParameter]!, roots) !== 0 ||
			!loop.blocks.has(headerTerminator.consequent.block) ||
			loop.blocks.has(headerTerminator.alternate.block)
		)
			continue;
		const updateValue = updateEdge.arguments[counterParameter];
		if (updateValue === undefined) continue;
		const update = fn.valueDefinition(roots.get(updateValue) ?? updateValue);
		if (
			update.kind !== "instruction" ||
			fn.instructionKind(update.instruction) !== "operation" ||
			fn.instructionOpcodeName(update.instruction) !== "unary" ||
			fn.instructionAttributes(update.instruction).operator !== "increment"
		)
			continue;
		let incrementInput = fn.instructionOperands(update.instruction)[0];
		if (incrementInput === undefined) continue;
		const numeric = fn.valueDefinition(roots.get(incrementInput) ?? incrementInput);
		if (
			numeric.kind === "instruction" &&
			fn.instructionKind(numeric.instruction) === "operation" &&
			fn.instructionOpcodeName(numeric.instruction) === "unary" &&
			fn.instructionAttributes(numeric.instruction).operator === "tonumeric"
		) {
			incrementInput = fn.instructionOperands(numeric.instruction)[0]!;
		}
		const counterRoot = roots.get(counter) ?? counter;
		if ((roots.get(incrementInput) ?? incrementInput) !== counterRoot) continue;
		const stores = [...loop.blocks].flatMap((block) =>
			[...fn.bodyInstructionIds(block)].filter((instruction) => {
				if (fn.instructionOpcodeName(instruction) !== "storeProperty") return false;
				const operands = fn.instructionOperands(instruction);
				return (
					operands.length === 3 &&
					aliasesAllocation(operands[0]!) &&
					(roots.get(operands[1]!) ?? operands[1]!) === counterRoot
				);
			}),
		);
		if (stores.length !== 1) continue;
		const store = stores[0]!;
		const storeValue = fn.instructionOperands(store)[2]!;
		if (!provenNumericValue(fn, storeValue, roots, new Set([counterRoot]))) continue;

		let safe = true;
		for (const block of control.reachable) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				const opcode = fn.instructionOpcodeName(instruction);
				for (const [position, operand] of fn.instructionOperands(instruction).entries()) {
					if (!aliasesAllocation(operand)) continue;
					if (
						(opcode === "move" && position === 0) ||
						(opcode === "throwIfTdz" && position === 0) ||
						opcode === "rootUse" ||
						(instruction === store && position === 0) ||
						control.dominates(headerTerminator.alternate.block, block)
					) {
						continue;
					}
					safe = false;
				}
			}
			const terminator = fn.terminatorPayload(fn.blockTerminator(block));
			if (
				!control.dominates(headerTerminator.alternate.block, block) &&
				((terminator.kind === "return" && aliasesAllocation(terminator.value)) ||
					(terminator.kind === "throw" && aliasesAllocation(terminator.value)) ||
					((terminator.kind === "branch" || terminator.kind === "guard") &&
						aliasesAllocation(terminator.condition)) ||
					(terminator.kind === "switch" && aliasesAllocation(terminator.discriminant)))
			) {
				safe = false;
			}
		}
		if (!safe) continue;
		const instructions = Object.freeze(
			[layout.instruction, store].sort((left, right) => left - right),
		);
		candidates.push(
			Object.freeze({
				key: `dense-array:${fn.id}:${layout.instruction}:${store}:${length}`,
				kind: "dense-array",
				mode: "fresh-indexed-fill",
				function: fn.id,
				root: layout.instruction,
				allocation: layout.instruction,
				store,
				loopHeader: loop.header,
				length,
				instructions,
				fanOut: 1,
			}),
		);
	}
	return candidates;
}

interface CoreLocalSpecializationIndex {
	readonly location: ReadonlyMap<
		CoreInstructionId,
		{ readonly block: CoreBlockId; readonly index: number }
	>;
	readonly uses: ReadonlyMap<
		CoreValueId,
		ReadonlyArray<{ readonly instruction: CoreInstructionId; readonly position: number }>
	>;
	readonly controlUses: ReadonlySet<CoreValueId>;
	readonly handlerTargets: ReadonlySet<CoreBlockId>;
}

function decodeCoreString(program: CoreProgram, index: number): string | undefined {
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

function localSpecializationIndex(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreLocalSpecializationIndex {
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const location = new Map<
		CoreInstructionId,
		{ readonly block: CoreBlockId; readonly index: number }
	>();
	const uses = new Map<
		CoreValueId,
		Array<{ readonly instruction: CoreInstructionId; readonly position: number }>
	>();
	const controlUses = new Set<CoreValueId>();
	const handlerTargets = new Set<CoreBlockId>();
	for (const block of fn.blockIds()) {
		for (const [index, instruction] of [...fn.bodyInstructionIds(block)].entries()) {
			location.set(instruction, { block, index });
			for (const [position, operand] of fn.instructionOperands(instruction).entries()) {
				const value = root(operand);
				const entries = uses.get(value) ?? [];
				entries.push({ instruction, position });
				uses.set(value, entries);
			}
		}
		const terminator = fn.blockTerminator(block);
		location.set(terminator, {
			block,
			index: [...fn.bodyInstructionIds(block)].length,
		});
		const payload = fn.terminatorPayload(terminator);
		for (const edge of [
			...(payload.kind === "jump"
				? [payload.edge]
				: payload.kind === "branch"
					? [payload.consequent, payload.alternate]
					: payload.kind === "guard"
						? [payload.success, payload.fallback]
						: payload.kind === "switch"
							? [...payload.cases.map(({ edge }) => edge), payload.default]
							: []),
		]) {
			for (const value of edge.arguments) controlUses.add(root(value));
		}
		switch (payload.kind) {
			case "branch":
			case "guard":
				controlUses.add(root(payload.condition));
				break;
			case "switch":
				controlUses.add(root(payload.discriminant));
				break;
			case "return":
			case "throw":
				controlUses.add(root(payload.value));
				break;
			case "jump":
			case "unreachable":
				break;
		}
		const handler = fn.blockHandler(block);
		if (handler !== undefined) {
			handlerTargets.add(handler.block);
			for (const value of handler.arguments) controlUses.add(root(value));
		}
	}
	return { location, uses, controlUses, handlerTargets };
}

function specializationInstructionDominates(
	control: CoreControlFlow,
	index: CoreLocalSpecializationIndex,
	producer: CoreInstructionId,
	consumer: CoreInstructionId,
): boolean {
	const left = index.location.get(producer);
	const right = index.location.get(consumer);
	if (left === undefined || right === undefined) return false;
	return left.block === right.block
		? left.index < right.index
		: control.dominates(left.block, right.block);
}

function specializationDefinition(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	value: CoreValueId,
): CoreInstructionId | undefined {
	const definition = fn.valueDefinition(roots.get(value) ?? value);
	return definition.kind === "instruction" &&
		fn.instructionKind(definition.instruction) === "operation"
		? definition.instruction
		: undefined;
}

function specializationResultValues(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	value: CoreValueId,
): ReadonlyArray<CoreValueId> {
	const expected = roots.get(value) ?? value;
	const values: Array<CoreValueId> = [];
	for (let raw = 0; raw < fn.valueCapacity; raw++) {
		const candidate = coreValueId(raw);
		if (fn.isValueLive(candidate) && (roots.get(candidate) ?? candidate) === expected) {
			values.push(candidate);
		}
	}
	return Object.freeze(values);
}

function staticPropertyNamed(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId | undefined,
	name: string,
): instruction is CoreInstructionId {
	if (
		instruction === undefined ||
		fn.instructionOpcodeName(instruction) !== "loadPropertyStatic"
	)
		return false;
	const stringIndex = fn.instructionAttributes(instruction).stringIndex;
	return (
		typeof stringIndex === "number" && decodeCoreString(program, stringIndex) === name
	);
}

function knownBuiltinOperation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	const value = fn.instructionAttributes(instruction).knownBuiltinCall;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const operation = (value as Readonly<Record<string, unknown>>).operation;
	return typeof operation === "string" ? operation : undefined;
}

function exactPropertyCallCandidate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
	call: CoreInstructionId,
	propertyName: string,
):
	| {
			readonly property: CoreInstructionId;
			readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
	  }
	| undefined {
	if (
		fn.instructionKind(call) !== "operation" ||
		fn.instructionOpcodeName(call) !== "call" ||
		fn.instructionResults(call).length !== 1 ||
		fn.instructionOperands(call).length < 2 ||
		!control.reachable.has(fn.instructionBlock(call))
	) {
		return undefined;
	}
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const operands = fn.instructionOperands(call);
	const property = specializationDefinition(fn, roots, operands[0]!);
	if (
		!staticPropertyNamed(program, fn, property, propertyName) ||
		fn.instructionOperands(property).length !== 1 ||
		root(fn.instructionOperands(property)[0]!) !== root(operands[1]!) ||
		fn.instructionBlock(property) !== fn.instructionBlock(call) ||
		!specializationInstructionDominates(control, index, property, call)
	) {
		return undefined;
	}
	const propertyResult = fn.instructionResults(property)[0];
	if (propertyResult === undefined) return undefined;
	const propertyUses = index.uses.get(root(propertyResult)) ?? [];
	if (
		propertyUses.length !== 1 ||
		propertyUses[0]?.instruction !== call ||
		propertyUses[0].position !== 0
	) {
		return undefined;
	}
	const handler = fn.blockHandler(fn.instructionBlock(call));
	return {
		property,
		exceptionalBlocks: Object.freeze(handler === undefined ? [] : [handler.block]),
	};
}

function stringCharCodeAtCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	loops: CoreLoopInductionAnalysis,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreStringCharCodeAtCandidate> {
	const candidates: Array<CoreStringCharCodeAtCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const call of fn.instructionIds()) {
		if (
			fn.instructionKind(call) !== "operation" ||
			(fn.instructionOperands(call).length !== 2 &&
				fn.instructionOperands(call).length !== 3)
		) {
			continue;
		}
		const matched = exactPropertyCallCandidate(
			program,
			fn,
			control,
			roots,
			index,
			call,
			"charCodeAt",
		);
		if (matched === undefined) continue;
		const operands = fn.instructionOperands(call);
		const receiver = operands[1];
		const position = operands[2];
		let bounded: CoreStringCharCodeAtCandidate["bounded"];
		if (receiver !== undefined && position !== undefined) {
			for (const induction of loops.inductions) {
				const comparison = induction.comparison;
				if (
					comparison?.operator !== "<" ||
					induction.step !== 1 ||
					literalArrayIndex(fn, root(induction.initial)) !== 0 ||
					root(position) !== root(induction.value) ||
					!induction.loop.blocks.has(fn.instructionBlock(call)) ||
					!control.dominates(comparison.body, fn.instructionBlock(call)) ||
					fn.blockHandler(induction.loop.header) !== undefined ||
					fn.blockHandler(fn.instructionBlock(call)) !== undefined
				)
					continue;
				const incoming = (control.predecessors[comparison.body] ?? []).filter(
					({ kind }) => kind === "ordinary",
				);
				if (incoming.length !== 1 || incoming[0]!.from !== induction.loop.header)
					continue;
				const length = specializationDefinition(fn, roots, comparison.bound);
				if (
					length === undefined ||
					!staticPropertyNamed(program, fn, length, "length") ||
					fn.instructionOperands(length).length !== 1 ||
					root(fn.instructionOperands(length)[0]!) !== root(receiver) ||
					!specializationInstructionDominates(
						control,
						index,
						length,
						comparison.instruction,
					)
				)
					continue;
				const updateLocation = index.location.get(induction.updateInstruction);
				const callLocation = index.location.get(call);
				if (
					updateLocation === undefined ||
					callLocation === undefined ||
					(updateLocation.block === callLocation.block &&
						callLocation.index >= updateLocation.index)
				)
					continue;
				bounded = Object.freeze({
					length,
					comparison: comparison.instruction,
					update: induction.updateInstruction,
				});
				break;
			}
		}
		const instructions = Object.freeze([matched.property, call]);
		const key = `string-char-code-at-chain:${fn.id}:${call}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "string-char-code-at-chain",
				function: fn.id,
				root: call,
				property: matched.property,
				call,
				...(bounded === undefined ? {} : { bounded }),
				exceptionalBlocks: matched.exceptionalBlocks,
				instructions,
				fanOut: 1,
			}),
		);
	}
	return candidates;
}

function exactScriptFunctionTarget(
	program: CoreProgram,
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	value: CoreValueId,
): CoreFunctionId | undefined {
	const definition = specializationDefinition(fn, roots, value);
	if (
		definition === undefined ||
		fn.instructionOpcodeName(definition) !== "createFunction"
	)
		return undefined;
	const index = fn.instructionAttributes(definition).functionIndex;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
		return undefined;
	const target = coreFunctionId(index);
	return program.hasFunction(target) ? target : undefined;
}

function functionCallChainCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreFunctionCallChainCandidate> {
	const candidates: Array<CoreFunctionCallChainCandidate> = [];
	for (const call of fn.instructionIds()) {
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			fn.instructionOperands(call).length < 2
		)
			continue;
		const matched = exactPropertyCallCandidate(
			program,
			fn,
			control,
			roots,
			index,
			call,
			"call",
		);
		if (matched === undefined) continue;
		const receiver = fn.instructionOperands(call)[1]!;
		const targetFunction = exactScriptFunctionTarget(program, fn, roots, receiver);
		const instructions = Object.freeze([matched.property, call]);
		candidates.push(
			Object.freeze({
				key: `function-call-chain:${fn.id}:${call}`,
				kind: "function-call-chain",
				function: fn.id,
				root: call,
				property: matched.property,
				call,
				...(targetFunction === undefined ? {} : { targetFunction }),
				exceptionalBlocks: matched.exceptionalBlocks,
				instructions,
				fanOut: targetFunction === undefined ? 1 : 2,
			}),
		);
	}
	return candidates;
}

function stringSplitCursorCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	loops: CoreLoopInductionAnalysis,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreStringSplitCursorCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const exactUses = (
		value: CoreValueId,
		expected: ReadonlyArray<{
			readonly instruction: CoreInstructionId;
			readonly position: number;
		}>,
	): boolean => {
		const actual = index.uses.get(root(value)) ?? [];
		return (
			actual.length === expected.length &&
			expected.every(({ instruction, position }) =>
				actual.some(
					(use) => use.instruction === instruction && use.position === position,
				),
			)
		);
	};
	const canReachWithout = (
		from: CoreBlockId,
		to: CoreBlockId,
		blocked: CoreBlockId,
	): boolean => {
		if (from === blocked) return false;
		const seen = new Set<CoreBlockId>([blocked]);
		const pending = [from];
		while (pending.length > 0) {
			const block = pending.pop()!;
			if (block === to) return true;
			if (seen.has(block)) continue;
			seen.add(block);
			for (const edge of control.successors[block] ?? []) {
				if (edge.kind === "ordinary" && !seen.has(edge.to)) pending.push(edge.to);
			}
		}
		return false;
	};
	const candidates: Array<CoreStringSplitCursorCandidate> = [];
	for (const induction of loops.inductions) {
		const { loop, comparison } = induction;
		if (
			comparison?.operator !== "<" ||
			induction.step !== 1 ||
			literalArrayIndex(fn, root(induction.initial)) !== 0 ||
			!loop.canonical ||
			loop.latches.size !== 1
		)
			continue;
		const latch = [...loop.latches][0]!;
		const header = loop.header;
		const body = comparison.body;
		const headerTerminator = fn.blockTerminator(header);
		const branch = fn.terminatorPayload(headerTerminator);
		const latchTerminator = fn.blockTerminator(latch);
		const latchJump = fn.terminatorPayload(latchTerminator);
		const bodyTerminator = fn.blockTerminator(body);
		const bodyExit = fn.terminatorPayload(bodyTerminator);
		const compactBody = body === latch && loop.blocks.size === 2;
		const explicitLatch =
			body !== header &&
			body !== latch &&
			loop.blocks.size === 3 &&
			bodyExit.kind === "jump" &&
			bodyExit.edge.block === latch;
		if (
			branch.kind !== "branch" ||
			branch.consequent.block !== body ||
			branch.alternate.block !== comparison.exit ||
			latchJump.kind !== "jump" ||
			latchJump.edge.block !== header ||
			(!compactBody && !explicitLatch) ||
			comparison.instruction !== [...fn.bodyInstructionIds(header)].at(-1)
		)
			continue;
		const length = specializationDefinition(fn, roots, comparison.bound);
		if (
			length === undefined ||
			!staticPropertyNamed(program, fn, length, "length") ||
			fn.instructionOperands(length).length !== 1 ||
			length !== [...fn.bodyInstructionIds(header)].at(-2)
		)
			continue;
		const splitResult = root(fn.instructionOperands(length)[0]!);
		const call = specializationDefinition(fn, roots, splitResult);
		if (call === undefined || fn.instructionOpcodeName(call) !== "call") continue;
		const split = exactPropertyCallCandidate(
			program,
			fn,
			control,
			roots,
			index,
			call,
			"split",
		);
		if (
			split === undefined ||
			split.exceptionalBlocks.length !== 0 ||
			!control.dominates(fn.instructionBlock(call), header)
		)
			continue;
		const bodyInstructions = [...fn.bodyInstructionIds(body)];
		const element = bodyInstructions[0];
		const trimProperty = bodyInstructions[1];
		const trimCall = bodyInstructions[2];
		if (
			element === undefined ||
			trimProperty === undefined ||
			trimCall === undefined ||
			fn.instructionOpcodeName(element) !== "loadProperty" ||
			fn.instructionOperands(element).length !== 2 ||
			root(fn.instructionOperands(element)[0]!) !== splitResult ||
			root(fn.instructionOperands(element)[1]!) !== root(induction.value)
		)
			continue;
		const trim = exactPropertyCallCandidate(
			program,
			fn,
			control,
			roots,
			index,
			trimCall,
			"trim",
		);
		const elementResult = fn.instructionResults(element)[0];
		if (
			trim === undefined ||
			trim.exceptionalBlocks.length !== 0 ||
			trim.property !== trimProperty ||
			elementResult === undefined ||
			root(fn.instructionOperands(trimCall)[1]!) !== root(elementResult)
		)
			continue;
		const increment = induction.updateInstruction;
		if (
			fn.instructionBlock(increment) !== latch ||
			fn.instructionOpcodeName(increment) !== "unary" ||
			fn.instructionAttributes(increment).operator !== "increment" ||
			increment !== [...fn.bodyInstructionIds(latch)].at(-1)
		)
			continue;
		const incrementInput = fn.instructionOperands(increment)[0];
		if (incrementInput === undefined) continue;
		const inputDefinition = specializationDefinition(fn, roots, incrementInput);
		const advance =
			inputDefinition !== undefined &&
			fn.instructionOpcodeName(inputDefinition) === "unary" &&
			fn.instructionAttributes(inputDefinition).operator === "tonumeric"
				? inputDefinition
				: increment;
		const advanceInput = fn.instructionOperands(advance)[0];
		if (advanceInput === undefined || root(advanceInput) !== root(induction.value))
			continue;
		const trimResult = fn.instructionResults(trimCall)[0];
		if (trimResult === undefined) continue;
		const primitiveStringLengths: Array<CoreInstructionId> = [];
		let trimResultSafe = true;
		for (const use of index.uses.get(root(trimResult)) ?? []) {
			if (
				use.position === 0 &&
				staticPropertyNamed(program, fn, use.instruction, "length") &&
				specializationInstructionDominates(control, index, trimCall, use.instruction)
			) {
				primitiveStringLengths.push(use.instruction);
			} else trimResultSafe = false;
		}
		const comparisonResult = fn.instructionResults(comparison.instruction)[0];
		if (
			!trimResultSafe ||
			primitiveStringLengths.length > 64 ||
			comparisonResult === undefined ||
			root(branch.condition) !== root(comparisonResult) ||
			!exactUses(splitResult, [
				{ instruction: length, position: 0 },
				{ instruction: element, position: 0 },
			]) ||
			!exactUses(induction.value, [
				{ instruction: comparison.instruction, position: 0 },
				{ instruction: element, position: 1 },
				{ instruction: advance, position: 0 },
			]) ||
			!exactUses(elementResult, [
				{ instruction: trimProperty, position: 0 },
				{ instruction: trimCall, position: 1 },
			]) ||
			!exactUses(fn.instructionResults(trimProperty)[0]!, [
				{ instruction: trimCall, position: 0 },
			])
		)
			continue;
		const callBlock = fn.instructionBlock(call);
		if (canReachWithout(comparison.exit, header, callBlock)) continue;
		const instructions = Object.freeze([
			split.property,
			call,
			length,
			comparison.instruction,
			headerTerminator,
			element,
			trimProperty,
			trimCall,
			...primitiveStringLengths,
			...(advance === increment ? [] : [advance]),
			increment,
			latchTerminator,
		]);
		if (new Set(instructions).size !== instructions.length) continue;
		const ordinaryBlocks = new Set(
			instructions.map((instruction) => fn.instructionBlock(instruction)),
		);
		if (
			[...ordinaryBlocks].some(
				(block) =>
					fn.blockHandler(block) !== undefined || index.handlerTargets.has(block),
			)
		)
			continue;
		const resultValues = Object.freeze(
			Array.from({ length: fn.valueCapacity }, (_, value) => coreValueId(value)).filter(
				(value) => fn.isValueLive(value) && root(value) === splitResult,
			),
		);
		candidates.push(
			Object.freeze({
				key: `string-split-cursor:${fn.id}:${call}:${header}`,
				kind: "string-split-cursor",
				function: fn.id,
				root: call,
				property: split.property,
				call,
				length,
				compare: comparison.instruction,
				branch: headerTerminator,
				element,
				trimProperty,
				trimCall,
				...(advance === increment ? {} : { advance }),
				increment,
				backedge: latchTerminator,
				resultValues,
				primitiveStringLengths: Object.freeze(primitiveStringLengths),
				exitBlock: comparison.exit,
				exceptionalBlocks: Object.freeze([]),
				instructions,
				fanOut: 5 + primitiveStringLengths.length,
			}),
		);
		if (candidates.length >= 8) break;
	}
	return candidates;
}

const COLLECTION_CALL_CHAIN_OPERATIONS: ReadonlySet<string> = new Set([
	"Map.prototype.get",
	"Map.prototype.set",
	"Map.prototype.has",
	"Map.prototype.delete",
	"Set.prototype.add",
	"Set.prototype.has",
	"Set.prototype.delete",
]);

function exactFreshCollectionReceiver(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
	property: CoreInstructionId,
	call: CoreInstructionId,
	operation: string,
): CoreExactCollectionBrand | undefined {
	const expected = operation.startsWith("Map.prototype.")
		? "Map"
		: operation.startsWith("Set.prototype.")
			? "Set"
			: undefined;
	const receiver = fn.instructionOperands(call)[1];
	if (expected === undefined || receiver === undefined) return undefined;
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const definition = fn.valueDefinition(root(receiver));
	if (
		definition.kind !== "instruction" ||
		fn.instructionOpcodeName(definition.instruction) !== "construct"
	)
		return undefined;
	const constructor = fn.instructionOperands(definition.instruction)[0];
	if (constructor === undefined) return undefined;
	const constructorDefinition = fn.valueDefinition(root(constructor));
	if (
		constructorDefinition.kind !== "instruction" ||
		fn.instructionOpcodeName(constructorDefinition.instruction) !== "loadIntrinsic" ||
		fn.instructionAttributes(constructorDefinition.instruction).intrinsic !== expected
	)
		return undefined;
	if (index.controlUses.has(root(receiver))) return undefined;
	const uses = index.uses.get(root(receiver)) ?? [];
	if (
		uses.some(({ instruction, position }) => {
			if (instruction === property && position === 0) return false;
			if (instruction === call && position === 1) return false;
			const opcode = fn.instructionOpcodeName(instruction);
			return opcode !== "move" && opcode !== "rootUse" && opcode !== "throwIfTdz";
		})
	)
		return undefined;
	return expected;
}

function builtinCollectionCallCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreBuiltinCollectionCallCandidate> {
	const candidates: Array<CoreBuiltinCollectionCallCandidate> = [];
	for (const call of fn.instructionIds()) {
		if (fn.instructionKind(call) !== "operation") continue;
		const operation = knownBuiltinOperation(fn, call);
		if (operation === undefined || !COLLECTION_CALL_CHAIN_OPERATIONS.has(operation)) {
			continue;
		}
		const matched = exactPropertyCallCandidate(
			program,
			fn,
			control,
			roots,
			index,
			call,
			operation.split(".").at(-1)!,
		);
		if (matched === undefined) continue;
		const exactReceiver = exactFreshCollectionReceiver(
			fn,
			roots,
			index,
			matched.property,
			call,
			operation,
		);
		const instructions = Object.freeze([matched.property, call]);
		const key = `builtin-collection-call-chain:${fn.id}:${call}:${operation}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "builtin-collection-call-chain",
				function: fn.id,
				root: call,
				property: matched.property,
				call,
				operation: operation as CoreCollectionBuiltinOperation,
				...(exactReceiver === undefined ? {} : { exactReceiver }),
				exceptionalBlocks: matched.exceptionalBlocks,
				instructions,
				fanOut: 1,
			}),
		);
	}
	return candidates;
}

function freshArrayLengthCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	provenanceAnalysis: CoreProvenance,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreFreshArrayLengthCandidate> {
	const candidates: Array<CoreFreshArrayLengthCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const load of fn.instructionIds()) {
		if (
			fn.instructionKind(load) !== "operation" ||
			!staticPropertyNamed(program, fn, load, "length") ||
			fn.instructionOperands(load).length !== 1 ||
			fn.instructionResults(load).length !== 1 ||
			!control.reachable.has(fn.instructionBlock(load))
		)
			continue;
		const base = fn.instructionOperands(load)[0]!;
		const layout = provenanceAnalysis.allocationOf(base);
		if (
			layout?.kind !== "indexed" ||
			provenanceAnalysis.escape(layout.instruction) !== "contained" ||
			!specializationInstructionDominates(control, index, layout.instruction, load)
		)
			continue;
		const initialization = new Set(
			[...layout.elements.values()].map(({ definition }) => definition),
		);
		const uses = index.uses.get(root(layout.result)) ?? [];
		if (
			uses.some(({ instruction, position }) => {
				if (instruction === load && position === 0) return false;
				if (initialization.has(instruction) && position === 0) return false;
				const opcode = fn.instructionOpcodeName(instruction);
				return opcode !== "move" && opcode !== "rootUse" && opcode !== "throwIfTdz";
			}) ||
			index.controlUses.has(root(layout.result))
		)
			continue;
		const instructions = Object.freeze([layout.instruction, load]);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		candidates.push(
			Object.freeze({
				key: `fresh-array-length:${fn.id}:${layout.instruction}:${load}`,
				kind: "fresh-array-length",
				function: fn.id,
				root: load,
				allocation: layout.instruction,
				load,
				length: layout.length,
				exceptionalBlocks,
				instructions,
				fanOut: 1,
			}),
		);
	}
	return candidates;
}

const INDEXED_LENGTH_LOOP_OPERATORS: ReadonlySet<string> = new Set([
	"<",
	"<=",
	">",
	">=",
	"!=",
	"!==",
]);

function indexedLengthLoopCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreIndexedLengthLoopCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const candidates: Array<CoreIndexedLengthLoopCandidate> = [];
	for (const load of fn.instructionIds()) {
		if (
			fn.instructionKind(load) !== "operation" ||
			!staticPropertyNamed(program, fn, load, "length") ||
			fn.instructionOperands(load).length !== 1 ||
			fn.instructionResults(load).length !== 1 ||
			!control.reachable.has(fn.instructionBlock(load))
		)
			continue;
		const block = fn.instructionBlock(load);
		const loop = control.loops
			.filter(({ blocks }) => blocks.has(block))
			.sort((left, right) => left.blocks.size - right.blocks.size)[0];
		if (loop === undefined) continue;
		const output = fn.instructionResults(load)[0]!;
		if (index.controlUses.has(roots.get(output) ?? output)) continue;
		const uses = [...fn.uses(output)];
		if (uses.length !== 1) continue;
		const comparison = uses[0]!.instruction;
		if (
			fn.instructionKind(comparison) !== "operation" ||
			fn.instructionOpcodeName(comparison) !== "binary" ||
			fn.instructionBlock(comparison) !== block ||
			!INDEXED_LENGTH_LOOP_OPERATORS.has(
				String(fn.instructionAttributes(comparison).operator),
			)
		)
			continue;
		const comparisonOperands = fn.instructionOperands(comparison);
		const lengthPosition =
			comparisonOperands[0] === output
				? 1
				: comparisonOperands[1] === output
					? 2
					: undefined;
		if (lengthPosition === undefined) continue;
		const induction = comparisonOperands[lengthPosition === 1 ? 1 : 0];
		if (
			induction === undefined ||
			(fn.valueRepresentation(induction) !== "i32" &&
				fn.valueRepresentation(induction) !== "f64")
		)
			continue;
		const loadLocation = index.location.get(load);
		const comparisonLocation = index.location.get(comparison);
		if (
			loadLocation === undefined ||
			comparisonLocation === undefined ||
			loadLocation.index >= comparisonLocation.index
		)
			continue;
		const receiver = fn.instructionOperands(load)[0]!;
		const elements: Array<{
			readonly instruction: CoreInstructionId;
			readonly kind: "load" | "store";
		}> = [];
		for (const candidateBlock of fn.blockIds()) {
			if (!loop.blocks.has(candidateBlock) || !control.dominates(block, candidateBlock)) {
				continue;
			}
			for (const instruction of fn.bodyInstructionIds(candidateBlock)) {
				const opcode = fn.instructionOpcodeName(instruction);
				const kind =
					opcode === "loadProperty"
						? ("load" as const)
						: opcode === "storeProperty"
							? ("store" as const)
							: undefined;
				if (
					kind === undefined ||
					fn.instructionOperands(instruction)[0] !== receiver ||
					fn.instructionOperands(instruction)[1] !== induction
				)
					continue;
				const location = index.location.get(instruction);
				if (
					location === undefined ||
					(location.block === block && location.index <= comparisonLocation.index)
				)
					continue;
				elements.push({ instruction, kind });
				if (elements.length >= 8) break;
			}
			if (elements.length >= 8) break;
		}
		const instructions = Object.freeze([
			load,
			comparison,
			...elements.map(({ instruction }) => instruction),
		]);
		if (elements.length === 0) continue;
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		candidates.push(
			Object.freeze({
				key: `indexed-length-loop:${fn.id}:${load}:${comparison}`,
				kind: "indexed-length-loop",
				function: fn.id,
				root: load,
				load,
				comparison,
				lengthPosition,
				elements: Object.freeze(elements),
				exceptionalBlocks,
				instructions,
				fanOut: 1 + elements.length,
			}),
		);
		if (candidates.length >= 32) break;
	}
	return candidates;
}

const NUMERIC_TYPED_ARRAY_INTRINSICS: ReadonlySet<string> = new Set([
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
]);

function iteratorCursorKind(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	source: CoreValueId,
): {
	readonly kind: CorePlanIteratorCursorKind;
	readonly protocol: CorePlanIteratorCursorProtocol;
} {
	const root = roots.get(source) ?? source;
	const definition = fn.valueDefinition(root);
	const sourceInstruction =
		definition.kind === "instruction" ? definition.instruction : undefined;
	if (
		fn.valueRepresentation(root) === "string" ||
		(sourceInstruction !== undefined &&
			fn.instructionOpcodeName(sourceInstruction) === "createString")
	) {
		return { kind: "string-iterator-cursor", protocol: "string" };
	}
	const attributes =
		sourceInstruction === undefined ? {} : fn.instructionAttributes(sourceInstruction);
	const exactTypedArray = attributes.exactTypedArrayKind;
	const exactCollection = attributes.exactCollectionReceiver;
	const constructor =
		sourceInstruction !== undefined &&
		fn.instructionOpcodeName(sourceInstruction) === "construct"
			? fn.instructionOperands(sourceInstruction)[0]
			: undefined;
	const constructorDefinition =
		constructor === undefined
			? undefined
			: fn.valueDefinition(roots.get(constructor) ?? constructor);
	const intrinsic =
		constructorDefinition?.kind === "instruction" &&
		fn.instructionOpcodeName(constructorDefinition.instruction) === "loadIntrinsic"
			? fn.instructionAttributes(constructorDefinition.instruction).intrinsic
			: undefined;
	if (
		(typeof exactTypedArray === "string" &&
			NUMERIC_TYPED_ARRAY_INTRINSICS.has(exactTypedArray)) ||
		(typeof intrinsic === "string" && NUMERIC_TYPED_ARRAY_INTRINSICS.has(intrinsic))
	) {
		return {
			kind: "typed-array-iterator-cursor",
			protocol: "typed-array-values",
		};
	}
	if (exactCollection === "Map" || intrinsic === "Map") {
		return { kind: "map-iterator-cursor", protocol: "map" };
	}
	if (exactCollection === "Set" || intrinsic === "Set") {
		return { kind: "set-iterator-cursor", protocol: "set" };
	}
	return { kind: "array-values-iterator-cursor", protocol: "array-values" };
}

function iteratorCursorCandidates(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): ReadonlyArray<CoreIteratorCursorCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const stepsByIterator = new Map<CoreValueId, Array<CoreInstructionId>>();
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "iteratorStep" ||
			!control.reachable.has(fn.instructionBlock(instruction))
		)
			continue;
		const iterator = fn.instructionOperands(instruction)[0];
		if (iterator === undefined) continue;
		const steps = stepsByIterator.get(root(iterator)) ?? [];
		steps.push(instruction);
		stepsByIterator.set(root(iterator), steps);
	}
	const candidates: Array<CoreIteratorCursorCandidate> = [];
	for (const initialize of fn.instructionIds()) {
		if (
			fn.instructionKind(initialize) !== "operation" ||
			fn.instructionOpcodeName(initialize) !== "getIterator" ||
			fn.instructionOperands(initialize).length !== 1 ||
			fn.instructionResults(initialize).length !== 2 ||
			!control.reachable.has(fn.instructionBlock(initialize))
		)
			continue;
		const [iterator, next] = fn.instructionResults(initialize);
		const source = fn.instructionOperands(initialize)[0];
		if (iterator === undefined || next === undefined || source === undefined) continue;
		const steps = Object.freeze(
			(stepsByIterator.get(root(iterator)) ?? [])
				.filter((step) => root(fn.instructionOperands(step)[1]!) === root(next))
				.sort((left, right) => left - right),
		);
		if (steps.length === 0 || steps.length > 32) continue;
		const strategy = iteratorCursorKind(fn, roots, source);
		const instructions = Object.freeze([initialize, ...steps]);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		candidates.push(
			Object.freeze({
				key: `${strategy.kind}:${fn.id}:${initialize}:${steps.join(",")}`,
				kind: strategy.kind,
				function: fn.id,
				root: initialize,
				initialize,
				steps,
				protocol: strategy.protocol,
				exceptionalBlocks,
				instructions,
				fanOut: steps.length,
			}),
		);
	}
	return candidates;
}

function iteratorResultVirtualizationCandidates(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
): ReadonlyArray<CoreIteratorResultVirtualizationCandidate> {
	const steps = [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "iteratorStep" &&
			control.reachable.has(fn.instructionBlock(instruction)),
	);
	const candidates: Array<CoreIteratorResultVirtualizationCandidate> = [];
	for (let offset = 0; offset < steps.length; offset += 64) {
		const shard = Object.freeze(steps.slice(offset, offset + 64));
		if (shard.length === 0) continue;
		const exceptionalBlocks = Object.freeze([
			...new Set(
				shard.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		candidates.push(
			Object.freeze({
				key: `iterator-result-virtualization:${fn.id}:${shard[0]}`,
				kind: "iterator-result-virtualization",
				function: fn.id,
				root: shard[0]!,
				steps: shard,
				exceptionalBlocks,
				instructions: shard,
				fanOut: shard.length,
			}),
		);
	}
	return candidates;
}

function iteratorEntryPairVirtualizationCandidates(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreIteratorEntryPairVirtualizationCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const candidates: Array<CoreIteratorEntryPairVirtualizationCandidate> = [];
	for (const outerStep of fn.instructionIds()) {
		if (
			fn.instructionKind(outerStep) !== "operation" ||
			fn.instructionOpcodeName(outerStep) !== "iteratorStep" ||
			fn.instructionResults(outerStep).length !== 2 ||
			!control.reachable.has(fn.instructionBlock(outerStep))
		)
			continue;
		const outerOperands = fn.instructionOperands(outerStep);
		const cursorInitialize = specializationDefinition(fn, roots, outerOperands[0]!);
		if (
			cursorInitialize === undefined ||
			fn.instructionOpcodeName(cursorInitialize) !== "getIterator" ||
			root(fn.instructionResults(cursorInitialize)[1]!) !== root(outerOperands[1]!)
		)
			continue;
		const source = fn.instructionOperands(cursorInitialize)[0];
		const sourceDefinition =
			source === undefined ? undefined : specializationDefinition(fn, roots, source);
		const sourceAttributes =
			sourceDefinition === undefined ? {} : fn.instructionAttributes(sourceDefinition);
		const constructor =
			sourceDefinition !== undefined &&
			fn.instructionOpcodeName(sourceDefinition) === "construct"
				? fn.instructionOperands(sourceDefinition)[0]
				: undefined;
		const constructorDefinition =
			constructor === undefined
				? undefined
				: specializationDefinition(fn, roots, constructor);
		const intrinsic =
			constructorDefinition !== undefined &&
			fn.instructionOpcodeName(constructorDefinition) === "loadIntrinsic"
				? fn.instructionAttributes(constructorDefinition).intrinsic
				: undefined;
		if (
			sourceAttributes.exactCollectionReceiver !== "Map" &&
			sourceAttributes.exactCollectionReceiver !== "Set" &&
			intrinsic !== "Map" &&
			intrinsic !== "Set"
		)
			continue;
		const pair = fn.instructionResults(outerStep)[0]!;
		const pairUses = index.uses.get(root(pair)) ?? [];
		const innerInitialize =
			pairUses.length === 1 &&
			pairUses[0]?.position === 0 &&
			fn.instructionOpcodeName(pairUses[0].instruction) === "getIterator"
				? pairUses[0].instruction
				: undefined;
		if (
			innerInitialize === undefined ||
			fn.instructionResults(innerInitialize).length !== 2 ||
			!specializationInstructionDominates(control, index, outerStep, innerInitialize)
		)
			continue;
		const [innerIteratorValue, innerNextValue] = fn.instructionResults(innerInitialize);
		const innerIterator = root(innerIteratorValue!);
		const innerNext = root(innerNextValue!);
		const iteratorUses = index.uses.get(innerIterator) ?? [];
		const nextUses = index.uses.get(innerNext) ?? [];
		const innerSteps = iteratorUses
			.filter(
				({ instruction, position }) =>
					position === 0 &&
					fn.instructionOpcodeName(instruction) === "iteratorStep" &&
					root(fn.instructionOperands(instruction)[1]!) === innerNext,
			)
			.map(({ instruction }) => instruction);
		const innerCloses = iteratorUses
			.filter(
				({ instruction, position }) =>
					position === 0 && fn.instructionOpcodeName(instruction) === "iteratorClose",
			)
			.map(({ instruction }) => instruction)
			.sort((left, right) => left - right);
		if (
			innerSteps.length !== 2 ||
			innerCloses.length > 8 ||
			iteratorUses.length !== innerSteps.length + innerCloses.length ||
			nextUses.length !== innerSteps.length ||
			nextUses.some(
				({ instruction, position }) =>
					position !== 1 || !innerSteps.includes(instruction),
			)
		)
			continue;
		const orderedSteps = specializationInstructionDominates(
			control,
			index,
			innerSteps[0]!,
			innerSteps[1]!,
		)
			? ([innerSteps[0]!, innerSteps[1]!] as const)
			: specializationInstructionDominates(control, index, innerSteps[1]!, innerSteps[0]!)
				? ([innerSteps[1]!, innerSteps[0]!] as const)
				: undefined;
		if (orderedSteps === undefined) continue;
		const innerBlock = fn.instructionBlock(innerInitialize);
		const firstBlock = fn.instructionBlock(orderedSteps[0]);
		const secondBlock = fn.instructionBlock(orderedSteps[1]);
		const innerTerminator = fn.terminatorPayload(fn.blockTerminator(innerBlock));
		const firstTerminator = fn.terminatorPayload(fn.blockTerminator(firstBlock));
		const corridor = new Set([innerInitialize, ...orderedSteps]);
		const corridorBlocks = new Set([innerBlock, firstBlock, secondBlock]);
		if (
			[...corridorBlocks].some((block) =>
				[...fn.bodyInstructionIds(block)].some(
					(instruction) => !corridor.has(instruction),
				),
			) ||
			(innerBlock !== firstBlock &&
				(innerTerminator.kind !== "jump" || innerTerminator.edge.block !== firstBlock)) ||
			(firstBlock !== secondBlock &&
				(firstTerminator.kind !== "jump" ||
					firstTerminator.edge.block !== secondBlock)) ||
			innerCloses.some(
				(instruction) =>
					[...fn.bodyInstructionIds(fn.instructionBlock(instruction))].length !== 1,
			)
		)
			continue;
		const instructions = Object.freeze([
			cursorInitialize,
			outerStep,
			innerInitialize,
			...orderedSteps,
			...innerCloses,
		]);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		candidates.push(
			Object.freeze({
				key: `iterator-entry-pair-virtualization:${fn.id}:${outerStep}:${innerInitialize}`,
				kind: "iterator-entry-pair-virtualization",
				function: fn.id,
				root: outerStep,
				cursorInitialize,
				outerStep,
				innerInitialize,
				innerSteps: orderedSteps,
				innerCloses: Object.freeze(innerCloses),
				exceptionalBlocks,
				instructions,
				fanOut: instructions.length - 1,
			}),
		);
		if (candidates.length >= 8) break;
	}
	return candidates;
}

function stringSplitProjectionCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreStringSplitProjectionCandidate> {
	const candidates: Array<CoreStringSplitProjectionCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const call of fn.instructionIds()) {
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			fn.instructionOperands(call).length !== 3 ||
			fn.instructionResults(call).length !== 1 ||
			!control.reachable.has(fn.instructionBlock(call))
		)
			continue;
		const operands = fn.instructionOperands(call);
		const property = specializationDefinition(fn, roots, operands[0]!);
		const separator = specializationDefinition(fn, roots, operands[2]!);
		if (
			!staticPropertyNamed(program, fn, property, "split") ||
			fn.instructionOperands(property).length !== 1 ||
			root(fn.instructionOperands(property)[0]!) !== root(operands[1]!) ||
			!specializationInstructionDominates(control, index, property, call) ||
			separator === undefined ||
			fn.instructionOpcodeName(separator) !== "createString" ||
			!specializationInstructionDominates(control, index, separator, call)
		)
			continue;
		const separatorStringIndex = fn.instructionAttributes(separator).stringIndex;
		if (
			typeof separatorStringIndex !== "number" ||
			(decodeCoreString(program, separatorStringIndex)?.length ?? 0) === 0
		)
			continue;
		const propertyResult = fn.instructionResults(property)[0]!;
		const propertyUses = index.uses.get(root(propertyResult)) ?? [];
		if (
			propertyUses.length !== 1 ||
			propertyUses[0]?.instruction !== call ||
			propertyUses[0].position !== 0
		)
			continue;
		const result = fn.instructionResults(call)[0]!;
		const resultRoot = root(result);
		if (index.controlUses.has(resultRoot)) continue;
		const loads: Array<CoreStringSplitProjectionCandidate["loads"][number]> = [];
		const projectedIndices = new Set<number>();
		let lengthSeen = false;
		let safe = true;
		for (const use of index.uses.get(resultRoot) ?? []) {
			const consumer = use.instruction;
			const opcode = fn.instructionOpcodeName(consumer);
			if (
				(opcode === "move" || opcode === "throwIfTdz" || opcode === "rootUse") &&
				use.position === 0
			) {
				continue;
			}
			if (
				opcode === "loadPropertyStatic" &&
				use.position === 0 &&
				staticPropertyNamed(program, fn, consumer, "length") &&
				!lengthSeen &&
				specializationInstructionDominates(control, index, call, consumer)
			) {
				loads.push({ instruction: consumer, kind: "length" });
				lengthSeen = true;
				continue;
			}
			if (
				opcode === "loadProperty" &&
				use.position === 0 &&
				fn.instructionOperands(consumer).length === 2 &&
				specializationInstructionDominates(control, index, call, consumer)
			) {
				const key = specializationDefinition(
					fn,
					roots,
					fn.instructionOperands(consumer)[1]!,
				);
				const projected =
					key === undefined ? undefined : fn.instructionAttributes(key).value;
				if (
					key !== undefined &&
					fn.instructionOpcodeName(key) === "createNumber" &&
					typeof projected === "number" &&
					Number.isInteger(projected) &&
					projected >= 0 &&
					projected <= 0xffff &&
					!projectedIndices.has(projected) &&
					specializationInstructionDominates(control, index, key, consumer)
				) {
					loads.push({
						instruction: consumer,
						kind: "element",
						index: projected,
						key,
					});
					projectedIndices.add(projected);
					continue;
				}
			}
			safe = false;
			break;
		}
		if (!safe || projectedIndices.size === 0 || projectedIndices.size > 8) continue;
		loads.sort(
			(left, right) =>
				index.location.get(left.instruction)!.block -
					index.location.get(right.instruction)!.block ||
				index.location.get(left.instruction)!.index -
					index.location.get(right.instruction)!.index,
		);
		const instructions = Object.freeze([
			property,
			separator,
			call,
			...loads.flatMap((load) =>
				load.kind === "element" ? [load.key, load.instruction] : [load.instruction],
			),
		]);
		if (
			new Set(instructions).size !== instructions.length ||
			instructions.some((instruction) => {
				const block = fn.instructionBlock(instruction);
				return fn.blockHandler(block) !== undefined || index.handlerTargets.has(block);
			})
		)
			continue;
		const key = `string-split-projection:${fn.id}:${call}:${instructions.join(",")}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "string-split-projection",
				function: fn.id,
				root: call,
				property,
				call,
				separator,
				separatorStringIndex,
				resultValues: specializationResultValues(fn, roots, result),
				loads: Object.freeze(loads),
				instructions,
				fanOut: loads.length,
			}),
		);
	}
	return candidates;
}

function stringSliceNumberCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreStringSliceNumberCandidate> {
	const candidates: Array<CoreStringSliceNumberCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const sliceCall of fn.instructionIds()) {
		if (
			fn.instructionKind(sliceCall) !== "operation" ||
			fn.instructionOpcodeName(sliceCall) !== "call" ||
			fn.instructionOperands(sliceCall).length !== 3 ||
			fn.instructionResults(sliceCall).length !== 1 ||
			!control.reachable.has(fn.instructionBlock(sliceCall))
		)
			continue;
		const operands = fn.instructionOperands(sliceCall);
		const property = specializationDefinition(fn, roots, operands[0]!);
		const start = specializationDefinition(fn, roots, operands[2]!);
		if (
			!staticPropertyNamed(program, fn, property, "slice") ||
			root(fn.instructionOperands(property)[0]!) !== root(operands[1]!) ||
			!specializationInstructionDominates(control, index, property, sliceCall) ||
			start === undefined ||
			(fn.instructionOpcodeName(start) !== "createNumber" &&
				fn.instructionOpcodeName(start) !== "createF64") ||
			!specializationInstructionDominates(control, index, start, sliceCall)
		)
			continue;
		const sliceStart = fn.instructionAttributes(start).value;
		if (typeof sliceStart !== "number" || !Number.isFinite(sliceStart)) continue;
		const propertyUses = index.uses.get(root(fn.instructionResults(property)[0]!)) ?? [];
		const result = fn.instructionResults(sliceCall)[0]!;
		const sliceUses = (index.uses.get(root(result)) ?? []).filter(({ instruction }) => {
			const opcode = fn.instructionOpcodeName(instruction);
			return opcode !== "throwIfTdz" && opcode !== "rootUse";
		});
		if (
			propertyUses.length !== 1 ||
			propertyUses[0]?.instruction !== sliceCall ||
			propertyUses[0].position !== 0 ||
			sliceUses.length !== 1 ||
			sliceUses[0]?.position !== 2
		)
			continue;
		const numberCall = sliceUses[0].instruction;
		if (
			fn.instructionOpcodeName(numberCall) !== "call" ||
			fn.instructionOperands(numberCall).length !== 3 ||
			root(fn.instructionOperands(numberCall)[2]!) !== root(result)
		)
			continue;
		const numberIntrinsic = specializationDefinition(
			fn,
			roots,
			fn.instructionOperands(numberCall)[0]!,
		);
		if (
			numberIntrinsic === undefined ||
			fn.instructionOpcodeName(numberIntrinsic) !== "loadIntrinsic" ||
			fn.instructionAttributes(numberIntrinsic).intrinsic !== "Number" ||
			!specializationInstructionDominates(control, index, numberIntrinsic, numberCall)
		)
			continue;
		const instructions = Object.freeze([
			property,
			sliceCall,
			start,
			numberIntrinsic,
			numberCall,
		]);
		if (new Set(instructions).size !== instructions.length) continue;
		const ordinaryBlocks = new Set(
			instructions.map((instruction) => fn.instructionBlock(instruction)),
		);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		if (exceptionalBlocks.some((block) => ordinaryBlocks.has(block))) continue;
		const key = `string-slice-number:${fn.id}:${sliceCall}:${numberCall}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "string-slice-number",
				function: fn.id,
				root: sliceCall,
				property,
				sliceCall,
				sliceStartInstruction: start,
				numberIntrinsic,
				numberCall,
				sliceStart,
				exceptionalBlocks,
				instructions,
				fanOut: 1,
			}),
		);
	}
	return candidates;
}

function regexpExecProjectionCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreRegExpExecProjectionCandidate> {
	const candidates: Array<CoreRegExpExecProjectionCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const semanticUses = (
		value: CoreValueId,
	): ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly position: number;
	}> =>
		(index.uses.get(root(value)) ?? []).filter(({ instruction, position }) => {
			const opcode = fn.instructionOpcodeName(instruction);
			return !(
				position === 0 &&
				(opcode === "throwIfTdz" ||
					opcode === "rootUse" ||
					(opcode === "move" &&
						fn.instructionResults(instruction)[0] !== undefined &&
						root(fn.instructionResults(instruction)[0]!) === root(value)))
			);
		});
	for (const call of fn.instructionIds()) {
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			fn.instructionOperands(call).length !== 3 ||
			fn.instructionResults(call).length !== 1 ||
			!control.reachable.has(fn.instructionBlock(call))
		)
			continue;
		const operands = fn.instructionOperands(call);
		const property = specializationDefinition(fn, roots, operands[0]!);
		if (
			!staticPropertyNamed(program, fn, property, "exec") ||
			fn.instructionOperands(property).length !== 1 ||
			fn.instructionResults(property).length !== 1 ||
			root(fn.instructionOperands(property)[0]!) !== root(operands[1]!) ||
			!specializationInstructionDominates(control, index, property, call)
		)
			continue;
		const propertyUses = index.uses.get(root(fn.instructionResults(property)[0]!)) ?? [];
		if (
			propertyUses.length !== 1 ||
			propertyUses[0]?.instruction !== call ||
			propertyUses[0].position !== 0
		)
			continue;
		const result = fn.instructionResults(call)[0]!;
		const resultRoot = root(result);
		if (index.controlUses.has(resultRoot)) continue;
		const nullChecks: Array<CoreRegExpExecProjectionCandidate["nullChecks"][number]> = [];
		type MutableLoad = Omit<
			CoreRegExpExecProjectionCandidate["loads"][number],
			"consumer"
		> & {
			consumer?: CoreRegExpExecProjectionCandidate["loads"][number]["consumer"];
		};
		const loads: Array<MutableLoad> = [];
		const captureIndices = new Set<number>();
		let safe = true;
		for (const use of index.uses.get(resultRoot) ?? []) {
			const consumer = use.instruction;
			const opcode = fn.instructionOpcodeName(consumer);
			if (
				(opcode === "move" || opcode === "throwIfTdz" || opcode === "rootUse") &&
				use.position === 0
			) {
				continue;
			}
			if (
				opcode === "binary" &&
				(fn.instructionAttributes(consumer).operator === "===" ||
					fn.instructionAttributes(consumer).operator === "!==")
			) {
				const other = fn.instructionOperands(consumer)[use.position === 0 ? 1 : 0];
				const nullValue =
					other === undefined ? undefined : specializationDefinition(fn, roots, other);
				if (
					nullValue !== undefined &&
					fn.instructionOpcodeName(nullValue) === "createNull" &&
					specializationInstructionDominates(control, index, nullValue, consumer)
				) {
					nullChecks.push({ comparison: consumer, nullValue });
					continue;
				}
			}
			if (
				opcode === "loadProperty" &&
				use.position === 0 &&
				fn.instructionOperands(consumer).length === 2 &&
				fn.instructionResults(consumer).length === 1 &&
				specializationInstructionDominates(control, index, call, consumer)
			) {
				const key = specializationDefinition(
					fn,
					roots,
					fn.instructionOperands(consumer)[1]!,
				);
				const captureIndex =
					key === undefined ? undefined : fn.instructionAttributes(key).value;
				if (
					key !== undefined &&
					fn.instructionOpcodeName(key) === "createNumber" &&
					typeof captureIndex === "number" &&
					Number.isInteger(captureIndex) &&
					captureIndex > 0 &&
					captureIndex <= 0xffff &&
					!captureIndices.has(captureIndex) &&
					specializationInstructionDominates(control, index, key, consumer)
				) {
					loads.push({ instruction: consumer, key, captureIndex });
					captureIndices.add(captureIndex);
					continue;
				}
			}
			safe = false;
			break;
		}
		if (!safe || loads.length === 0 || loads.length > 8) continue;

		for (const load of loads) {
			const capture = root(fn.instructionResults(load.instruction)[0]!);
			const captureUses = semanticUses(capture);
			if (captureUses.length === 1) {
				const consumer = captureUses[0]!.instruction;
				if (
					captureUses[0]!.position === 0 &&
					staticPropertyNamed(program, fn, consumer, "length") &&
					fn.instructionOperands(consumer).length === 1
				) {
					load.consumer = { kind: "length", property: consumer };
					continue;
				}
				if (
					fn.instructionOpcodeName(consumer) === "call" &&
					captureUses[0]!.position === 2 &&
					fn.instructionOperands(consumer).length === 3
				) {
					const intrinsic = specializationDefinition(
						fn,
						roots,
						fn.instructionOperands(consumer)[0]!,
					);
					if (
						intrinsic !== undefined &&
						fn.instructionOpcodeName(intrinsic) === "loadIntrinsic" &&
						fn.instructionAttributes(intrinsic).intrinsic === "Number" &&
						specializationInstructionDominates(control, index, intrinsic, consumer)
					) {
						load.consumer = { kind: "number", intrinsic, call: consumer };
						continue;
					}
				}
			}
			if (captureUses.length !== 2) continue;
			const upperPropertyUse = captureUses.find(
				({ instruction, position }) =>
					position === 0 && staticPropertyNamed(program, fn, instruction, "toUpperCase"),
			);
			const upperCallUse = captureUses.find(
				({ instruction, position }) =>
					fn.instructionOpcodeName(instruction) === "call" && position === 1,
			);
			const upperProperty = upperPropertyUse?.instruction;
			const upperCall = upperCallUse?.instruction;
			if (
				upperProperty !== undefined &&
				upperCall !== undefined &&
				fn.instructionOpcodeName(upperCall) === "call" &&
				fn.instructionOperands(upperCall).length === 2 &&
				root(fn.instructionOperands(upperCall)[0]!) ===
					root(fn.instructionResults(upperProperty)[0]!) &&
				(index.uses.get(root(fn.instructionResults(upperProperty)[0]!))?.length ?? 0) ===
					1
			) {
				const upperResult = root(fn.instructionResults(upperCall)[0]!);
				const upperUses = semanticUses(upperResult);
				const lowerPropertyUse = upperUses.find(
					({ instruction, position }) =>
						position === 0 &&
						staticPropertyNamed(program, fn, instruction, "toLowerCase"),
				);
				const lowerCallUse = upperUses.find(
					({ instruction, position }) =>
						fn.instructionOpcodeName(instruction) === "call" && position === 1,
				);
				const lowerProperty = lowerPropertyUse?.instruction;
				const lowerCall = lowerCallUse?.instruction;
				if (
					upperUses.length === 2 &&
					lowerProperty !== undefined &&
					lowerCall !== undefined &&
					fn.instructionOpcodeName(lowerCall) === "call" &&
					fn.instructionOperands(lowerCall).length === 2 &&
					root(fn.instructionOperands(lowerCall)[0]!) ===
						root(fn.instructionResults(lowerProperty)[0]!) &&
					(index.uses.get(root(fn.instructionResults(lowerProperty)[0]!))?.length ??
						0) === 1
				) {
					const lowerUses = semanticUses(fn.instructionResults(lowerCall)[0]!);
					const lengthProperty = lowerUses[0]?.instruction;
					if (
						lowerUses.length === 1 &&
						lowerUses[0]?.position === 0 &&
						staticPropertyNamed(program, fn, lengthProperty, "length")
					) {
						load.consumer = {
							kind: "asciiCaseLength",
							upperProperty,
							upperCall,
							lowerProperty,
							lowerCall,
							resultMoves: Object.freeze([]),
							lengthProperty,
						};
						continue;
					}
				}
			}
			const propertyUse = captureUses.find(
				({ instruction, position }) =>
					position === 0 && staticPropertyNamed(program, fn, instruction, "charCodeAt"),
			);
			const callUse = captureUses.find(
				({ instruction, position }) =>
					fn.instructionOpcodeName(instruction) === "call" && position === 1,
			);
			const charProperty = propertyUse?.instruction;
			const charCall = callUse?.instruction;
			if (
				charProperty === undefined ||
				charCall === undefined ||
				fn.instructionOpcodeName(charCall) !== "call" ||
				fn.instructionOperands(charCall).length !== 3 ||
				root(fn.instructionOperands(charCall)[0]!) !==
					root(fn.instructionResults(charProperty)[0]!) ||
				(index.uses.get(root(fn.instructionResults(charProperty)[0]!))?.length ?? 0) !== 1
			)
				continue;
			const zero = specializationDefinition(
				fn,
				roots,
				fn.instructionOperands(charCall)[2]!,
			);
			if (
				zero !== undefined &&
				fn.instructionOpcodeName(zero) === "createNumber" &&
				Object.is(fn.instructionAttributes(zero).value, 0)
			) {
				load.consumer = {
					kind: "charCodeAtZero",
					property: charProperty,
					call: charCall,
					zero,
				};
			}
		}

		let lockedLiteral: CoreRegExpExecProjectionCandidate["lockedLiteral"];
		const construct = specializationDefinition(fn, roots, operands[1]!);
		if (
			construct !== undefined &&
			fn.instructionOpcodeName(construct) === "construct" &&
			fn.instructionResults(construct).length === 1
		) {
			const receiverUses =
				index.uses.get(root(fn.instructionResults(construct)[0]!)) ?? [];
			const constructorIntrinsic = specializationDefinition(
				fn,
				roots,
				fn.instructionOperands(construct)[0]!,
			);
			if (
				receiverUses.length === 2 &&
				receiverUses.every(
					({ instruction }) => instruction === property || instruction === call,
				) &&
				constructorIntrinsic !== undefined &&
				fn.instructionOpcodeName(constructorIntrinsic) === "loadIntrinsic" &&
				fn.instructionAttributes(constructorIntrinsic).intrinsic === "RegExp" &&
				specializationInstructionDominates(
					control,
					index,
					constructorIntrinsic,
					construct,
				) &&
				specializationInstructionDominates(control, index, construct, call)
			) {
				lockedLiteral = { constructorIntrinsic, construct };
			}
		}

		const claimed = new Set<CoreInstructionId>([property, call]);
		for (const { comparison, nullValue } of nullChecks) {
			claimed.add(comparison);
			claimed.add(nullValue);
		}
		for (const load of loads) {
			claimed.add(load.key);
			claimed.add(load.instruction);
			const consumer = load.consumer;
			if (consumer?.kind === "length") claimed.add(consumer.property);
			else if (consumer?.kind === "number") {
				claimed.add(consumer.intrinsic);
				claimed.add(consumer.call);
			} else if (consumer?.kind === "charCodeAtZero") {
				claimed.add(consumer.property);
				claimed.add(consumer.call);
				if (consumer.zero !== undefined) claimed.add(consumer.zero);
			} else if (consumer?.kind === "asciiCaseLength") {
				claimed.add(consumer.upperProperty);
				claimed.add(consumer.upperCall);
				claimed.add(consumer.lowerProperty);
				claimed.add(consumer.lowerCall);
				for (const move of consumer.resultMoves) claimed.add(move);
				claimed.add(consumer.lengthProperty);
			}
		}
		const instructions = Object.freeze([...claimed]);
		if (
			instructions.length > 96 ||
			instructions.some((instruction) => {
				const block = fn.instructionBlock(instruction);
				return fn.blockHandler(block) !== undefined || index.handlerTargets.has(block);
			})
		)
			continue;
		loads.sort(
			(left, right) =>
				index.location.get(left.instruction)!.block -
					index.location.get(right.instruction)!.block ||
				index.location.get(left.instruction)!.index -
					index.location.get(right.instruction)!.index,
		);
		const key = `regexp-exec-projection:${fn.id}:${call}:${instructions.join(",")}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "regexp-exec-projection",
				function: fn.id,
				root: call,
				property,
				call,
				resultValues: specializationResultValues(fn, roots, result),
				nullChecks: Object.freeze(nullChecks),
				...(lockedLiteral === undefined ? {} : { lockedLiteral }),
				loads: Object.freeze(loads),
				instructions,
				fanOut: loads.length + nullChecks.length,
			}),
		);
	}
	return candidates;
}

function regexpIteratorProjectionCandidates(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalSpecializationIndex,
): ReadonlyArray<CoreRegExpIteratorProjectionCandidate> {
	const candidates: Array<CoreRegExpIteratorProjectionCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const block of fn.blockIds()) {
		if (!control.reachable.has(block)) continue;
		const instructions = [...fn.bodyInstructionIds(block)];
		const step = instructions.at(-1);
		const doneBranch = fn.blockTerminator(block);
		const branch = fn.terminatorPayload(doneBranch);
		if (
			step === undefined ||
			fn.instructionOpcodeName(step) !== "iteratorStep" ||
			fn.instructionOperands(step).length !== 2 ||
			fn.instructionResults(step).length !== 2 ||
			branch.kind !== "branch" ||
			root(branch.condition) !== root(fn.instructionResults(step)[1]!) ||
			branch.consequent.block === block
		)
			continue;
		const result = fn.instructionResults(step)[0]!;
		const resultRoot = root(result);
		if (index.controlUses.has(resultRoot)) continue;
		const loads: Array<CoreRegExpIteratorProjectionCandidate["loads"][number]> = [];
		const captureIndices = new Set<number>();
		let safe = true;
		for (const use of index.uses.get(resultRoot) ?? []) {
			const capture = use.instruction;
			const opcode = fn.instructionOpcodeName(capture);
			if (
				(opcode === "move" || opcode === "throwIfTdz" || opcode === "rootUse") &&
				use.position === 0
			) {
				continue;
			}
			if (
				opcode !== "loadProperty" ||
				use.position !== 0 ||
				fn.instructionOperands(capture).length !== 2 ||
				fn.instructionResults(capture).length !== 1 ||
				!specializationInstructionDominates(control, index, step, capture)
			) {
				safe = false;
				break;
			}
			const key = specializationDefinition(
				fn,
				roots,
				fn.instructionOperands(capture)[1]!,
			);
			const captureIndex =
				key === undefined ? undefined : fn.instructionAttributes(key).value;
			const captureUses = index.uses.get(root(fn.instructionResults(capture)[0]!)) ?? [];
			const numberUse = captureUses[0];
			const numberCall = numberUse?.instruction;
			const numberIntrinsic =
				numberCall === undefined
					? undefined
					: specializationDefinition(fn, roots, fn.instructionOperands(numberCall)[0]!);
			if (
				key === undefined ||
				fn.instructionOpcodeName(key) !== "createNumber" ||
				typeof captureIndex !== "number" ||
				!Number.isInteger(captureIndex) ||
				captureIndex <= 0 ||
				captureIndex > 0xffff ||
				captureIndices.has(captureIndex) ||
				captureUses.length !== 1 ||
				numberUse?.position !== 2 ||
				numberCall === undefined ||
				fn.instructionOpcodeName(numberCall) !== "call" ||
				fn.instructionOperands(numberCall).length !== 3 ||
				root(fn.instructionOperands(numberCall)[2]!) !==
					root(fn.instructionResults(capture)[0]!) ||
				numberIntrinsic === undefined ||
				fn.instructionOpcodeName(numberIntrinsic) !== "loadIntrinsic" ||
				fn.instructionAttributes(numberIntrinsic).intrinsic !== "Number" ||
				!specializationInstructionDominates(control, index, key, capture) ||
				!specializationInstructionDominates(control, index, numberIntrinsic, numberCall)
			) {
				safe = false;
				break;
			}
			captureIndices.add(captureIndex);
			loads.push({
				instruction: capture,
				key,
				captureIndex,
				numberIntrinsic,
				numberCall,
			});
		}
		if (!safe || loads.length === 0 || loads.length > 8) continue;
		loads.sort(
			(left, right) =>
				index.location.get(left.instruction)!.block -
					index.location.get(right.instruction)!.block ||
				index.location.get(left.instruction)!.index -
					index.location.get(right.instruction)!.index,
		);
		const claimed = new Set<CoreInstructionId>([step, doneBranch]);
		for (const load of loads) {
			claimed.add(load.key);
			claimed.add(load.instruction);
			claimed.add(load.numberIntrinsic);
			claimed.add(load.numberCall);
		}
		const claimedInstructions = Object.freeze([...claimed]);
		const ordinaryBlocks = new Set(
			claimedInstructions.map((instruction) => fn.instructionBlock(instruction)),
		);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				claimedInstructions.flatMap((instruction) => {
					const handler = fn.blockHandler(fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler.block];
				}),
			),
		]);
		if (exceptionalBlocks.some((handler) => ordinaryBlocks.has(handler))) continue;
		const key = `regexp-iterator-projection:${fn.id}:${step}:${doneBranch}`;
		candidates.push(
			Object.freeze({
				key,
				kind: "regexp-iterator-projection",
				function: fn.id,
				root: step,
				step,
				doneBranch,
				exitBlock: branch.consequent.block,
				resultValues: specializationResultValues(fn, roots, result),
				exceptionalBlocks,
				loads: Object.freeze(loads),
				instructions: claimedInstructions,
				fanOut: loads.length,
			}),
		);
	}
	return candidates;
}

function discoverCandidates(
	program: CoreProgram,
	functionId: CoreFunctionId,
	provenanceAnalysis: CoreProvenance,
	control: CoreControlFlow,
	loops: CoreLoopInductionAnalysis,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreLocalSpecializationCandidates {
	const fn = program.function(functionId);
	const candidates = new Map<string, CoreLocalSpecializationCandidate>();
	const index = localSpecializationIndex(fn, roots);
	const addNumeric = (
		root: CoreInstructionId,
		instructions: ReadonlyArray<CoreInstructionId>,
	): void => {
		const stableInstructions = Object.freeze([...new Set(instructions)]);
		const key = `numeric-fusion:${functionId}:${root}:${stableInstructions.join(",")}`;
		if (candidates.has(key)) return;
		candidates.set(
			key,
			Object.freeze({
				key,
				kind: "numeric-fusion",
				function: functionId,
				root,
				instructions: stableInstructions,
				fanOut: Math.max(0, stableInstructions.length - 1),
			}),
		);
	};
	for (const layout of provenanceAnalysis.layouts) {
		if (layout.kind === "named-slots") {
			const candidate = stackObjectCandidate(fn, layout, control, roots);
			if (candidate !== undefined) candidates.set(candidate.key, candidate);
		} else {
			const dense = denseArrayCandidates(fn, layout, control, roots);
			for (const candidate of dense) {
				candidates.set(candidate.key, candidate);
			}
			if (
				dense.length === 0 &&
				provenanceAnalysis.escape(layout.instruction) === "contained"
			) {
				const instructions = Object.freeze(
					[
						layout.instruction,
						...[...fn.uses(layout.result)].map(({ instruction }) => instruction),
					].filter((instruction, index, all) => all.indexOf(instruction) === index),
				);
				const candidate = Object.freeze({
					key: `dense-array:${fn.id}:${layout.instruction}:contained`,
					kind: "dense-array" as const,
					mode: "contained" as const,
					function: fn.id,
					root: layout.instruction,
					allocation: layout.instruction,
					instructions,
					fanOut: Math.max(0, instructions.length - 1),
				});
				candidates.set(candidate.key, candidate);
			}
		}
	}
	for (const candidate of [
		...freshArrayLengthCandidates(program, fn, provenanceAnalysis, control, roots, index),
		...indexedLengthLoopCandidates(program, fn, control, roots, index),
		...iteratorCursorCandidates(fn, control, roots),
		...iteratorResultVirtualizationCandidates(fn, control),
		...iteratorEntryPairVirtualizationCandidates(fn, control, roots, index),
		...stringCharCodeAtCandidates(program, fn, control, loops, roots, index),
		...functionCallChainCandidates(program, fn, control, roots, index),
		...stringSplitCursorCandidates(program, fn, control, loops, roots, index),
		...builtinCollectionCallCandidates(program, fn, control, roots, index),
		...stringSplitProjectionCandidates(program, fn, control, roots, index),
		...stringSliceNumberCandidates(program, fn, control, roots, index),
		...regexpExecProjectionCandidates(program, fn, control, roots, index),
		...regexpIteratorProjectionCandidates(fn, control, roots, index),
	]) {
		candidates.set(candidate.key, candidate);
	}
	const numericOpcodes = new Set(["binary"]);
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			!numericOpcodes.has(fn.instructionOpcodeName(instruction)) ||
			!control.reachable.has(fn.instructionBlock(instruction)) ||
			!coreTargetSupportsNumericFusionOperator(
				fn.instructionAttributes(instruction).operator,
				"start",
			)
		)
			continue;
		const output = fn.instructionResults(instruction)[0];
		if (
			output === undefined ||
			fn.valueRepresentation(output) !== "boxed" ||
			index.controlUses.has(roots.get(output) ?? output)
		)
			continue;
		const uses = [...fn.uses(output)];
		if (uses.length !== 1) continue;
		const user = uses[0]!.instruction;
		const startLocation = index.location.get(instruction);
		const finishLocation = index.location.get(user);
		if (
			fn.instructionKind(user) !== "operation" ||
			!numericOpcodes.has(fn.instructionOpcodeName(user)) ||
			!control.reachable.has(fn.instructionBlock(user)) ||
			fn.instructionOperands(user).filter((operand) => operand === output).length !== 1 ||
			startLocation === undefined ||
			finishLocation === undefined ||
			startLocation.block !== finishLocation.block ||
			startLocation.index >= finishLocation.index ||
			!coreTargetSupportsNumericFusionOperator(
				fn.instructionAttributes(user).operator,
				"finish",
			)
		)
			continue;
		addNumeric(instruction, [instruction, user]);
	}
	const values = Object.freeze([...candidates.values()]);
	return Object.freeze({
		candidates: values,
		largestFanOut: values.reduce(
			(largest, candidate) => Math.max(largest, candidate.fanOut),
			0,
		),
	});
}

export function discoverCoreLocalSpecializationCandidates(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreLocalSpecializationCandidates {
	const fn = program.function(functionId);
	const control = buildCoreControlFlow(program, functionId, { exceptions: true });
	const roots = coreCanonicalValueRoots(fn, control);
	const valueKinds = analyzeCoreValueKinds(fn, control);
	return discoverCandidates(
		program,
		functionId,
		provenance(program, fn, control, { canonicalRoots: roots }),
		control,
		analyzeCoreLoopInductions(fn, control, roots, (value) =>
			valueKinds.exactScalar(value),
		),
		roots,
	);
}

export const CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS: CoreAnalysisDefinition<CoreLocalSpecializationCandidates> =
	{
		key: "local-specialization-candidates",
		scope: "function",
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"memoryEffects",
			"representations",
			"specializationInputs",
		],
		programDependencies: ["data"],
		compute({ program, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return discoverCandidates(
				program,
				request.function,
				get(CORE_LOCAL_PROVENANCE_ANALYSIS, request),
				get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request),
				get(CORE_LOOP_INDUCTION_ANALYSIS, request),
				get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request),
			);
		},
	};
