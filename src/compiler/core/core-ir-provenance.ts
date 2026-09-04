import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
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
import { analyzeCoreValueClasses } from "./core-ir-value-classes.ts";
import type {
	CoreExactCollectionBrand,
	CoreValueClassAnalysis,
} from "./core-ir-value-classes.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	analyzeCoreValueKinds,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreFunctionId } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreOpcodeAccess,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

function instructionOperandCount(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number {
	return fn.kernel.instructionOperandCount(instruction);
}

function instructionOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index < 0 || index >= fn.kernel.instructionOperandCount(instruction)) {
		return undefined;
	}
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function instructionResultCount(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number {
	return fn.kernel.instructionResultCount(instruction);
}

function instructionResult(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index < 0 || index >= fn.kernel.instructionResultCount(instruction)) {
		return undefined;
	}
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + index);
}

function definingInstruction(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? (fn.kernel.valueDefinitionOwner(value) as CoreInstructionId)
		: undefined;
}

function handlerBlock(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): CoreBlockId | undefined {
	return fn.kernel.blockHandlerBlock(block);
}

export const CORE_OWN_DATA_CELL_FACT = "own-data-cell";
export const CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT = "contained-aggregate-own-slot";

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
	readonly index?: CoreLocalFactIndex;
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
	const definition = definingInstruction(fn, value);
	if (definition === undefined || fn.instructionKind(definition) !== "operation")
		return undefined;
	const opcode = fn.instructionOpcodeName(definition);
	const immediate = fn.instructionAttributes(definition).value;
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

type CoreOwnCellResolve = (index: number) => CoreOwnCell | undefined;

const ownCellResolvers = new WeakMap<
	ReadonlyArray<ReadonlyArray<number>>,
	{ readonly length: number; readonly resolve: CoreOwnCellResolve }
>();

function codeUnitsEqual(
	left: ReadonlyArray<number>,
	right: ReadonlyArray<number>,
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export function coreOwnCellResolver(
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): CoreOwnCellResolve {
	const cached = ownCellResolvers.get(stringConstants);
	if (cached?.length === stringConstants.length) return cached.resolve;
	const canonicalByHash = new Map<number, number | Array<number>>();
	const canonicalByIndex = new Int32Array(stringConstants.length);
	canonicalByIndex.fill(-1);
	for (const [index, units] of stringConstants.entries()) {
		let hash = 2_166_136_261;
		for (const unit of units) hash = Math.imul(hash ^ unit, 16_777_619) >>> 0;
		hash = Math.imul(hash ^ units.length, 16_777_619) >>> 0;
		const bucket = canonicalByHash.get(hash);
		let canonical = index;
		if (typeof bucket === "number" && codeUnitsEqual(stringConstants[bucket]!, units)) {
			canonical = bucket;
		} else if (Array.isArray(bucket)) {
			for (const candidate of bucket) {
				if (!codeUnitsEqual(stringConstants[candidate]!, units)) continue;
				canonical = candidate;
				break;
			}
		}
		if (canonical === index) {
			canonicalByHash.set(
				hash,
				bucket === undefined
					? index
					: Array.isArray(bucket)
						? [...bucket, index]
						: [bucket, index],
			);
		}
		canonicalByIndex[index] = canonical;
	}
	const resolve = (index: number): CoreOwnCell | undefined => {
		if (!Number.isSafeInteger(index) || index < 0) return undefined;
		const canonical = canonicalByIndex[index] ?? -1;
		const normalized = canonical < 0 ? index : canonical;
		const element = canonicalArrayIndex(stringConstants[normalized]);
		return element === undefined
			? { kind: "object-slot", key: normalized }
			: { kind: "element", index: element };
	};
	ownCellResolvers.set(stringConstants, { length: stringConstants.length, resolve });
	return resolve;
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
		const value = instructionOperand(fn, instruction, access.keyOperand);
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
	const result = instructionResult(fn, instruction, 0);
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
			const operandCount = instructionOperandCount(fn, candidate);
			const baseUses: Array<number> = [];
			for (let operandIndex = 0; operandIndex < operandCount; operandIndex++) {
				if (instructionOperand(fn, candidate, operandIndex) === result) {
					baseUses.push(operandIndex);
				}
			}
			if (baseUses.length === 0) continue;
			const opcode = fn.instructionOpcodeName(candidate);
			if (opcode === "throwIfTdz" && baseUses.length === 1 && baseUses[0] === 0) continue;
			if (opcode !== "defineProperty" || baseUses.length !== 1 || baseUses[0] !== 0)
				break;
			const indexOperand = instructionOperand(fn, candidate, 1);
			const index =
				indexOperand === undefined ? undefined : literalArrayIndex(fn, indexOperand);
			const value = instructionOperand(fn, candidate, 2);
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
	const valueCount =
		instructionOperandCount(fn, instruction) - allocation.firstValueOperand;
	if (valueCount !== keys.length) return undefined;
	const values = new Array<CoreValueId>(valueCount);
	for (let index = 0; index < valueCount; index++) {
		values[index] = instructionOperand(
			fn,
			instruction,
			allocation.firstValueOperand + index,
		)!;
	}
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

export function buildCoreProvenance(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	options: CoreProvenanceOptions = {},
): CoreProvenance {
	const roots = options.canonicalRoots ?? coreCanonicalValueRoots(fn, cfg);
	const index = options.index ?? buildCoreLocalFactIndex(fn, roots);
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const layouts = index.operations
		.map((instruction) => allocationLayout(fn, instruction))
		.filter((layout): layout is CoreAllocationLayout => layout !== undefined);
	const layoutByRoot = new Map<CoreValueId, CoreAllocationLayout | null>();
	for (const layout of layouts) {
		const valueRoot = root(layout.result);
		layoutByRoot.set(valueRoot, layoutByRoot.has(valueRoot) ? null : layout);
	}
	let valueQueries = 0;
	const allocationOf = (value: CoreValueId): CoreAllocationLayout | undefined => {
		valueQueries++;
		return layoutByRoot.get(root(value)) ?? undefined;
	};
	const cellForString = coreOwnCellResolver(program.stringConstants);
	const keyCells = new Map<CoreValueId, CoreOwnCell | null>();
	const cellForValue = (value: CoreValueId): CoreOwnCell | undefined => {
		const valueRoot = root(value);
		const cached = keyCells.get(valueRoot);
		if (cached !== undefined || keyCells.has(valueRoot)) return cached ?? undefined;
		const definition = definingInstruction(fn, valueRoot);
		if (definition === undefined || fn.instructionKind(definition) !== "operation") {
			keyCells.set(valueRoot, null);
			return undefined;
		}
		const opcode = fn.instructionOpcodeName(definition);
		const immediate = fn.instructionAttributes(definition);
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
		keyCells.set(valueRoot, cell ?? null);
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

	const escaped = new Set<CoreInstructionId>();
	for (const layout of layouts) {
		const valueRoot = root(layout.result);
		if (layoutByRoot.get(valueRoot) !== layout) continue;
		if (index.controlUses.has(valueRoot)) escaped.add(layout.instruction);
		for (const { instruction, position: operand } of index.uses.get(valueRoot) ?? []) {
			if (fn.instructionKind(instruction) !== "operation") {
				escaped.add(layout.instruction);
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				opcode === "move" ||
				opcode === "throwIfTdz" ||
				opcode === "rootUse" ||
				observesWithoutRetention(fn, instruction)
			) {
				continue;
			}
			const access = baseAccessForOperand(fn, instruction, operand);
			const key = access === undefined ? undefined : accessKey(fn, instruction, access);
			const cell = key === undefined ? undefined : cellForKey(key);
			if (
				access === undefined ||
				cell === undefined ||
				!cellBelongs(layout, cell, access.mode)
			) {
				escaped.add(layout.instruction);
			}
		}
	}
	const escape = (allocation: CoreInstructionId): CoreAllocationEscape =>
		escaped.has(allocation) ? "escaped" : "contained";
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
		const definition = definingInstruction(fn, root(value));
		return (
			definition !== undefined &&
			fn.instructionKind(definition) === "operation" &&
			fn.registry.byId(fn.instructionOpcode(definition)).resultCannotBeHeldWeakly === true
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
	return buildCoreProvenance(
		program,
		fn,
		buildCoreControlFlow(program, functionId),
		options,
	);
}

export const coreProvenance = analyzeCoreProvenance;

export interface CoreLocalFactBundle {
	readonly function: CoreFunctionId;
	readonly control: CoreControlFlow;
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly index: CoreLocalFactIndex;
	readonly valueKinds: CoreValueKindAnalysis;
	readonly provenance: CoreProvenance;
	readonly valueClasses: CoreValueClassAnalysis;
}

export const CORE_LOCAL_FACT_BUNDLE_ANALYSIS: CoreAnalysisDefinition<CoreLocalFactBundle> =
	{
		key: "local-fact-bundle",
		scope: "function",
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"facts",
			"memoryEffects",
			"representations",
			"specializationInputs",
		],
		programDependencies: ["data"],
		contextIdentity: (context) => context.facts.world.primordialPolicy,
		compute({ program, context, request, get, runOwner }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			const functionId = request.function;
			const fn = program.function(functionId);
			const control = get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional();
			const roots = get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request);
			let localIndex: CoreLocalFactIndex | undefined;
			let valueKindAnalysis: CoreValueKindAnalysis | undefined;
			let provenanceAnalysis: CoreProvenance | undefined;
			let valueClassAnalysis: CoreValueClassAnalysis | undefined;
			const index = (): CoreLocalFactIndex =>
				(localIndex ??= runOwner(
					CORE_OPTIMIZATION_OWNER.localFactAndProvenanceConstruction,
					() => buildCoreLocalFactIndex(fn, roots),
				));
			return Object.freeze({
				function: functionId,
				control,
				roots,
				get index() {
					return index();
				},
				get valueKinds() {
					return (valueKindAnalysis ??= get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request));
				},
				get provenance() {
					return (provenanceAnalysis ??= runOwner(
						CORE_OPTIMIZATION_OWNER.localFactAndProvenanceConstruction,
						() =>
							buildCoreProvenance(program, fn, control, {
								canonicalRoots: roots,
								index: index(),
							}),
					));
				},
				get valueClasses() {
					return (valueClassAnalysis ??= runOwner(
						CORE_OPTIMIZATION_OWNER.localFactAndProvenanceConstruction,
						() => analyzeCoreValueClasses(program, functionId, context, roots, index()),
					));
				},
			});
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
			for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ??
				[]) {
				if (access.baseOperand === undefined) continue;
				const base = instructionOperand(fn, instruction, access.baseOperand);
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
	readonly property?: CoreInstructionId;
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
	readonly property?: CoreInstructionId;
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
	index: CoreLocalFactIndex,
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
		const handlerArgumentStart = fn.kernel.blockHandlerArgumentStart(block);
		const handlerArgumentCount = fn.kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerArgumentCount; index++) {
			if (aliasesAllocation(fn.kernel.handlerArgumentAt(handlerArgumentStart + index))) {
				return undefined;
			}
		}
		const incoming = control.predecessors[block] ?? [];
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const parameter = fn.kernel.blockParameterValue(parameterStart + index);
			if (aliasesAllocation(parameter)) continue;
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
	for (const { instruction, position } of index.uses.get(allocationRoot) ?? []) {
		if (!control.reachable.has(fn.instructionBlock(instruction))) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operator = fn.instructionAttributes(instruction).operator;
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
				typeof stringIndex === "number" ? slotByStringIndex.get(stringIndex) : undefined;
			if (slot === undefined) return undefined;
			accesses.set(instruction, { instruction, slot });
			continue;
		}
		return undefined;
	}

	const materializations: Array<{
		readonly instruction: CoreInstructionId;
		readonly kind: "return";
	}> = [];
	for (const block of control.reachable) {
		const terminatorId = fn.blockTerminator(block);
		const terminatorKind = fn.instructionKind(terminatorId);
		const controlValue = instructionOperand(fn, terminatorId, 0);
		if (
			terminatorKind === "return" &&
			controlValue !== undefined &&
			aliasesAllocation(controlValue)
		) {
			materializations.push({ instruction: terminatorId, kind: "return" });
		} else if (
			controlValue !== undefined &&
			((terminatorKind === "throw" && aliasesAllocation(controlValue)) ||
				((terminatorKind === "branch" || terminatorKind === "guard") &&
					aliasesAllocation(controlValue)) ||
				(terminatorKind === "switch" && aliasesAllocation(controlValue)))
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
			const bundle = get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
			const provenanceAnalysis = bundle.provenance;
			const control = bundle.control;
			const roots = bundle.roots;
			const index = bundle.index;
			const proofs = provenanceAnalysis.layouts.flatMap((layout) => {
				if (layout.kind !== "named-slots") return [];
				const candidate = stackObjectCandidate(fn, layout, control, roots, index);
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
	const definition = definingInstruction(fn, root);
	if (definition === undefined || fn.instructionKind(definition) !== "operation")
		return false;
	const opcode = fn.instructionOpcodeName(definition);
	const operandCount = instructionOperandCount(fn, definition);
	const operator = fn.instructionAttributes(definition).operator;
	const proven =
		opcode === "createNumber" ||
		opcode === "createF64" ||
		(opcode === "move" &&
			operandCount === 1 &&
			provenNumericValue(
				fn,
				instructionOperand(fn, definition, 0)!,
				roots,
				numericRoots,
				memo,
			)) ||
		(opcode === "unary" &&
			typeof operator === "string" &&
			["+", "-", "~", "tonumeric"].includes(operator) &&
			operandCount === 1 &&
			provenNumericValue(
				fn,
				instructionOperand(fn, definition, 0)!,
				roots,
				numericRoots,
				memo,
			)) ||
		(opcode === "binary" &&
			typeof operator === "string" &&
			FRESH_DENSE_NUMERIC_OPERATORS.has(operator) &&
			operandCount === 2 &&
			provenNumericValue(
				fn,
				instructionOperand(fn, definition, 0)!,
				roots,
				numericRoots,
				memo,
			) &&
			provenNumericValue(
				fn,
				instructionOperand(fn, definition, 1)!,
				roots,
				numericRoots,
				memo,
			));
	memo.set(root, proven);
	return proven;
}

function exactIntegerValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): number | undefined {
	const definition = definingInstruction(fn, roots.get(value) ?? value);
	if (
		definition === undefined ||
		fn.instructionKind(definition) !== "operation" ||
		(fn.instructionOpcodeName(definition) !== "createNumber" &&
			fn.instructionOpcodeName(definition) !== "createF64")
	)
		return undefined;
	const immediate = fn.instructionAttributes(definition).value;
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
		const headerTerminator = fn.blockTerminator(loop.header);
		if (fn.instructionKind(headerTerminator) !== "branch") continue;
		const headerEdgeStart = fn.kernel.terminatorEdgeStart(headerTerminator);
		const bodyBlock = fn.kernel.terminatorEdgeBlock(headerEdgeStart);
		const exitBlock = fn.kernel.terminatorEdgeBlock(headerEdgeStart + 1);
		if (
			loop.exits.length !== 1 ||
			loop.exits[0]!.from !== loop.header ||
			loop.exits[0]!.to !== exitBlock
		)
			continue;
		const conditionValue = instructionOperand(fn, headerTerminator, 0)!;
		const condition = definingInstruction(
			fn,
			roots.get(conditionValue) ?? conditionValue,
		);
		if (
			condition === undefined ||
			fn.instructionKind(condition) !== "operation" ||
			fn.instructionOpcodeName(condition) !== "binary" ||
			fn.instructionAttributes(condition).operator !== "<"
		)
			continue;
		const counter = instructionOperand(fn, condition, 0);
		const lengthOperand = instructionOperand(fn, condition, 1);
		const length =
			lengthOperand === undefined
				? undefined
				: exactIntegerValue(fn, lengthOperand, roots);
		const parameterStart = fn.kernel.blockParameterStart(loop.header);
		const parameterCount = fn.kernel.blockParameterCount(loop.header);
		let counterParameter = -1;
		for (let index = 0; index < parameterCount; index++) {
			if (fn.kernel.blockParameterValue(parameterStart + index) === counter) {
				counterParameter = index;
				break;
			}
		}
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
			!loop.blocks.has(bodyBlock) ||
			loop.blocks.has(exitBlock)
		)
			continue;
		const updateValue = updateEdge.arguments[counterParameter];
		if (updateValue === undefined) continue;
		const update = definingInstruction(fn, roots.get(updateValue) ?? updateValue);
		if (
			update === undefined ||
			fn.instructionKind(update) !== "operation" ||
			fn.instructionOpcodeName(update) !== "unary" ||
			fn.instructionAttributes(update).operator !== "increment"
		)
			continue;
		let incrementInput = instructionOperand(fn, update, 0);
		if (incrementInput === undefined) continue;
		const numeric = definingInstruction(fn, roots.get(incrementInput) ?? incrementInput);
		if (
			numeric !== undefined &&
			fn.instructionKind(numeric) === "operation" &&
			fn.instructionOpcodeName(numeric) === "unary" &&
			fn.instructionAttributes(numeric).operator === "tonumeric"
		) {
			incrementInput = instructionOperand(fn, numeric, 0)!;
		}
		const counterRoot = roots.get(counter) ?? counter;
		if ((roots.get(incrementInput) ?? incrementInput) !== counterRoot) continue;
		const stores = [...loop.blocks].flatMap((block) =>
			[...fn.bodyInstructionIds(block)].filter((instruction) => {
				if (fn.instructionOpcodeName(instruction) !== "storeProperty") return false;
				return (
					instructionOperandCount(fn, instruction) === 3 &&
					aliasesAllocation(instructionOperand(fn, instruction, 0)!) &&
					(roots.get(instructionOperand(fn, instruction, 1)!) ??
						instructionOperand(fn, instruction, 1)!) === counterRoot
				);
			}),
		);
		if (stores.length !== 1) continue;
		const store = stores[0]!;
		const storeValue = instructionOperand(fn, store, 2)!;
		if (!provenNumericValue(fn, storeValue, roots, new Set([counterRoot]))) continue;

		let safe = true;
		for (const block of control.reachable) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				const opcode = fn.instructionOpcodeName(instruction);
				const operandCount = instructionOperandCount(fn, instruction);
				for (let position = 0; position < operandCount; position++) {
					const operand = instructionOperand(fn, instruction, position)!;
					if (!aliasesAllocation(operand)) continue;
					if (
						(opcode === "move" && position === 0) ||
						(opcode === "throwIfTdz" && position === 0) ||
						opcode === "rootUse" ||
						(instruction === store && position === 0) ||
						control.dominates(exitBlock, block)
					) {
						continue;
					}
					safe = false;
				}
			}
			const terminator = fn.blockTerminator(block);
			const terminatorKind = fn.instructionKind(terminator);
			const terminatorValue = instructionOperand(fn, terminator, 0);
			if (
				!control.dominates(exitBlock, block) &&
				terminatorValue !== undefined &&
				((terminatorKind === "return" && aliasesAllocation(terminatorValue)) ||
					(terminatorKind === "throw" && aliasesAllocation(terminatorValue)) ||
					((terminatorKind === "branch" || terminatorKind === "guard") &&
						aliasesAllocation(terminatorValue)) ||
					(terminatorKind === "switch" && aliasesAllocation(terminatorValue)))
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

export interface CoreLocalFactIndex {
	readonly statistics: {
		readonly instructionVisits: number;
		readonly operations: number;
		readonly memoryOperations: number;
	};
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
	readonly valuesByRoot: ReadonlyMap<CoreValueId, ReadonlyArray<CoreValueId>>;
	readonly opcodes: ReadonlyArray<ReadonlyArray<CoreInstructionId>>;
	readonly operations: ReadonlyArray<CoreInstructionId>;
	readonly memoryOperations: ReadonlyArray<CoreInstructionId>;
}

function indexedOpcodeInstructions(
	fn: CoreFunctionStore,
	index: CoreLocalFactIndex,
	opcode: string,
): ReadonlyArray<CoreInstructionId> {
	return index.opcodes[fn.registry.require(opcode).id] ?? [];
}

function decodeCoreString(program: CoreProgram, index: number): string | undefined {
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

export function buildCoreLocalFactIndex(
	fn: CoreFunctionStore,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreLocalFactIndex {
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
	const mutableValuesByRoot = new Map<CoreValueId, Array<CoreValueId>>();
	const mutableOpcodes: Array<Array<CoreInstructionId> | undefined> = [];
	const operations: Array<CoreInstructionId> = [];
	const memoryOperations: Array<CoreInstructionId> = [];
	for (let valueIndex = 0; valueIndex < fn.valueCapacity; valueIndex++) {
		const value = valueIndex as CoreValueId;
		if (fn.kernel.valueLive(value) === 0) continue;
		const resolved = root(value);
		const values = mutableValuesByRoot.get(resolved);
		if (values === undefined) mutableValuesByRoot.set(resolved, [value]);
		else values.push(value);
	}
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = blockIndex as CoreBlockId;
		if (fn.kernel.blockLive(block) === 0) continue;
		let bodyIndex = 0;
		for (
			let instructionIndex = fn.kernel.blockFirstInstruction(block);
			instructionIndex >= 0;
			instructionIndex = fn.kernel.instructionNext(instructionIndex as CoreInstructionId)
		) {
			const instruction = instructionIndex as CoreInstructionId;
			if (fn.kernel.instructionOpcode(instruction) < 0) continue;
			const index = bodyIndex++;
			location.set(instruction, { block, index });
			const opcode = fn.instructionOpcode(instruction);
			const descriptor = fn.registry.byId(opcode);
			const instructions = mutableOpcodes[opcode] ?? [];
			instructions.push(instruction);
			mutableOpcodes[opcode] = instructions;
			operations.push(instruction);
			if (
				(descriptor.accesses?.length ?? 0) > 0 ||
				descriptor.effects.reads.length > 0 ||
				descriptor.effects.writes.length > 0 ||
				descriptor.effects.callsUserCode ||
				descriptor.effects.maySuspend ||
				descriptor.allocation !== undefined
			) {
				memoryOperations.push(instruction);
			}
			const operandCount = instructionOperandCount(fn, instruction);
			for (let position = 0; position < operandCount; position++) {
				const operand = instructionOperand(fn, instruction, position)!;
				const value = root(operand);
				const entries = uses.get(value) ?? [];
				entries.push({ instruction, position });
				uses.set(value, entries);
			}
		}
		const terminator = fn.blockTerminator(block);
		location.set(terminator, {
			block,
			index: bodyIndex,
		});
		const terminatorOperandStart = fn.kernel.instructionOperandStart(terminator);
		const terminatorOperandCount = fn.kernel.instructionOperandCount(terminator);
		for (let index = 0; index < terminatorOperandCount; index++) {
			controlUses.add(root(fn.kernel.operandAt(terminatorOperandStart + index)));
		}
		const handler = handlerBlock(fn, block);
		if (handler !== undefined) {
			handlerTargets.add(handler);
			const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
			const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
			for (let index = 0; index < argumentCount; index++) {
				controlUses.add(root(fn.kernel.handlerArgumentAt(argumentStart + index)));
			}
		}
	}
	const valuesByRoot = new Map<CoreValueId, ReadonlyArray<CoreValueId>>();
	for (const [value, aliases] of mutableValuesByRoot) {
		valuesByRoot.set(value, Object.freeze(aliases));
	}
	const opcodes = mutableOpcodes.map((instructions) => Object.freeze(instructions ?? []));
	return Object.freeze({
		statistics: Object.freeze({
			instructionVisits: location.size,
			operations: operations.length,
			memoryOperations: memoryOperations.length,
		}),
		location,
		uses,
		controlUses,
		handlerTargets,
		valuesByRoot,
		opcodes,
		operations: Object.freeze(operations),
		memoryOperations: Object.freeze(memoryOperations),
	});
}

function specializationInstructionDominates(
	control: CoreControlFlow,
	index: CoreLocalFactIndex,
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
	const definition = definingInstruction(fn, roots.get(value) ?? value);
	return definition !== undefined && fn.instructionKind(definition) === "operation"
		? definition
		: undefined;
}

function specializationResultValues(
	index: CoreLocalFactIndex,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	value: CoreValueId,
): ReadonlyArray<CoreValueId> {
	const expected = roots.get(value) ?? value;
	return index.valuesByRoot.get(expected) ?? Object.freeze([]);
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
	index: CoreLocalFactIndex,
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
		instructionResultCount(fn, call) !== 1 ||
		instructionOperandCount(fn, call) < 2 ||
		!control.reachable.has(fn.instructionBlock(call))
	) {
		return undefined;
	}
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const property = specializationDefinition(fn, roots, instructionOperand(fn, call, 0)!);
	if (
		!staticPropertyNamed(program, fn, property, propertyName) ||
		instructionOperandCount(fn, property) !== 1 ||
		root(instructionOperand(fn, property, 0)!) !==
			root(instructionOperand(fn, call, 1)!) ||
		fn.instructionBlock(property) !== fn.instructionBlock(call) ||
		!specializationInstructionDominates(control, index, property, call)
	) {
		return undefined;
	}
	const propertyAttributes = fn.instructionAttributes(property);
	if (
		propertyAttributes.knownOwnSlot !== undefined ||
		propertyAttributes.exactOwnSlot !== undefined
	) {
		return undefined;
	}
	const propertyResult = instructionResult(fn, property, 0);
	if (propertyResult === undefined) return undefined;
	const propertyUses = index.uses.get(root(propertyResult)) ?? [];
	if (
		propertyUses.length !== 1 ||
		propertyUses[0]?.instruction !== call ||
		propertyUses[0].position !== 0
	) {
		return undefined;
	}
	const handler = handlerBlock(fn, fn.instructionBlock(call));
	return {
		property,
		exceptionalBlocks: Object.freeze(handler === undefined ? [] : [handler]),
	};
}

function exactStringSplitCallCandidate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalFactIndex,
	call: CoreInstructionId,
):
	| {
			readonly property?: CoreInstructionId;
			readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
	  }
	| undefined {
	if (
		fn.instructionKind(call) === "operation" &&
		fn.instructionOpcodeName(call) === "callBuiltin" &&
		fn.instructionAttributes(call).operation === "String.prototype.split" &&
		instructionResultCount(fn, call) === 1 &&
		control.reachable.has(fn.instructionBlock(call))
	) {
		const handler = handlerBlock(fn, fn.instructionBlock(call));
		return {
			exceptionalBlocks: Object.freeze(handler === undefined ? [] : [handler]),
		};
	}
	return exactPropertyCallCandidate(program, fn, control, roots, index, call, "split");
}

function stringCharCodeAtCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	loops: CoreLoopInductionAnalysis,
	roots: ReadonlyMap<CoreValueId, CoreValueId>,
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreStringCharCodeAtCandidate> {
	const candidates: Array<CoreStringCharCodeAtCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const call of indexedOpcodeInstructions(fn, index, "call")) {
		if (
			fn.instructionKind(call) !== "operation" ||
			(instructionOperandCount(fn, call) !== 2 && instructionOperandCount(fn, call) !== 3)
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
		const receiver = instructionOperand(fn, call, 1);
		const position = instructionOperand(fn, call, 2);
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
					handlerBlock(fn, induction.loop.header) !== undefined ||
					handlerBlock(fn, fn.instructionBlock(call)) !== undefined
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
					instructionOperandCount(fn, length) !== 1 ||
					root(instructionOperand(fn, length, 0)!) !== root(receiver) ||
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreFunctionCallChainCandidate> {
	const candidates: Array<CoreFunctionCallChainCandidate> = [];
	for (const call of indexedOpcodeInstructions(fn, index, "call")) {
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			instructionOperandCount(fn, call) < 2
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
		const receiver = instructionOperand(fn, call, 1)!;
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
	index: CoreLocalFactIndex,
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
		const latchTerminator = fn.blockTerminator(latch);
		const bodyTerminator = fn.blockTerminator(body);
		const compactBody = body === latch && loop.blocks.size === 2;
		const explicitLatch =
			body !== header &&
			body !== latch &&
			loop.blocks.size === 3 &&
			fn.instructionKind(bodyTerminator) === "jump" &&
			fn.kernel.terminatorEdgeBlock(fn.kernel.terminatorEdgeStart(bodyTerminator)) ===
				latch;
		if (
			fn.instructionKind(headerTerminator) !== "branch" ||
			fn.kernel.terminatorEdgeBlock(fn.kernel.terminatorEdgeStart(headerTerminator)) !==
				body ||
			fn.kernel.terminatorEdgeBlock(
				fn.kernel.terminatorEdgeStart(headerTerminator) + 1,
			) !== comparison.exit ||
			fn.instructionKind(latchTerminator) !== "jump" ||
			fn.kernel.terminatorEdgeBlock(fn.kernel.terminatorEdgeStart(latchTerminator)) !==
				header ||
			(!compactBody && !explicitLatch) ||
			comparison.instruction !== [...fn.bodyInstructionIds(header)].at(-1)
		)
			continue;
		const length = specializationDefinition(fn, roots, comparison.bound);
		if (
			length === undefined ||
			!staticPropertyNamed(program, fn, length, "length") ||
			instructionOperandCount(fn, length) !== 1 ||
			length !== [...fn.bodyInstructionIds(header)].at(-2)
		)
			continue;
		const splitResult = root(instructionOperand(fn, length, 0)!);
		const call = specializationDefinition(fn, roots, splitResult);
		if (
			call === undefined ||
			(fn.instructionOpcodeName(call) !== "call" &&
				fn.instructionOpcodeName(call) !== "callBuiltin")
		)
			continue;
		const split = exactStringSplitCallCandidate(program, fn, control, roots, index, call);
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
			instructionOperandCount(fn, element) !== 2 ||
			root(instructionOperand(fn, element, 0)!) !== splitResult ||
			root(instructionOperand(fn, element, 1)!) !== root(induction.value)
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
		const elementResult = instructionResult(fn, element, 0);
		if (
			trim === undefined ||
			trim.exceptionalBlocks.length !== 0 ||
			trim.property !== trimProperty ||
			elementResult === undefined ||
			root(instructionOperand(fn, trimCall, 1)!) !== root(elementResult)
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
		const incrementInput = instructionOperand(fn, increment, 0);
		if (incrementInput === undefined) continue;
		const inputDefinition = specializationDefinition(fn, roots, incrementInput);
		const advance =
			inputDefinition !== undefined &&
			fn.instructionOpcodeName(inputDefinition) === "unary" &&
			fn.instructionAttributes(inputDefinition).operator === "tonumeric"
				? inputDefinition
				: increment;
		const advanceInput = instructionOperand(fn, advance, 0);
		if (advanceInput === undefined || root(advanceInput) !== root(induction.value))
			continue;
		const trimResult = instructionResult(fn, trimCall, 0);
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
		const comparisonResult = instructionResult(fn, comparison.instruction, 0);
		if (
			!trimResultSafe ||
			primitiveStringLengths.length > 64 ||
			comparisonResult === undefined ||
			root(instructionOperand(fn, headerTerminator, 0)!) !== root(comparisonResult) ||
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
			!exactUses(instructionResult(fn, trimProperty, 0)!, [
				{ instruction: trimCall, position: 0 },
			])
		)
			continue;
		const callBlock = fn.instructionBlock(call);
		if (canReachWithout(comparison.exit, header, callBlock)) continue;
		const instructions = Object.freeze([
			...(split.property === undefined ? [] : [split.property]),
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
					handlerBlock(fn, block) !== undefined || index.handlerTargets.has(block),
			)
		)
			continue;
		const resultValues = index.valuesByRoot.get(splitResult) ?? Object.freeze([]);
		candidates.push(
			Object.freeze({
				key: `string-split-cursor:${fn.id}:${call}:${header}`,
				kind: "string-split-cursor",
				function: fn.id,
				root: call,
				...(split.property === undefined ? {} : { property: split.property }),
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
	index: CoreLocalFactIndex,
	property: CoreInstructionId,
	call: CoreInstructionId,
	operation: string,
): CoreExactCollectionBrand | undefined {
	const expected = operation.startsWith("Map.prototype.")
		? "Map"
		: operation.startsWith("Set.prototype.")
			? "Set"
			: undefined;
	const receiver = instructionOperand(fn, call, 1);
	if (expected === undefined || receiver === undefined) return undefined;
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const definition = definingInstruction(fn, root(receiver));
	if (definition === undefined || fn.instructionOpcodeName(definition) !== "construct")
		return undefined;
	const constructor = instructionOperand(fn, definition, 0);
	if (constructor === undefined) return undefined;
	const constructorDefinition = definingInstruction(fn, root(constructor));
	if (
		constructorDefinition === undefined ||
		fn.instructionOpcodeName(constructorDefinition) !== "loadIntrinsic" ||
		fn.instructionAttributes(constructorDefinition).intrinsic !== expected
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreBuiltinCollectionCallCandidate> {
	const candidates: Array<CoreBuiltinCollectionCallCandidate> = [];
	for (const call of indexedOpcodeInstructions(fn, index, "call")) {
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreFreshArrayLengthCandidate> {
	const candidates: Array<CoreFreshArrayLengthCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const load of indexedOpcodeInstructions(fn, index, "loadPropertyStatic")) {
		if (
			fn.instructionKind(load) !== "operation" ||
			!staticPropertyNamed(program, fn, load, "length") ||
			instructionOperandCount(fn, load) !== 1 ||
			instructionResultCount(fn, load) !== 1 ||
			!control.reachable.has(fn.instructionBlock(load))
		)
			continue;
		const base = instructionOperand(fn, load, 0)!;
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
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreIndexedLengthLoopCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const candidates: Array<CoreIndexedLengthLoopCandidate> = [];
	for (const load of indexedOpcodeInstructions(fn, index, "loadPropertyStatic")) {
		const loadAttributes = fn.instructionAttributes(load);
		if (
			fn.instructionKind(load) !== "operation" ||
			!staticPropertyNamed(program, fn, load, "length") ||
			loadAttributes.knownOwnSlot !== undefined ||
			loadAttributes.exactOwnSlot !== undefined ||
			instructionOperandCount(fn, load) !== 1 ||
			instructionResultCount(fn, load) !== 1 ||
			!control.reachable.has(fn.instructionBlock(load))
		)
			continue;
		const block = fn.instructionBlock(load);
		const loop = control.loops
			.filter(({ blocks }) => blocks.has(block))
			.sort((left, right) => left.blocks.size - right.blocks.size)[0];
		if (loop === undefined) continue;
		const output = instructionResult(fn, load, 0)!;
		if (index.controlUses.has(roots.get(output) ?? output)) continue;
		const uses = index.uses.get(roots.get(output) ?? output) ?? [];
		const comparison = uses.length === 1 ? uses[0]!.instruction : undefined;
		if (comparison === undefined) continue;
		const operator = fn.instructionAttributes(comparison).operator;
		if (
			fn.instructionKind(comparison) !== "operation" ||
			fn.instructionOpcodeName(comparison) !== "binary" ||
			fn.instructionBlock(comparison) !== block ||
			typeof operator !== "string" ||
			!INDEXED_LENGTH_LOOP_OPERATORS.has(operator)
		)
			continue;
		const lengthPosition =
			instructionOperand(fn, comparison, 0) === output
				? 1
				: instructionOperand(fn, comparison, 1) === output
					? 2
					: undefined;
		if (lengthPosition === undefined) continue;
		const induction = instructionOperand(fn, comparison, lengthPosition === 1 ? 1 : 0);
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
			loadLocation.index + 1 !== comparisonLocation.index
		)
			continue;
		const receiver = instructionOperand(fn, load, 0)!;
		const elements: Array<{
			readonly instruction: CoreInstructionId;
			readonly kind: "load" | "store";
		}> = [];
		const indexedAccesses = [
			...indexedOpcodeInstructions(fn, index, "loadProperty"),
			...indexedOpcodeInstructions(fn, index, "storeProperty"),
		].sort((left, right) => {
			const leftLocation = index.location.get(left)!;
			const rightLocation = index.location.get(right)!;
			return (
				leftLocation.block - rightLocation.block ||
				leftLocation.index - rightLocation.index
			);
		});
		for (const instruction of indexedAccesses) {
			const location = index.location.get(instruction)!;
			if (
				!loop.blocks.has(location.block) ||
				!control.dominates(block, location.block) ||
				(location.block === block && location.index <= comparisonLocation.index) ||
				instructionOperand(fn, instruction, 0) !== receiver ||
				instructionOperand(fn, instruction, 1) !== induction
			)
				continue;
			elements.push({
				instruction,
				kind: fn.instructionOpcodeName(instruction) === "loadProperty" ? "load" : "store",
			});
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
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	const sourceInstruction = definingInstruction(fn, root);
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
			? instructionOperand(fn, sourceInstruction, 0)
			: undefined;
	const constructorDefinition =
		constructor === undefined
			? undefined
			: definingInstruction(fn, roots.get(constructor) ?? constructor);
	const intrinsic =
		constructorDefinition !== undefined &&
		fn.instructionOpcodeName(constructorDefinition) === "loadIntrinsic"
			? fn.instructionAttributes(constructorDefinition).intrinsic
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreIteratorCursorCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const stepsByIterator = new Map<CoreValueId, Array<CoreInstructionId>>();
	for (const instruction of indexedOpcodeInstructions(fn, index, "iteratorStep")) {
		if (!control.reachable.has(fn.instructionBlock(instruction))) continue;
		const iterator = instructionOperand(fn, instruction, 0);
		if (iterator === undefined) continue;
		const steps = stepsByIterator.get(root(iterator)) ?? [];
		steps.push(instruction);
		stepsByIterator.set(root(iterator), steps);
	}
	const candidates: Array<CoreIteratorCursorCandidate> = [];
	for (const initialize of indexedOpcodeInstructions(fn, index, "getIterator")) {
		if (
			instructionOperandCount(fn, initialize) !== 1 ||
			instructionResultCount(fn, initialize) !== 2 ||
			!control.reachable.has(fn.instructionBlock(initialize))
		)
			continue;
		const iterator = instructionResult(fn, initialize, 0);
		const next = instructionResult(fn, initialize, 1);
		const source = instructionOperand(fn, initialize, 0);
		if (iterator === undefined || next === undefined || source === undefined) continue;
		const steps = Object.freeze(
			(stepsByIterator.get(root(iterator)) ?? [])
				.filter((step) => root(instructionOperand(fn, step, 1)!) === root(next))
				.sort((left, right) => left - right),
		);
		if (steps.length === 0 || steps.length > 32) continue;
		const strategy = iteratorCursorKind(fn, roots, source);
		const instructions = Object.freeze([initialize, ...steps]);
		const exceptionalBlocks = Object.freeze([
			...new Set(
				instructions.flatMap((instruction) => {
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreIteratorResultVirtualizationCandidate> {
	const steps = indexedOpcodeInstructions(fn, index, "iteratorStep").filter(
		(instruction) => control.reachable.has(fn.instructionBlock(instruction)),
	);
	const candidates: Array<CoreIteratorResultVirtualizationCandidate> = [];
	for (let offset = 0; offset < steps.length; offset += 64) {
		const shard = Object.freeze(steps.slice(offset, offset + 64));
		if (shard.length === 0) continue;
		const exceptionalBlocks = Object.freeze([
			...new Set(
				shard.flatMap((instruction) => {
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreIteratorEntryPairVirtualizationCandidate> {
	if (fn.isGenerator || fn.isAsync) return [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const candidates: Array<CoreIteratorEntryPairVirtualizationCandidate> = [];
	for (const outerStep of indexedOpcodeInstructions(fn, index, "iteratorStep")) {
		if (
			fn.instructionKind(outerStep) !== "operation" ||
			fn.instructionOpcodeName(outerStep) !== "iteratorStep" ||
			instructionResultCount(fn, outerStep) !== 2 ||
			!control.reachable.has(fn.instructionBlock(outerStep))
		)
			continue;
		const cursorInitialize = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, outerStep, 0)!,
		);
		if (
			cursorInitialize === undefined ||
			fn.instructionOpcodeName(cursorInitialize) !== "getIterator" ||
			root(instructionResult(fn, cursorInitialize, 1)!) !==
				root(instructionOperand(fn, outerStep, 1)!)
		)
			continue;
		const source = instructionOperand(fn, cursorInitialize, 0);
		const sourceDefinition =
			source === undefined ? undefined : specializationDefinition(fn, roots, source);
		const sourceAttributes =
			sourceDefinition === undefined ? {} : fn.instructionAttributes(sourceDefinition);
		const constructor =
			sourceDefinition !== undefined &&
			fn.instructionOpcodeName(sourceDefinition) === "construct"
				? instructionOperand(fn, sourceDefinition, 0)
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
		const pair = instructionResult(fn, outerStep, 0)!;
		const pairUses = index.uses.get(root(pair)) ?? [];
		const innerInitialize =
			pairUses.length === 1 &&
			pairUses[0]?.position === 0 &&
			fn.instructionOpcodeName(pairUses[0].instruction) === "getIterator"
				? pairUses[0].instruction
				: undefined;
		if (
			innerInitialize === undefined ||
			instructionResultCount(fn, innerInitialize) !== 2 ||
			!specializationInstructionDominates(control, index, outerStep, innerInitialize)
		)
			continue;
		const innerIteratorValue = instructionResult(fn, innerInitialize, 0)!;
		const innerNextValue = instructionResult(fn, innerInitialize, 1)!;
		const innerIterator = root(innerIteratorValue);
		const innerNext = root(innerNextValue);
		const iteratorUses = index.uses.get(innerIterator) ?? [];
		const nextUses = index.uses.get(innerNext) ?? [];
		const innerSteps = iteratorUses
			.filter(
				({ instruction, position }) =>
					position === 0 &&
					fn.instructionOpcodeName(instruction) === "iteratorStep" &&
					root(instructionOperand(fn, instruction, 1)!) === innerNext,
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
		const innerTerminator = fn.blockTerminator(innerBlock);
		const firstTerminator = fn.blockTerminator(firstBlock);
		const corridor = new Set([innerInitialize, ...orderedSteps]);
		const corridorBlocks = new Set([innerBlock, firstBlock, secondBlock]);
		if (
			[...corridorBlocks].some((block) =>
				[...fn.bodyInstructionIds(block)].some(
					(instruction) => !corridor.has(instruction),
				),
			) ||
			(innerBlock !== firstBlock &&
				(fn.instructionKind(innerTerminator) !== "jump" ||
					fn.kernel.terminatorEdgeBlock(
						fn.kernel.terminatorEdgeStart(innerTerminator),
					) !== firstBlock)) ||
			(firstBlock !== secondBlock &&
				(fn.instructionKind(firstTerminator) !== "jump" ||
					fn.kernel.terminatorEdgeBlock(
						fn.kernel.terminatorEdgeStart(firstTerminator),
					) !== secondBlock)) ||
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
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreStringSplitProjectionCandidate> {
	const candidates: Array<CoreStringSplitProjectionCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const call of [
		...indexedOpcodeInstructions(fn, index, "call"),
		...indexedOpcodeInstructions(fn, index, "callBuiltin"),
	]) {
		if (fn.instructionKind(call) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(call);
		const direct = opcode === "callBuiltin";
		if (
			(opcode !== "call" && opcode !== "callBuiltin") ||
			(direct
				? fn.instructionAttributes(call).operation !== "String.prototype.split" ||
					instructionOperandCount(fn, call) !== 2
				: instructionOperandCount(fn, call) !== 3) ||
			instructionResultCount(fn, call) !== 1 ||
			!control.reachable.has(fn.instructionBlock(call))
		)
			continue;
		const property = direct
			? undefined
			: specializationDefinition(fn, roots, instructionOperand(fn, call, 0)!);
		const receiver = instructionOperand(fn, call, direct ? 0 : 1)!;
		const separator = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, call, direct ? 1 : 2)!,
		);
		if (
			(property !== undefined &&
				(!staticPropertyNamed(program, fn, property, "split") ||
					instructionOperandCount(fn, property) !== 1 ||
					root(instructionOperand(fn, property, 0)!) !== root(receiver) ||
					!specializationInstructionDominates(control, index, property, call))) ||
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
		if (property !== undefined) {
			const propertyResult = instructionResult(fn, property, 0)!;
			const propertyUses = index.uses.get(root(propertyResult)) ?? [];
			if (
				propertyUses.length !== 1 ||
				propertyUses[0]?.instruction !== call ||
				propertyUses[0].position !== 0
			)
				continue;
		}
		const result = instructionResult(fn, call, 0)!;
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
				instructionOperandCount(fn, consumer) === 2 &&
				specializationInstructionDominates(control, index, call, consumer)
			) {
				const key = specializationDefinition(
					fn,
					roots,
					instructionOperand(fn, consumer, 1)!,
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
			...(property === undefined ? [] : [property]),
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
				return handlerBlock(fn, block) !== undefined || index.handlerTargets.has(block);
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
				...(property === undefined ? {} : { property }),
				call,
				separator,
				separatorStringIndex,
				resultValues: specializationResultValues(index, roots, result),
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreStringSliceNumberCandidate> {
	const candidates: Array<CoreStringSliceNumberCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const sliceCall of indexedOpcodeInstructions(fn, index, "call")) {
		if (
			fn.instructionKind(sliceCall) !== "operation" ||
			fn.instructionOpcodeName(sliceCall) !== "call" ||
			instructionOperandCount(fn, sliceCall) !== 3 ||
			instructionResultCount(fn, sliceCall) !== 1 ||
			!control.reachable.has(fn.instructionBlock(sliceCall))
		)
			continue;
		const property = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, sliceCall, 0)!,
		);
		const start = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, sliceCall, 2)!,
		);
		if (
			!staticPropertyNamed(program, fn, property, "slice") ||
			root(instructionOperand(fn, property, 0)!) !==
				root(instructionOperand(fn, sliceCall, 1)!) ||
			!specializationInstructionDominates(control, index, property, sliceCall) ||
			start === undefined ||
			(fn.instructionOpcodeName(start) !== "createNumber" &&
				fn.instructionOpcodeName(start) !== "createF64") ||
			!specializationInstructionDominates(control, index, start, sliceCall)
		)
			continue;
		const sliceStart = fn.instructionAttributes(start).value;
		if (typeof sliceStart !== "number" || !Number.isFinite(sliceStart)) continue;
		const propertyUses = index.uses.get(root(instructionResult(fn, property, 0)!)) ?? [];
		const result = instructionResult(fn, sliceCall, 0)!;
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
			instructionOperandCount(fn, numberCall) !== 3 ||
			root(instructionOperand(fn, numberCall, 2)!) !== root(result)
		)
			continue;
		const numberIntrinsic = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, numberCall, 0)!,
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
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
	index: CoreLocalFactIndex,
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
						instructionResult(fn, instruction, 0) !== undefined &&
						root(instructionResult(fn, instruction, 0)!) === root(value)))
			);
		});
	for (const call of indexedOpcodeInstructions(fn, index, "call")) {
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			instructionOperandCount(fn, call) !== 3 ||
			instructionResultCount(fn, call) !== 1 ||
			!control.reachable.has(fn.instructionBlock(call))
		)
			continue;
		const property = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, call, 0)!,
		);
		if (
			!staticPropertyNamed(program, fn, property, "exec") ||
			instructionOperandCount(fn, property) !== 1 ||
			instructionResultCount(fn, property) !== 1 ||
			root(instructionOperand(fn, property, 0)!) !==
				root(instructionOperand(fn, call, 1)!) ||
			!specializationInstructionDominates(control, index, property, call)
		)
			continue;
		const propertyUses = index.uses.get(root(instructionResult(fn, property, 0)!)) ?? [];
		if (
			propertyUses.length !== 1 ||
			propertyUses[0]?.instruction !== call ||
			propertyUses[0].position !== 0
		)
			continue;
		const result = instructionResult(fn, call, 0)!;
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
				const other = instructionOperand(fn, consumer, use.position === 0 ? 1 : 0);
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
				instructionOperandCount(fn, consumer) === 2 &&
				instructionResultCount(fn, consumer) === 1 &&
				specializationInstructionDominates(control, index, call, consumer)
			) {
				const key = specializationDefinition(
					fn,
					roots,
					instructionOperand(fn, consumer, 1)!,
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
			const capture = root(instructionResult(fn, load.instruction, 0)!);
			const captureUses = semanticUses(capture);
			if (captureUses.length === 1) {
				const consumer = captureUses[0]!.instruction;
				if (
					captureUses[0]!.position === 0 &&
					staticPropertyNamed(program, fn, consumer, "length") &&
					instructionOperandCount(fn, consumer) === 1
				) {
					load.consumer = { kind: "length", property: consumer };
					continue;
				}
				if (
					fn.instructionOpcodeName(consumer) === "call" &&
					captureUses[0]!.position === 2 &&
					instructionOperandCount(fn, consumer) === 3
				) {
					const intrinsic = specializationDefinition(
						fn,
						roots,
						instructionOperand(fn, consumer, 0)!,
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
				instructionOperandCount(fn, upperCall) === 2 &&
				root(instructionOperand(fn, upperCall, 0)!) ===
					root(instructionResult(fn, upperProperty, 0)!) &&
				(index.uses.get(root(instructionResult(fn, upperProperty, 0)!))?.length ?? 0) ===
					1
			) {
				const upperResult = root(instructionResult(fn, upperCall, 0)!);
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
					instructionOperandCount(fn, lowerCall) === 2 &&
					root(instructionOperand(fn, lowerCall, 0)!) ===
						root(instructionResult(fn, lowerProperty, 0)!) &&
					(index.uses.get(root(instructionResult(fn, lowerProperty, 0)!))?.length ??
						0) === 1
				) {
					const lowerUses = semanticUses(instructionResult(fn, lowerCall, 0)!);
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
				instructionOperandCount(fn, charCall) !== 3 ||
				root(instructionOperand(fn, charCall, 0)!) !==
					root(instructionResult(fn, charProperty, 0)!) ||
				(index.uses.get(root(instructionResult(fn, charProperty, 0)!))?.length ?? 0) !== 1
			)
				continue;
			const zero = specializationDefinition(
				fn,
				roots,
				instructionOperand(fn, charCall, 2)!,
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
		const construct = specializationDefinition(
			fn,
			roots,
			instructionOperand(fn, call, 1)!,
		);
		if (
			construct !== undefined &&
			fn.instructionOpcodeName(construct) === "construct" &&
			instructionResultCount(fn, construct) === 1
		) {
			const receiverUses =
				index.uses.get(root(instructionResult(fn, construct, 0)!)) ?? [];
			const constructorIntrinsic = specializationDefinition(
				fn,
				roots,
				instructionOperand(fn, construct, 0)!,
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
				return handlerBlock(fn, block) !== undefined || index.handlerTargets.has(block);
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
				resultValues: specializationResultValues(index, roots, result),
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
	index: CoreLocalFactIndex,
): ReadonlyArray<CoreRegExpIteratorProjectionCandidate> {
	const candidates: Array<CoreRegExpIteratorProjectionCandidate> = [];
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	for (const step of indexedOpcodeInstructions(fn, index, "iteratorStep")) {
		const block = fn.instructionBlock(step);
		if (!control.reachable.has(block)) continue;
		const doneBranch = fn.blockTerminator(block);
		if (
			index.location.get(step)!.index + 1 !== index.location.get(doneBranch)!.index ||
			instructionOperandCount(fn, step) !== 2 ||
			instructionResultCount(fn, step) !== 2 ||
			fn.instructionKind(doneBranch) !== "branch" ||
			root(instructionOperand(fn, doneBranch, 0)!) !==
				root(instructionResult(fn, step, 1)!) ||
			fn.kernel.terminatorEdgeBlock(fn.kernel.terminatorEdgeStart(doneBranch)) === block
		)
			continue;
		const result = instructionResult(fn, step, 0)!;
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
				instructionOperandCount(fn, capture) !== 2 ||
				instructionResultCount(fn, capture) !== 1 ||
				!specializationInstructionDominates(control, index, step, capture)
			) {
				safe = false;
				break;
			}
			const key = specializationDefinition(
				fn,
				roots,
				instructionOperand(fn, capture, 1)!,
			);
			const captureIndex =
				key === undefined ? undefined : fn.instructionAttributes(key).value;
			const captureUses = index.uses.get(root(instructionResult(fn, capture, 0)!)) ?? [];
			const numberUse = captureUses[0];
			const numberCall = numberUse?.instruction;
			const numberIntrinsic =
				numberCall === undefined
					? undefined
					: specializationDefinition(fn, roots, instructionOperand(fn, numberCall, 0)!);
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
				instructionOperandCount(fn, numberCall) !== 3 ||
				root(instructionOperand(fn, numberCall, 2)!) !==
					root(instructionResult(fn, capture, 0)!) ||
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
					const handler = handlerBlock(fn, fn.instructionBlock(instruction));
					return handler === undefined ? [] : [handler];
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
				exitBlock: fn.kernel.terminatorEdgeBlock(
					fn.kernel.terminatorEdgeStart(doneBranch),
				),
				resultValues: specializationResultValues(index, roots, result),
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
	index: CoreLocalFactIndex,
): CoreLocalSpecializationCandidates {
	const fn = program.function(functionId);
	const candidates: Array<CoreLocalSpecializationCandidate> = [];
	const candidateBuckets = new Map<number, Array<CoreLocalSpecializationCandidate>>();
	const addCandidate = (candidate: CoreLocalSpecializationCandidate): void => {
		let hash = 2_166_136_261;
		for (let index = 0; index < candidate.key.length; index++) {
			hash ^= candidate.key.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619);
		}
		const numericHash = hash >>> 0;
		const bucket = candidateBuckets.get(numericHash) ?? [];
		if (bucket.some((known) => known.key === candidate.key)) return;
		bucket.push(candidate);
		candidateBuckets.set(numericHash, bucket);
		candidates.push(candidate);
	};
	const addNumeric = (
		root: CoreInstructionId,
		instructions: ReadonlyArray<CoreInstructionId>,
	): void => {
		const stableInstructions = Object.freeze([...new Set(instructions)]);
		const key = `numeric-fusion:${functionId}:${root}:${stableInstructions.join(",")}`;
		addCandidate(
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
			const candidate = stackObjectCandidate(fn, layout, control, roots, index);
			if (candidate !== undefined) addCandidate(candidate);
		} else {
			const dense = denseArrayCandidates(fn, layout, control, roots);
			for (const candidate of dense) {
				addCandidate(candidate);
			}
			if (
				dense.length === 0 &&
				provenanceAnalysis.escape(layout.instruction) === "contained"
			) {
				const useInstructions = (
					index.uses.get(roots.get(layout.result) ?? layout.result) ?? []
				).map(({ instruction }) => instruction);
				const instructions = Object.freeze(
					[layout.instruction, ...useInstructions].filter(
						(instruction, index, all) => all.indexOf(instruction) === index,
					),
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
				addCandidate(candidate);
			}
		}
	}
	for (const candidate of [
		...freshArrayLengthCandidates(program, fn, provenanceAnalysis, control, roots, index),
		...indexedLengthLoopCandidates(program, fn, control, roots, index),
		...iteratorCursorCandidates(fn, control, roots, index),
		...iteratorResultVirtualizationCandidates(fn, control, index),
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
		addCandidate(candidate);
	}
	for (const instruction of indexedOpcodeInstructions(fn, index, "binary")) {
		if (
			!control.reachable.has(fn.instructionBlock(instruction)) ||
			!coreTargetSupportsNumericFusionOperator(
				fn.instructionAttributes(instruction).operator,
				"start",
			)
		)
			continue;
		const output = instructionResult(fn, instruction, 0);
		if (
			output === undefined ||
			fn.valueRepresentation(output) !== "boxed" ||
			index.controlUses.has(roots.get(output) ?? output)
		)
			continue;
		const uses = index.uses.get(roots.get(output) ?? output) ?? [];
		const user = uses.length === 1 ? uses[0]!.instruction : undefined;
		if (user === undefined) continue;
		const startLocation = index.location.get(instruction);
		const finishLocation = index.location.get(user);
		let matchingOperands = 0;
		const userOperandCount = instructionOperandCount(fn, user);
		for (let position = 0; position < userOperandCount; position++) {
			if (instructionOperand(fn, user, position) === output) matchingOperands++;
		}
		if (
			fn.instructionKind(user) !== "operation" ||
			fn.instructionOpcodeName(user) !== "binary" ||
			!control.reachable.has(fn.instructionBlock(user)) ||
			matchingOperands !== 1 ||
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
	const values = Object.freeze(candidates);
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
	const index = buildCoreLocalFactIndex(fn, roots);
	const valueKinds = analyzeCoreValueKinds(fn, control);
	return discoverCandidates(
		program,
		functionId,
		buildCoreProvenance(program, fn, control, { canonicalRoots: roots, index }),
		control,
		analyzeCoreLoopInductions(fn, control, roots, (value) =>
			valueKinds.exactScalar(value),
		),
		roots,
		index,
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
			const bundle = get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
			return discoverCandidates(
				program,
				request.function,
				bundle.provenance,
				bundle.control,
				get(CORE_LOOP_INDUCTION_ANALYSIS, request),
				bundle.roots,
				bundle.index,
			);
		},
	};
