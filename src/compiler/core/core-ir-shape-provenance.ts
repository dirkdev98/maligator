/**
 * Bounded allocation-site provenance for ordinary shaped objects.
 *
 * This is deliberately not a claim about an object's current runtime shape. A
 * `createObjectShaped` origin or bounded constructor receiver layout says only
 * which ordinary-object layout may have produced an SSA value; user code may
 * subsequently delete properties, install accessors, change descriptors, or
 * otherwise move the object to another shape. Consumers must therefore validate
 * the live shape and retain the original operation as an exact fallback.
 *
 * The lattice keeps at most four useful origins plus an independent `opaque` bit.
 * Opaque covers every producer outside this analysis and finite overflow. Keeping
 * the bounded candidates is still useful for guarded consumers: an unlisted
 * origin simply takes their fallback. The graph contains SSA moves, ordinary
 * block arguments, compiler-owned global/captured cells, and finite ordinary-call
 * argument/return edges. Cells remain open, but in-image stores still contribute
 * guarded candidates. It excludes unmodelled aggregate heap cells and call forms whose
 * positional or result semantics are not exact in Core, so the solve is one
 * monotone worklist over O(values + cells + edges).
 */

import { analyzeCoreCalleeTargets } from "./core-ir-call-targets.ts";
import type { CoreCalleeTargetAnalysis } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow, coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { analyzeCoreInterproceduralValueFlow } from "./core-ir-interprocedural-flow.ts";
import { coreInstructionEffects, coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreOwnCellResolver, coreProvenance } from "./core-ir-provenance.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { coreInstructionId, coreValueId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlock,
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

/** Guard/code-size bound shared by every prospective shape consumer. */
export const CORE_SHAPE_ORIGIN_CAP = 4;

/** Target-visible advisory slot candidate owned by the Core shape selector. */
export const CORE_KNOWN_OWN_SLOT_ATTRIBUTE = "knownOwnSlot";
export const CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE = "exactShapeOwnSlot";
export const CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE = "shapeCaseCandidates";
export const CORE_SHAPE_CASE_SLOTS_ATTRIBUTE = "shapeCaseSlots";

export interface CoreKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
	readonly slot: number;
}

export interface CoreKnownOwnSlot {
	readonly candidates: ReadonlyArray<CoreKnownOwnSlotCandidate>;
}

export interface CoreExactShapeOwnSlot {
	readonly slot: number;
	readonly origins: ReadonlyArray<CoreShapeCaseCandidate>;
}

export interface CoreShapeCaseCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		!Object.is(value, -0)
	);
}

/** Parse the target-visible advisory certificate without trusting attribute data. */
export function coreKnownOwnSlotFromAttribute(
	value: unknown,
): CoreKnownOwnSlot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !Array.isArray(record.candidates)) {
		return undefined;
	}
	if (record.candidates.length < 1 || record.candidates.length > CORE_SHAPE_ORIGIN_CAP) {
		return undefined;
	}
	const candidates: Array<CoreKnownOwnSlotCandidate> = [];
	const identities = new Set<string>();
	for (const value of record.candidates as ReadonlyArray<unknown>) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return undefined;
		}
		const candidate = value as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 3 ||
			!isNonnegativeSafeInteger(candidate.shapeFunctionIndex) ||
			!isNonnegativeSafeInteger(candidate.shapeInstruction) ||
			!isNonnegativeSafeInteger(candidate.slot)
		) {
			return undefined;
		}
		const identity = `${candidate.shapeFunctionIndex}\0${candidate.shapeInstruction}`;
		if (identities.has(identity)) return undefined;
		identities.add(identity);
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: coreInstructionId(candidate.shapeInstruction),
				slot: candidate.slot,
			}),
		);
	}
	return Object.freeze({
		candidates: Object.freeze(candidates),
	});
}

/** Parse a direct-slot certificate without trusting target-facing metadata. */
export function coreExactShapeOwnSlotFromAttribute(
	value: unknown,
): CoreExactShapeOwnSlot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 2 ||
		!isNonnegativeSafeInteger(record.slot) ||
		record.slot >= 64
	) {
		return undefined;
	}
	const origins = coreShapeCaseCandidatesFromAttribute(record.origins);
	return origins === undefined
		? undefined
		: Object.freeze({ slot: record.slot, origins });
}

/** Parse a shared shape selector's bounded candidate list. */
export function coreShapeCaseCandidatesFromAttribute(
	value: unknown,
): ReadonlyArray<CoreShapeCaseCandidate> | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > CORE_SHAPE_ORIGIN_CAP) {
		return undefined;
	}
	const candidates: Array<CoreShapeCaseCandidate> = [];
	const identities = new Set<string>();
	for (const entry of value as ReadonlyArray<unknown>) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return undefined;
		}
		const candidate = entry as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 2 ||
			!isNonnegativeSafeInteger(candidate.shapeFunctionIndex) ||
			!isNonnegativeSafeInteger(candidate.shapeInstruction)
		) {
			return undefined;
		}
		const identity = `${candidate.shapeFunctionIndex}\0${candidate.shapeInstruction}`;
		if (identities.has(identity)) return undefined;
		identities.add(identity);
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: coreInstructionId(candidate.shapeInstruction),
			}),
		);
	}
	return Object.freeze(candidates);
}

/** Parse one clustered load's slot table, indexed by the shared shape case. */
export function coreShapeCaseSlotsFromAttribute(
	value: unknown,
): ReadonlyArray<number> | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > CORE_SHAPE_ORIGIN_CAP) {
		return undefined;
	}
	const slots: Array<number> = [];
	for (const slot of value as ReadonlyArray<unknown>) {
		if (!isNonnegativeSafeInteger(slot) || slot >= 64) return undefined;
		slots.push(slot);
	}
	return Object.freeze(slots);
}

function knownOwnSlotsEqual(
	left: CoreKnownOwnSlot | undefined,
	right: CoreKnownOwnSlot | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.candidates.length === right.candidates.length &&
		left.candidates.every((candidate, index) => {
			const other = right.candidates[index];
			return (
				other !== undefined &&
				candidate.shapeFunctionIndex === other.shapeFunctionIndex &&
				candidate.shapeInstruction === other.shapeInstruction &&
				candidate.slot === other.slot
			);
		})
	);
}

function exactShapeOwnSlotsEqual(
	left: CoreExactShapeOwnSlot | undefined,
	right: CoreExactShapeOwnSlot | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.slot === right.slot &&
		left.origins.length === right.origins.length &&
		left.origins.every(
			(origin, index) =>
				origin.shapeFunctionIndex === right.origins[index]?.shapeFunctionIndex &&
				origin.shapeInstruction === right.origins[index]?.shapeInstruction,
		)
	);
}

const PROTO_LITERAL_KEY: ReadonlyArray<number> = Object.freeze([
	0x5f, 0x5f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x5f, 0x5f,
]);

function isProtoLiteralKey(units: ReadonlyArray<number>): boolean {
	return (
		units.length === PROTO_LITERAL_KEY.length &&
		units.every((unit, index) => unit === PROTO_LITERAL_KEY[index])
	);
}

/** One compiler-created initial ordinary-object layout. */
export interface CoreShapeOrigin {
	readonly kind: "literal" | "constructor";
	readonly functionIndex: number;
	readonly instruction: CoreInstructionId;
	/** Static string-constant keys in runtime slot order. */
	readonly keyStringIndices: ReadonlyArray<number>;
}

/**
 * Initial shaped-object origins worth testing at runtime.
 *
 * `opaque` means another origin, a non-object value, or an unmodelled object may
 * also reach the value. It never invalidates the listed guarded candidates.
 */
export interface CoreShapeCandidates {
	readonly origins: ReadonlyArray<CoreShapeOrigin>;
	readonly opaque: boolean;
}

const NO_ORIGINS: ReadonlyArray<CoreShapeOrigin> = Object.freeze([]);

export const CORE_SHAPE_CANDIDATES_BOTTOM: CoreShapeCandidates = Object.freeze({
	origins: NO_ORIGINS,
	opaque: false,
});

export const CORE_SHAPE_CANDIDATES_OPAQUE: CoreShapeCandidates = Object.freeze({
	origins: NO_ORIGINS,
	opaque: true,
});

export interface CoreShapeProvenanceStatistics {
	readonly nodes: number;
	readonly edges: number;
	readonly origins: number;
	/** Compiler-created object fields carrying candidate values. */
	readonly aggregateCellNodes: number;
	/** Strict node-state rises during the bounded solve. */
	readonly propagations: number;
	/** Values that observed more origins than the finite candidate bound. */
	readonly saturatedValues: number;
	/** Origins whose complete value-flow cone never reaches a shape-invalidating use. */
	readonly stableOrigins: number;
	readonly unstableOrigins: number;
}

export interface CoreShapeProvenanceAnalysis {
	candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates;
	/** A no-guard own data slot proved from the complete, uncapped escape cone. */
	exactOwnSlot(
		functionIndex: number,
		value: CoreValueId,
		stringIndex: number,
	): CoreExactShapeOwnSlot | undefined;
	isLoopBlock(functionIndex: number, block: CoreBlockId): boolean;
	readonly origins: ReadonlyArray<CoreShapeOrigin>;
	readonly statistics: CoreShapeProvenanceStatistics;
}

export interface CoreShapeProvenanceOptions {
	readonly registry?: CoreOpcodeRegistry;
	readonly calleeTargets?: CoreCalleeTargetAnalysis;
	/** Closed-world entry and positional-call authority shared with other lattices. */
	readonly summaries?: CoreProgramSummaries;
	readonly controlFlow?: (fn: CoreFunction) => CoreControlFlow;
	readonly canonicalValues?: (fn: CoreFunction) => ReadonlyMap<CoreValueId, CoreValueId>;
	/** Function bodies that reach execution in the current closed image. */
	readonly executableFunctions?: ReadonlySet<number>;
}

/** Validate one shaped-literal origin and return its runtime slot-key order. */
export function coreShapedObjectKeys(
	program: CoreProgram,
	instruction: CoreInstruction,
	cellForString: ReturnType<typeof coreOwnCellResolver>,
): ReadonlyArray<number> | undefined {
	if (instruction.opcode !== "createObjectShaped" || instruction.outputs.length !== 1) {
		return undefined;
	}
	const value: unknown = instruction.attributes.keyStringIndices;
	if (!Array.isArray(value)) return undefined;
	const keys: Array<number> = [];
	const canonicalKeys = new Set<number>();
	for (const index of value as ReadonlyArray<unknown>) {
		if (
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= program.stringConstants.length
		) {
			return undefined;
		}
		const cell = cellForString(index);
		const units = program.stringConstants[index]!;
		// `createObjectShaped` is an ordinary named-slot literal only. Canonical
		// array-index spellings live in element storage; duplicate-content constants
		// name the same property; and literal `__proto__` has prototype-setting
		// semantics rather than creating an own data slot.
		if (
			cell?.kind !== "object-slot" ||
			canonicalKeys.has(cell.key) ||
			isProtoLiteralKey(units)
		) {
			return undefined;
		}
		canonicalKeys.add(cell.key);
		keys.push(index);
	}
	if (
		keys.length === 0 ||
		keys.length !== instruction.inputs.length ||
		keys.length > 64 ||
		new Set(keys).size !== keys.length
	) {
		return undefined;
	}
	return Object.freeze(keys);
}

interface CoreConstructorShapeLayout {
	readonly instruction: CoreInstructionId;
	readonly keyStringIndices: ReadonlyArray<number>;
}

/**
 * Recognize one deliberately narrow constructor receiver layout.
 *
 * The result remains advisory: ordinary [[Set]] can invoke inherited setters,
 * prototype state can change, and an alternate/Proxy constructor can produce a
 * different object. The eventual own-slot consumer therefore still compares the
 * live shape pointer and retains the generic property operation as fallback.
 * This parser only avoids publishing layouts that are predictably cold: it
 * accepts a non-derived, non-coroutine constructor with one linear completion,
 * an implicit-undefined return, and static named assignment or default data-field
 * definitions whose receiver is the canonical `this` value. Any other observable
 * use of `this` declines the shape.
 */
export function coreConstructorShapeLayout(
	program: CoreProgram,
	fn: CoreFunction,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	cellForString: ReturnType<typeof coreOwnCellResolver> = coreOwnCellResolver(
		program.stringConstants,
	),
	controlFlow?: CoreControlFlow,
): CoreConstructorShapeLayout | undefined {
	if (
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.isDerivedConstructor ||
		!fn.metadata.hasPrototype
	) {
		return undefined;
	}
	let hasThisLoad = false;
	let hasShapeStore = false;
	for (const candidateBlock of fn.blocks) {
		for (const instruction of candidateBlock.instructions) {
			hasThisLoad ||= instruction.opcode === "loadThis";
			hasShapeStore ||=
				instruction.opcode === "storePropertyStatic" ||
				instruction.opcode === "defineProperty";
		}
	}
	// Canonical-root solving is the expensive part of this parser. Most ordinary
	// functions have a prototype but never initialize a receiver, so reject them
	// before building any constructor-specific value-flow state.
	if (!hasThisLoad || !hasShapeStore) return undefined;
	const cfg = controlFlow ?? buildCoreControlFlow(fn, registry);
	const orderedBlocks: Array<CoreBlock> = [];
	const seen = new Set<CoreBlockId>();
	let block = fn.entry;
	for (;;) {
		if (seen.has(block) || !cfg.reachable.has(block)) return undefined;
		seen.add(block);
		const current = fn.blocks[block];
		if (current === undefined || current.handler !== undefined) return undefined;
		orderedBlocks.push(current);
		if (current.terminator.kind === "return") break;
		if (current.terminator.kind !== "jump") return undefined;
		block = current.terminator.edge.block;
	}
	if (seen.size !== cfg.reachable.size) return undefined;

	const definitions = new Map<CoreValueId, CoreInstruction>();
	for (const current of orderedBlocks) {
		for (const instruction of current.instructions) {
			for (const output of instruction.outputs) definitions.set(output, instruction);
		}
	}
	const roots = coreCanonicalValueRoots(fn, cfg);
	const definition = (value: CoreValueId): CoreInstruction | undefined =>
		definitions.get(roots.get(value) ?? value);
	const thisRoots = new Set<CoreValueId>();
	for (const current of orderedBlocks) {
		for (const instruction of current.instructions) {
			if (instruction.opcode !== "loadThis") continue;
			for (const output of instruction.outputs) {
				thisRoots.add(roots.get(output) ?? output);
			}
		}
	}
	if (thisRoots.size === 0) return undefined;
	const isThis = (value: CoreValueId): boolean =>
		thisRoots.has(roots.get(value) ?? value);

	const keys: Array<number> = [];
	const canonicalKeys = new Set<number>();
	let anchor: CoreInstructionId | undefined;
	for (const current of orderedBlocks) {
		for (const instruction of current.instructions) {
			const receiver = instruction.inputs[0];
			if (receiver !== undefined && isThis(receiver)) {
				const stringIndex =
					instruction.opcode === "storePropertyStatic"
						? instruction.attributes.stringIndex
						: instruction.opcode === "defineProperty" &&
							  instruction.inputs.length === 3 &&
							  instruction.attributes.enumerable === true &&
							  instruction.attributes.writable !== false &&
							  instruction.attributes.configurable !== false
							? (() => {
									const key = instruction.inputs[1];
									if (key === undefined) return undefined;
									const keyDefinition = definition(key);
									return keyDefinition?.opcode === "createString"
										? keyDefinition.attributes.stringIndex
										: undefined;
								})()
							: undefined;
				if (typeof stringIndex !== "number") return undefined;
				const cell = cellForString(stringIndex);
				const units = program.stringConstants[stringIndex];
				if (
					cell?.kind !== "object-slot" ||
					units === undefined ||
					isProtoLiteralKey(units)
				) {
					return undefined;
				}
				if (!canonicalKeys.has(cell.key)) {
					if (keys.length === 64) return undefined;
					canonicalKeys.add(cell.key);
					keys.push(stringIndex);
					anchor ??= instruction.id;
				}
				continue;
			}
			if (
				instruction.opcode !== "move" &&
				instruction.inputs.some((input) => isThis(input))
			) {
				return undefined;
			}
		}
		if (current.terminator.kind === "return") {
			const returned = definition(current.terminator.value);
			if (returned?.opcode !== "createUndefined") return undefined;
		}
	}
	return anchor === undefined
		? undefined
		: Object.freeze({
				instruction: anchor,
				keyStringIndices: Object.freeze(keys),
			});
}

/** Re-prove either a literal or constructor-derived shape-origin anchor. */
export function coreShapeOriginKeys(
	program: CoreProgram,
	fn: CoreFunction,
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	cellForString: ReturnType<typeof coreOwnCellResolver> = coreOwnCellResolver(
		program.stringConstants,
	),
): ReadonlyArray<number> | undefined {
	const literal = coreShapedObjectKeys(program, instruction, cellForString);
	if (literal !== undefined) return literal;
	const constructor = coreConstructorShapeLayout(program, fn, registry, cellForString);
	return constructor?.instruction === instruction.id
		? constructor.keyStringIndices
		: undefined;
}

function valueLimit(fn: CoreFunction): number {
	let limit = 0;
	for (const { id } of fn.values) limit = Math.max(limit, id + 1);
	return limit;
}

/**
 * Find the initial shaped-object origins that may reach each Core SSA value.
 *
 * The callee-target result is an input proof, not copied metadata. A finite
 * target wires explicit ordinary-call arguments to that function's ABI
 * parameters and its ordinary returns back to the call result. Spread argument
 * packs remain open, but their receiver and result flow are still useful. An
 * open target keeps those advisory edges while opening the result; unknown
 * callers are represented by the open seeds on every formal and `loadThis`
 * value.
 */
export function analyzeCoreShapeProvenance(
	program: CoreProgram,
	options: CoreShapeProvenanceOptions = {},
): CoreShapeProvenanceAnalysis {
	const registry = options.registry ?? coreOpcodeRegistry;
	const calleeTargets =
		options.calleeTargets ?? analyzeCoreCalleeTargets(program, registry);
	const interprocedural =
		options.summaries === undefined
			? undefined
			: analyzeCoreInterproceduralValueFlow(program, options.summaries, registry);
	const executableFunctions =
		options.executableFunctions ??
		new Set(program.functions.map(({ functionIndex }) => functionIndex));
	const activeFunctions = program.functions.filter(({ functionIndex }) =>
		executableFunctions.has(functionIndex),
	);
	const controlFlow =
		options.controlFlow ?? ((fn: CoreFunction) => buildCoreControlFlow(fn, registry));
	const functionsByIndex = new Map(
		activeFunctions.map((fn) => [fn.functionIndex, fn] as const),
	);
	const knownFunctionIndices = new Set(
		program.functions.map(({ functionIndex }) => functionIndex),
	);
	const valueBase = new Map<number, number>();
	const valueLimits = new Map<number, number>();
	const returnNodes = new Map<number, number>();
	const globalNodes = new Map<number, number>();
	const capturedNodes = new Map<string, number>();
	const aggregateNodes = new Map<string, number>();
	let nodeCount = 0;
	for (const fn of activeFunctions) {
		const limit = valueLimit(fn);
		valueBase.set(fn.functionIndex, nodeCount);
		valueLimits.set(fn.functionIndex, limit);
		nodeCount += limit;
		returnNodes.set(fn.functionIndex, nodeCount++);
	}
	const valueNode = (functionIndex: number, value: CoreValueId): number =>
		valueBase.get(functionIndex)! + value;
	const globalNode = (slot: number): number => {
		let node = globalNodes.get(slot);
		if (node === undefined) {
			node = nodeCount++;
			globalNodes.set(slot, node);
		}
		return node;
	};
	const capturedNode = (owner: number, index: number): number => {
		const key = `${owner}:${index}`;
		let node = capturedNodes.get(key);
		if (node === undefined) {
			node = nodeCount++;
			capturedNodes.set(key, node);
		}
		return node;
	};
	const aggregateNode = (
		functionIndex: number,
		allocation: CoreInstructionId,
		key: number,
	): number => {
		const identity = `${functionIndex}:${allocation}:${key}`;
		let node = aggregateNodes.get(identity);
		if (node === undefined) {
			node = nodeCount++;
			aggregateNodes.set(identity, node);
		}
		return node;
	};

	const origins: Array<CoreShapeOrigin> = [];
	const originByInstruction = new Map<string, number>();
	const constructorOriginByFunction = new Map<number, number>();
	const aggregateFunctions = new Set<number>();
	const modelledAggregateAllocations = new Set<string>();
	const modelledAggregateStores = new Set<string>();
	const thisNodes = new Map<number, Array<number>>();
	const controlFlowByFunction = new Map<number, CoreControlFlow>();
	const loopBlocksByFunction = new Map<number, ReadonlySet<CoreBlockId>>();
	const cellForString = coreOwnCellResolver(program.stringConstants);
	for (const fn of activeFunctions) {
		const cfg = controlFlow(fn);
		controlFlowByFunction.set(fn.functionIndex, cfg);
		loopBlocksByFunction.set(
			fn.functionIndex,
			new Set(
				[...cfg.loops, ...cfg.irreducibleCycles].flatMap(({ blocks }) => [...blocks]),
			),
		);
		for (const block of fn.blocks) {
			if (!cfg.reachable.has(block.id)) continue;
			for (const instruction of block.instructions) {
				const keys = coreShapedObjectKeys(program, instruction, cellForString);
				if (keys !== undefined) {
					aggregateFunctions.add(fn.functionIndex);
					const origin = origins.length;
					origins.push(
						Object.freeze({
							kind: "literal",
							functionIndex: fn.functionIndex,
							instruction: instruction.id,
							keyStringIndices: keys,
						}),
					);
					originByInstruction.set(`${fn.functionIndex}\0${instruction.id}`, origin);
				}
				if (instruction.opcode === "loadThis") {
					const existing = thisNodes.get(fn.functionIndex) ?? [];
					for (const output of instruction.outputs) {
						existing.push(valueNode(fn.functionIndex, output));
					}
					thisNodes.set(fn.functionIndex, existing);
				}
			}
		}
		const constructorLayout = coreConstructorShapeLayout(
			program,
			fn,
			registry,
			cellForString,
			cfg,
		);
		if (constructorLayout !== undefined) {
			const origin = origins.length;
			origins.push(
				Object.freeze({
					kind: "constructor",
					functionIndex: fn.functionIndex,
					instruction: constructorLayout.instruction,
					keyStringIndices: constructorLayout.keyStringIndices,
				}),
			);
			originByInstruction.set(
				`${fn.functionIndex}\0${constructorLayout.instruction}`,
				origin,
			);
			constructorOriginByFunction.set(fn.functionIndex, origin);
		}
	}

	const dependents = new Map<number, Array<number>>();
	// Shape stability is a may-escape question over the complete value-flow graph.
	// Keep its reverse graph independent of the bounded candidate lattice: losing a
	// fifth advisory guard candidate must never make an allocation appear stable.
	const stabilityPredecessors = new Map<number, Array<number>>();
	const originSeeds: Array<readonly [number, number]> = [];
	const opaqueSeeds: Array<number> = [];
	let edges = 0;
	const addEdge = (source: number, destination: number): void => {
		const existing = dependents.get(source);
		if (existing === undefined) dependents.set(source, [destination]);
		else existing.push(destination);
		edges++;
		const predecessors = stabilityPredecessors.get(destination);
		if (predecessors === undefined) stabilityPredecessors.set(destination, [source]);
		else predecessors.push(source);
	};
	const addStabilityEdge = (source: number, destination: number): void => {
		const predecessors = stabilityPredecessors.get(destination);
		if (predecessors === undefined) stabilityPredecessors.set(destination, [source]);
		else predecessors.push(source);
	};
	const openOutputs = (fn: CoreFunction, instruction: CoreInstruction): void => {
		for (const output of instruction.outputs) {
			opaqueSeeds.push(valueNode(fn.functionIndex, output));
		}
	};

	for (const fn of activeFunctions) {
		const base = valueBase.get(fn.functionIndex)!;
		const node = (value: CoreValueId): number => base + value;
		const functionParameters = new Set(fn.parameters);
		const cfg = controlFlowByFunction.get(fn.functionIndex)!;
		const provenance = aggregateFunctions.has(fn.functionIndex)
			? coreProvenance(fn, cfg, program.stringConstants, {
					...(options.canonicalValues === undefined
						? {}
						: { canonicalRoots: options.canonicalValues(fn) }),
				})
			: undefined;
		const aggregateCells = new Map<CoreInstructionId, Map<number, number>>();
		for (const layout of provenance?.layouts ?? []) {
			if (layout.kind !== "named-slots") continue;
			modelledAggregateAllocations.add(`${fn.functionIndex}\0${layout.instruction}`);
			const cells = new Map<number, number>();
			aggregateCells.set(layout.instruction, cells);
			for (const [index, keyStringIndex] of layout.keys.entries()) {
				const key = cellForString(keyStringIndex);
				const initial = layout.initialValues[index];
				if (key?.kind !== "object-slot" || initial === undefined) continue;
				const cell = aggregateNode(fn.functionIndex, layout.instruction, key.key);
				cells.set(key.key, cell);
				addEdge(node(initial), cell);
				// If the carrier escapes, each value stored in one of its fields escapes
				// with it. This edge is stability-only: field contents are not possible
				// allocation origins of the carrier itself.
				addStabilityEdge(cell, node(layout.result));
				// Once the carrier escapes, unknown code can delete the field, replace
				// its descriptor, or write any value. Keep every in-image candidate but
				// never present the aggregate cell as closed.
				if (provenance?.escape(layout.instruction) === "escaped") {
					opaqueSeeds.push(cell);
				}
			}
		}
		const aggregateCellFor = (
			value: CoreValueId,
			keyStringIndex: number,
		): number | undefined => {
			const layout = provenance?.allocationOf(value);
			const key = cellForString(keyStringIndex);
			return layout?.kind === "named-slots" && key?.kind === "object-slot"
				? aggregateCells.get(layout.instruction)?.get(key.key)
				: undefined;
		};
		// Without a whole-program closure certificate, every formal remains externally
		// enterable. In a closed image, use the shared positional-call authority: a
		// formal is open only when an actual external, aggregate, or unresolved entry
		// can supply it. Named call edges below carry every in-image origin.
		for (const [index, parameter] of fn.parameters.entries()) {
			if (
				interprocedural === undefined ||
				interprocedural.parameterOpen(fn.functionIndex, index)
			) {
				opaqueSeeds.push(node(parameter));
			}
		}
		for (const block of fn.blocks) {
			if (!cfg.reachable.has(block.id)) continue;
			const incoming = (cfg.predecessors[block.id] ?? []).filter(({ from }) =>
				cfg.reachable.has(from),
			);
			for (const [index, parameter] of block.parameters.entries()) {
				const destination = node(parameter.value);
				if (block.id === fn.entry && functionParameters.has(parameter.value)) {
					continue;
				}
				if (block.id === fn.entry || parameter.role === "exception") {
					opaqueSeeds.push(destination);
					continue;
				}
				let ordinarySource = false;
				let excludedSource = false;
				for (const edge of incoming) {
					if (edge.kind !== "ordinary") {
						excludedSource = true;
						continue;
					}
					const argument = edge.arguments[index];
					if (argument === undefined) {
						excludedSource = true;
						continue;
					}
					ordinarySource = true;
					addEdge(node(argument), destination);
				}
				if (!ordinarySource || excludedSource) opaqueSeeds.push(destination);
			}

			for (const instruction of block.instructions) {
				const output = instruction.outputs[0];
				if (instruction.opcode === "createObjectShaped" && output !== undefined) {
					const origin = originByInstruction.get(
						`${fn.functionIndex}\0${instruction.id}`,
					);
					if (origin !== undefined) {
						originSeeds.push([node(output), origin]);
						for (const extra of instruction.outputs.slice(1))
							opaqueSeeds.push(node(extra));
						continue;
					}
				}
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					instruction.outputs.length === 1
				) {
					addEdge(node(instruction.inputs[0]!), node(instruction.outputs[0]!));
					continue;
				}
				if (instruction.opcode === "loadPropertyStatic" && output !== undefined) {
					const object = instruction.inputs[0];
					const stringIndex = instruction.attributes.stringIndex;
					const cell =
						object !== undefined && typeof stringIndex === "number"
							? aggregateCellFor(object, stringIndex)
							: undefined;
					if (cell !== undefined) {
						addEdge(cell, node(output));
						continue;
					}
				}
				if (instruction.opcode === "storePropertyStatic") {
					const object = instruction.inputs[0];
					const source = instruction.inputs[1];
					const stringIndex = instruction.attributes.stringIndex;
					const cell =
						object !== undefined && typeof stringIndex === "number"
							? aggregateCellFor(object, stringIndex)
							: undefined;
					if (cell !== undefined && source !== undefined) {
						addEdge(node(source), cell);
						modelledAggregateStores.add(`${fn.functionIndex}\0${instruction.id}`);
						continue;
					}
				}
				if (instruction.opcode === "loadGlobal" && output !== undefined) {
					const slot = instruction.attributes.index;
					if (typeof slot === "number") {
						addEdge(globalNode(slot), node(output));
						continue;
					}
				}
				if (instruction.opcode === "storeGlobal") {
					const slot = instruction.attributes.index;
					const source = instruction.inputs[0];
					if (typeof slot === "number" && source !== undefined) {
						addEdge(node(source), globalNode(slot));
						continue;
					}
				}
				if (instruction.opcode === "loadCaptured" && output !== undefined) {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					if (typeof owner === "number" && typeof index === "number") {
						addEdge(capturedNode(owner, index), node(output));
						continue;
					}
				}
				if (instruction.opcode === "storeCaptured") {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					const source = instruction.inputs[0];
					if (
						typeof owner === "number" &&
						typeof index === "number" &&
						source !== undefined
					) {
						addEdge(node(source), capturedNode(owner, index));
						continue;
					}
				}
				if (instruction.opcode === "loadThis") {
					if (
						interprocedural === undefined ||
						interprocedural.receiverOpen(fn.functionIndex)
					) {
						openOutputs(fn, instruction);
					}
					continue;
				}
				if (
					(instruction.opcode === "call" ||
						instruction.opcode === "callSpread" ||
						instruction.opcode === "callSpreadIterable") &&
					instruction.inputs.length >= 2 &&
					instruction.outputs.length === 1
				) {
					const result = node(instruction.outputs[0]!);
					const flattenedFunctionCall =
						instruction.opcode === "call" &&
						instruction.attributes.directFunctionCall === true;
					const targetValue = flattenedFunctionCall
						? instruction.inputs[1]!
						: instruction.inputs[0]!;
					const targetReceiver = flattenedFunctionCall
						? instruction.inputs[2]
						: instruction.inputs[1];
					const firstTargetArgument = flattenedFunctionCall ? 3 : 2;
					const targets = calleeTargets.targets(fn.functionIndex, targetValue);
					let modelledResultTarget = false;
					// directFunctionCall is guarded against the live realm method. If that
					// method changed, the original call executes and may return any shape.
					// Preserve that fallback as opaque while retaining the shifted target's
					// in-image origins as useful guarded candidates.
					let excludedResultTarget =
						targets.anyScript || targets.opaque || flattenedFunctionCall;
					for (const targetIndex of targets.functions) {
						const target = functionsByIndex.get(targetIndex);
						if (target === undefined || target.metadata.isClassConstructor) {
							excludedResultTarget = true;
							continue;
						}
						if (targetReceiver !== undefined) {
							for (const destination of thisNodes.get(targetIndex) ?? []) {
								addEdge(node(targetReceiver), destination);
							}
						}
						if (instruction.opcode === "call") {
							for (const [index, parameter] of target.parameters.entries()) {
								const argument = instruction.inputs[index + firstTargetArgument];
								if (argument !== undefined) {
									addEdge(node(argument), valueNode(targetIndex, parameter));
								}
							}
						}
						if (target.isAsync || target.isGenerator) {
							excludedResultTarget = true;
							continue;
						}
						modelledResultTarget = true;
						addEdge(returnNodes.get(targetIndex)!, result);
					}
					if (!modelledResultTarget || excludedResultTarget) opaqueSeeds.push(result);
					continue;
				}
				if (
					(instruction.opcode === "construct" ||
						instruction.opcode === "constructSpread") &&
					instruction.inputs.length >= 1 &&
					instruction.outputs.length === 1
				) {
					const result = node(instruction.outputs[0]!);
					const targets = calleeTargets.targets(fn.functionIndex, instruction.inputs[0]!);
					for (const targetIndex of targets.functions) {
						const target = functionsByIndex.get(targetIndex);
						if (target === undefined || target.isAsync || target.isGenerator) continue;
						addEdge(returnNodes.get(targetIndex)!, result);
						if (instruction.opcode === "construct") {
							const constructorOrigin = constructorOriginByFunction.get(targetIndex);
							if (constructorOrigin !== undefined) {
								originSeeds.push([result, constructorOrigin]);
							}
						}
					}
					// [[Construct]] returns a fresh receiver whenever the target completes
					// with a primitive, and unknown/Proxy targets may return any object.
					// Explicit in-image allocations returned by the constructor remain useful
					// candidates, but can never close the result's current-shape alternatives.
					// Constructor arguments deliberately remain open here: wiring every
					// construction into body formals makes an advisory result producer fan out
					// across unrelated constructor work.
					opaqueSeeds.push(result);
					continue;
				}
				openOutputs(fn, instruction);
			}
			if (block.terminator.kind === "return" && !fn.isAsync && !fn.isGenerator) {
				addEdge(node(block.terminator.value), returnNodes.get(fn.functionIndex)!);
			}
		}
	}
	// The cell identity is compiler-owned, but the complete writer set is not a
	// current-shape proof. Preserve the unknown alternative while retaining every
	// in-image shaped allocation as a guarded candidate.
	for (const node of globalNodes.values()) opaqueSeeds.push(node);
	for (const node of capturedNodes.values()) opaqueSeeds.push(node);

	const candidatesByNode = new Array<Array<number> | undefined>(nodeCount).fill(
		undefined,
	);
	const opaqueByNode = new Uint8Array(nodeCount);
	const saturatedByNode = new Uint8Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let queueIndex = 0;
	let propagations = 0;
	let saturatedValues = 0;
	const enqueue = (value: number): void => {
		if (queued[value] !== 0) return;
		queued[value] = 1;
		queue.push(value);
	};
	const raiseOpaque = (value: number): void => {
		if (opaqueByNode[value] !== 0) return;
		opaqueByNode[value] = 1;
		propagations++;
		enqueue(value);
	};
	const raiseOrigin = (value: number, origin: number): void => {
		let candidates = candidatesByNode[value];
		if (candidates?.includes(origin) === true) return;
		if (candidates === undefined) {
			candidates = [];
			candidatesByNode[value] = candidates;
		}
		if (candidates.length < CORE_SHAPE_ORIGIN_CAP) {
			candidates.push(origin);
			candidates.sort((left, right) => left - right);
			propagations++;
			enqueue(value);
			return;
		}
		if (saturatedByNode[value] === 0) {
			saturatedByNode[value] = 1;
			saturatedValues++;
		}
		raiseOpaque(value);
	};
	for (const [value, origin] of originSeeds) raiseOrigin(value, origin);
	for (const value of opaqueSeeds) raiseOpaque(value);
	while (queueIndex < queue.length) {
		const source = queue[queueIndex++]!;
		queued[source] = 0;
		const sourceCandidates = candidatesByNode[source] ?? [];
		for (const destination of dependents.get(source) ?? []) {
			for (const origin of sourceCandidates) raiseOrigin(destination, origin);
			if (opaqueByNode[source] !== 0) raiseOpaque(destination);
		}
	}

	const callSites = new Map<
		string,
		NonNullable<typeof interprocedural>["calls"][number]
	>();
	for (const call of interprocedural?.calls ?? []) {
		callSites.set(`${call.caller}\0${call.instruction.id}`, call);
	}
	const externallyReachable = new Set(
		options.summaries?.functions
			.filter(({ externallyReachable }) => externallyReachable)
			.map(({ functionIndex }) => functionIndex) ?? [],
	);
	const unsafeSeeds: Array<number> = [];
	const markInputsUnsafe = (fn: CoreFunction, instruction: CoreInstruction): void => {
		for (const input of instruction.inputs) {
			unsafeSeeds.push(valueNode(fn.functionIndex, input));
		}
	};
	const staticAccessKeepsShape = (
		fn: CoreFunction,
		instruction: CoreInstruction,
	): boolean => {
		const receiver = instruction.inputs[0];
		const stringIndex = instruction.attributes.stringIndex;
		if (receiver === undefined || typeof stringIndex !== "number") return false;
		const receiverNode = valueNode(fn.functionIndex, receiver);
		const candidateIds = candidatesByNode[receiverNode] ?? [];
		return (
			opaqueByNode[receiverNode] === 0 &&
			candidateIds.length > 0 &&
			candidateIds.every((origin) =>
				origins[origin]!.keyStringIndices.includes(stringIndex),
			)
		);
	};
	for (const fn of activeFunctions) {
		const cfg = controlFlowByFunction.get(fn.functionIndex)!;
		for (const block of fn.blocks) {
			if (!cfg.reachable.has(block.id)) continue;
			for (const instruction of block.instructions) {
				const identity = `${fn.functionIndex}\0${instruction.id}`;
				switch (instruction.opcode) {
					case "move":
					case "loadLocal":
					case "loadCaptured":
					case "loadGlobal":
					case "loadArgument":
					case "loadStaticArgument":
					case "loadThis":
					case "loadCallee":
					case "loadNewTarget":
					case "loadIntrinsic":
					case "loadArgumentCount":
					case "storeLocal":
					case "loadPrototype":
					case "isEmpty":
					case "typeofCompare":
					case "requireCoercible":
					case "throwIfTdz":
					case "guardFunctionIndex":
					case "selectShapeCase":
						break;
					case "createObjectShaped":
						if (!modelledAggregateAllocations.has(identity))
							markInputsUnsafe(fn, instruction);
						break;
					case "loadPropertyStatic":
					case "loadPropertyStaticShapeCase":
						if (!staticAccessKeepsShape(fn, instruction)) {
							const receiver = instruction.inputs[0];
							if (receiver !== undefined)
								unsafeSeeds.push(valueNode(fn.functionIndex, receiver));
						}
						break;
					case "storePropertyStatic": {
						if (!staticAccessKeepsShape(fn, instruction)) {
							const receiver = instruction.inputs[0];
							if (receiver !== undefined)
								unsafeSeeds.push(valueNode(fn.functionIndex, receiver));
						}
						if (!modelledAggregateStores.has(identity)) {
							const source = instruction.inputs[1];
							if (source !== undefined)
								unsafeSeeds.push(valueNode(fn.functionIndex, source));
						}
						break;
					}
					case "call": {
						const call = callSites.get(identity);
						const exactClosedCall =
							call !== undefined &&
							!call.open &&
							call.transfer.invocation === "call" &&
							call.transfer.arguments.kind === "positional" &&
							instruction.attributes.directFunctionCall !== true;
						if (!exactClosedCall) markInputsUnsafe(fn, instruction);
						break;
					}
					case "storeCaptured":
					case "storeGlobal":
					case "storeGlobalProperty":
						markInputsUnsafe(fn, instruction);
						break;
					default:
						// Any unmodelled observation may invoke coercion, an accessor, Proxy
						// machinery, or publish the reference. Exact lowering deliberately
						// declines rather than inferring safety from a target implementation.
						markInputsUnsafe(fn, instruction);
						break;
				}
			}
			if (block.terminator.kind === "throw") {
				unsafeSeeds.push(valueNode(fn.functionIndex, block.terminator.value));
			} else if (
				block.terminator.kind === "return" &&
				(externallyReachable.has(fn.functionIndex) || options.summaries === undefined)
			) {
				unsafeSeeds.push(valueNode(fn.functionIndex, block.terminator.value));
			}
		}
	}

	const unstableNodes = new Uint8Array(nodeCount);
	const unstableQueue: Array<number> = [];
	for (const seed of unsafeSeeds) {
		if (unstableNodes[seed] !== 0) continue;
		unstableNodes[seed] = 1;
		unstableQueue.push(seed);
	}
	for (let index = 0; index < unstableQueue.length; index++) {
		const destination = unstableQueue[index]!;
		for (const source of stabilityPredecessors.get(destination) ?? []) {
			if (unstableNodes[source] !== 0) continue;
			unstableNodes[source] = 1;
			unstableQueue.push(source);
		}
	}
	const unstableOrigins = new Uint8Array(origins.length);
	for (const [node, origin] of originSeeds) {
		if (unstableNodes[node] !== 0) unstableOrigins[origin] = 1;
	}
	const unstableOriginCount = unstableOrigins.reduce(
		(count, unstable) => count + (unstable === 0 ? 0 : 1),
		0,
	);
	const queryCache = new Map<number, CoreShapeCandidates>();
	return {
		candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates {
			if (
				knownFunctionIndices.has(functionIndex) &&
				!executableFunctions.has(functionIndex)
			) {
				return CORE_SHAPE_CANDIDATES_OPAQUE;
			}
			const base = valueBase.get(functionIndex);
			const limit = valueLimits.get(functionIndex);
			if (base === undefined || limit === undefined || value < 0 || value >= limit) {
				return CORE_SHAPE_CANDIDATES_BOTTOM;
			}
			const valueNodeIndex = base + value;
			const cached = queryCache.get(valueNodeIndex);
			if (cached !== undefined) return cached;
			const candidateIds = candidatesByNode[valueNodeIndex] ?? [];
			const opaque = opaqueByNode[valueNodeIndex] !== 0;
			if (candidateIds.length === 0) {
				return opaque ? CORE_SHAPE_CANDIDATES_OPAQUE : CORE_SHAPE_CANDIDATES_BOTTOM;
			}
			const result: CoreShapeCandidates = Object.freeze({
				origins: Object.freeze(candidateIds.map((origin) => origins[origin]!)),
				opaque,
			});
			queryCache.set(valueNodeIndex, result);
			return result;
		},
		exactOwnSlot(
			functionIndex: number,
			value: CoreValueId,
			stringIndex: number,
		): CoreExactShapeOwnSlot | undefined {
			if (options.summaries === undefined) return undefined;
			const base = valueBase.get(functionIndex);
			const limit = valueLimits.get(functionIndex);
			if (base === undefined || limit === undefined || value < 0 || value >= limit) {
				return undefined;
			}
			const node = base + value;
			const candidateIds = candidatesByNode[node] ?? [];
			if (
				opaqueByNode[node] !== 0 ||
				candidateIds.length === 0 ||
				candidateIds.some((origin) => unstableOrigins[origin] !== 0)
			) {
				return undefined;
			}
			const slots = candidateIds.map((origin) =>
				origins[origin]!.keyStringIndices.indexOf(stringIndex),
			);
			const slot = slots[0];
			if (
				slot === undefined ||
				slot < 0 ||
				slots.some((candidate) => candidate !== slot)
			) {
				return undefined;
			}
			return Object.freeze({
				slot,
				origins: Object.freeze(
					candidateIds.map((origin) =>
						Object.freeze({
							shapeFunctionIndex: origins[origin]!.functionIndex,
							shapeInstruction: origins[origin]!.instruction,
						}),
					),
				),
			});
		},
		isLoopBlock(functionIndex: number, block: CoreBlockId): boolean {
			return loopBlocksByFunction.get(functionIndex)?.has(block) === true;
		},
		origins: Object.freeze(origins),
		statistics: Object.freeze({
			nodes: nodeCount,
			edges,
			origins: origins.length,
			aggregateCellNodes: aggregateNodes.size,
			propagations,
			saturatedValues,
			stableOrigins: origins.length - unstableOriginCount,
			unstableOrigins: unstableOriginCount,
		}),
	};
}

/**
 * Rebase ephemeral provenance after closed-image function compaction.
 *
 * Compaction preserves Core value, instruction, block, and string ids. Only the
 * dense function row changes, so the proof stays in process and remaps that one
 * coordinate without another callee-target solve.
 */
export function rebaseCoreShapeProvenance(
	analysis: CoreShapeProvenanceAnalysis,
	oldToNew: ReadonlyMap<number, number>,
	compactedProgram: CoreProgram,
): CoreShapeProvenanceAnalysis {
	const newToOld = new Map<number, number>();
	for (const [oldIndex, newIndex] of oldToNew) {
		if (newToOld.has(newIndex)) {
			throw new Error(`Duplicate compacted shape-provenance function ${newIndex}`);
		}
		newToOld.set(newIndex, oldIndex);
	}
	for (const fn of compactedProgram.functions) {
		if (!newToOld.has(fn.functionIndex)) {
			throw new Error(
				`Compacted function ${fn.functionIndex} has no shape-provenance source`,
			);
		}
	}
	const remappedOrigins = new Map<CoreShapeOrigin, CoreShapeOrigin>();
	const remapOrigin = (origin: CoreShapeOrigin): CoreShapeOrigin => {
		const cached = remappedOrigins.get(origin);
		if (cached !== undefined) return cached;
		const functionIndex = oldToNew.get(origin.functionIndex);
		if (functionIndex === undefined) {
			throw new Error(
				`Core compaction removed executable shaped origin ${origin.functionIndex}:${origin.instruction}`,
			);
		}
		const remapped = Object.freeze({ ...origin, functionIndex });
		remappedOrigins.set(origin, remapped);
		return remapped;
	};
	const origins = Object.freeze(analysis.origins.map(remapOrigin));
	const queryCache = new Map<string, CoreShapeCandidates>();
	return {
		candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates {
			const key = `${functionIndex}\0${value}`;
			const cached = queryCache.get(key);
			if (cached !== undefined) return cached;
			const oldIndex = newToOld.get(functionIndex);
			if (oldIndex === undefined) return CORE_SHAPE_CANDIDATES_BOTTOM;
			const previous = analysis.candidates(oldIndex, value);
			if (previous.origins.length === 0) return previous;
			const result = Object.freeze({
				origins: Object.freeze(previous.origins.map(remapOrigin)),
				opaque: previous.opaque,
			});
			queryCache.set(key, result);
			return result;
		},
		exactOwnSlot(
			functionIndex: number,
			value: CoreValueId,
			stringIndex: number,
		): CoreExactShapeOwnSlot | undefined {
			const oldIndex = newToOld.get(functionIndex);
			if (oldIndex === undefined) return undefined;
			const exact = analysis.exactOwnSlot(oldIndex, value, stringIndex);
			if (exact === undefined) return undefined;
			const origins = exact.origins.map((origin) => {
				const remapped = oldToNew.get(origin.shapeFunctionIndex);
				if (remapped === undefined) {
					throw new Error(
						`Core compaction removed exact shaped origin ${origin.shapeFunctionIndex}:${origin.shapeInstruction}`,
					);
				}
				return Object.freeze({ ...origin, shapeFunctionIndex: remapped });
			});
			return Object.freeze({ slot: exact.slot, origins: Object.freeze(origins) });
		},
		isLoopBlock(functionIndex: number, block: CoreBlockId): boolean {
			const oldIndex = newToOld.get(functionIndex);
			return oldIndex !== undefined && analysis.isLoopBlock(oldIndex, block);
		},
		origins,
		statistics: analysis.statistics,
	};
}

export interface CoreKnownOwnSlotSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export const CORE_SHAPE_CASE_MIN_LOADS = 2;
export const CORE_SHAPE_CASE_MAX_LOADS = 16;
export const CORE_SHAPE_CASE_MAX_SPAN = 64;
const CORE_LOOP_SHAPE_CASE_MIN_LOADS = 3;

interface CoreShapeCasePlan {
	readonly positions: ReadonlyArray<number>;
	readonly receiver: CoreValueId;
	readonly candidates: ReadonlyArray<CoreShapeCaseCandidate>;
	readonly slotsByPosition: ReadonlyMap<number, ReadonlyArray<number>>;
}

function knownOwnSlotCase(
	instruction: CoreInstruction,
	provisional: ReadonlyMap<CoreInstructionId, CoreKnownOwnSlot> | undefined,
):
	| {
			readonly receiver: CoreValueId;
			readonly candidates: ReadonlyArray<CoreShapeCaseCandidate>;
			readonly slots: ReadonlyArray<number>;
	  }
	| undefined {
	if (
		instruction.opcode !== "loadPropertyStatic" ||
		instruction.inputs.length !== 1 ||
		instruction.outputs.length !== 1
	) {
		return undefined;
	}
	const claim =
		provisional?.get(instruction.id) ??
		coreKnownOwnSlotFromAttribute(instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]);
	if (claim === undefined) return undefined;
	return {
		receiver: instruction.inputs[0]!,
		candidates: claim.candidates.map(({ shapeFunctionIndex, shapeInstruction }) => ({
			shapeFunctionIndex,
			shapeInstruction,
		})),
		slots: claim.candidates.map(({ slot }) => slot),
	};
}

function sameShapeCases(
	left: ReadonlyArray<CoreShapeCaseCandidate>,
	right: ReadonlyArray<CoreShapeCaseCandidate>,
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(candidate, index) =>
				candidate.shapeFunctionIndex === right[index]?.shapeFunctionIndex &&
				candidate.shapeInstruction === right[index]?.shapeInstruction,
		)
	);
}

function immutableThisValues(fn: CoreFunction): ReadonlySet<CoreValueId> {
	if (
		fn.metadata.isDerivedConstructor ||
		fn.blocks.some((block) =>
			block.instructions.some((instruction) => instruction.opcode === "setThis"),
		)
	) {
		return new Set();
	}
	const loadThisInstructions = new Set(
		fn.blocks.flatMap((block) =>
			block.instructions.flatMap((instruction) =>
				instruction.opcode === "loadThis" ? [instruction.id] : [],
			),
		),
	);
	return new Set(
		fn.values.flatMap((value) =>
			value.definition.kind === "instruction" &&
			loadThisInstructions.has(value.definition.instruction)
				? [value.id]
				: [],
		),
	);
}

function sameShapeCaseReceiver(
	immutableThis: ReadonlySet<CoreValueId>,
	left: CoreValueId,
	right: CoreValueId,
): boolean {
	return left === right || (immutableThis.has(left) && immutableThis.has(right));
}

function findShapeCasePlans(
	fn: CoreFunction,
	block: CoreBlock,
	immutableThis: ReadonlySet<CoreValueId>,
	provisional: ReadonlyMap<CoreInstructionId, CoreKnownOwnSlot> | undefined,
): ReadonlyArray<CoreShapeCasePlan> {
	const plans: Array<CoreShapeCasePlan> = [];
	for (let start = 0; start < block.instructions.length; start++) {
		const firstInstruction = block.instructions[start]!;
		const first = knownOwnSlotCase(firstInstruction, provisional);
		if (first === undefined) continue;
		const minimumLoads =
			provisional?.has(firstInstruction.id) === true
				? CORE_SHAPE_CASE_MIN_LOADS
				: CORE_LOOP_SHAPE_CASE_MIN_LOADS;
		const positions = [start];
		const slotsByPosition = new Map<number, ReadonlyArray<number>>([
			[start, first.slots],
		]);
		for (
			let index = start + 1;
			index < block.instructions.length &&
			index - start < CORE_SHAPE_CASE_MAX_SPAN &&
			positions.length < CORE_SHAPE_CASE_MAX_LOADS;
			index++
		) {
			const instruction = block.instructions[index]!;
			const candidate = knownOwnSlotCase(instruction, provisional);
			if (
				candidate !== undefined &&
				sameShapeCaseReceiver(immutableThis, candidate.receiver, first.receiver) &&
				sameShapeCases(candidate.candidates, first.candidates)
			) {
				positions.push(index);
				slotsByPosition.set(index, candidate.slots);
				continue;
			}
			const effects = coreInstructionEffects(instruction);
			if (
				(instruction.opcode !== "loadThis" || fn.metadata.isDerivedConstructor) &&
				(effects.callsUserCode ||
					effects.maySuspend ||
					effects.mayGc ||
					effects.mayThrow ||
					effects.writes.includes("object-property"))
			) {
				break;
			}
		}
		if (positions.length < minimumLoads) continue;
		plans.push({
			positions: Object.freeze(positions),
			receiver: first.receiver,
			candidates: Object.freeze(first.candidates),
			slotsByPosition,
		});
		start = positions.at(-1)!;
	}
	return plans;
}

function consolidateKnownOwnSlotLoads(
	fn: CoreFunction,
	provisional: ReadonlyMap<CoreInstructionId, CoreKnownOwnSlot> | undefined,
): CoreFunction {
	let nextInstruction =
		Math.max(
			-1,
			...fn.blocks.flatMap((block) => [
				...block.instructions.map((instruction) => instruction.id),
				block.terminator.id,
			]),
		) + 1;
	let nextValue = Math.max(-1, ...fn.values.map(({ id }) => id)) + 1;
	const values = [...fn.values];
	const immutableThis = immutableThisValues(fn);
	let changed = false;
	const blocks = fn.blocks.map((block): CoreBlock => {
		const plans = findShapeCasePlans(fn, block, immutableThis, provisional);
		if (plans.length === 0) return block;
		changed = true;
		const firstPlanByPosition = new Map(
			plans.map((plan) => [plan.positions[0]!, plan] as const),
		);
		const planByPosition = new Map<number, CoreShapeCasePlan>();
		for (const plan of plans) {
			for (const position of plan.positions) planByPosition.set(position, plan);
		}
		const caseValueByPlan = new Map<CoreShapeCasePlan, CoreValueId>();
		const instructions: Array<CoreInstruction> = [];
		for (const [position, instruction] of block.instructions.entries()) {
			const firstPlan = firstPlanByPosition.get(position);
			if (firstPlan !== undefined) {
				const shapeInstruction = coreInstructionId(nextInstruction++);
				const shapeCase = coreValueId(nextValue++);
				caseValueByPlan.set(firstPlan, shapeCase);
				values.push({
					id: shapeCase,
					representation: "i32",
					definition: {
						kind: "instruction",
						instruction: shapeInstruction,
						index: 0,
					},
				});
				instructions.push({
					id: shapeInstruction,
					opcode: "selectShapeCase",
					inputs: [firstPlan.receiver],
					outputs: [shapeCase],
					attributes: {
						[CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE]: firstPlan.candidates.map(
							({ shapeFunctionIndex, shapeInstruction }) => ({
								shapeFunctionIndex,
								shapeInstruction,
							}),
						),
					},
				});
			}
			const plan = planByPosition.get(position);
			if (plan === undefined) {
				instructions.push(instruction);
				continue;
			}
			const shapeCase = caseValueByPlan.get(plan);
			const slots = plan.slotsByPosition.get(position);
			if (shapeCase === undefined || slots === undefined) {
				throw new Error("Malformed known-own-slot shape-case plan");
			}
			const attributes: Record<string, CoreAttributeValue> = {
				...instruction.attributes,
				[CORE_SHAPE_CASE_SLOTS_ATTRIBUTE]: [...slots],
			};
			delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
			instructions.push({
				...instruction,
				opcode: "loadPropertyStaticShapeCase",
				inputs: [plan.receiver, shapeCase],
				attributes,
			});
		}
		return { ...block, instructions };
	});
	return changed ? { ...fn, blocks, values, mutationEpoch: fn.mutationEpoch + 1 } : fn;
}

/** Retract target-facing hints before transforms or region selection mutate Core. */
export function retractCoreKnownOwnSlots(
	program: CoreProgram,
): CoreKnownOwnSlotSelection {
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		const removedShapeCases = new Set<CoreInstructionId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode === "selectShapeCase") {
					removedShapeCases.add(instruction.id);
				}
			}
		}
		let functionChanged = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.flatMap(
				(instruction): ReadonlyArray<CoreInstruction> => {
					if (instruction.opcode === "selectShapeCase") {
						changed = true;
						functionChanged = true;
						blockChanged = true;
						return [];
					}
					const clustered = instruction.opcode === "loadPropertyStaticShapeCase";
					if (
						!clustered &&
						!(CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes) &&
						!(CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE in instruction.attributes)
					) {
						return [instruction];
					}
					const attributes: Record<string, CoreAttributeValue> = {
						...instruction.attributes,
					};
					delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
					delete attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE];
					delete attributes[CORE_SHAPE_CASE_SLOTS_ATTRIBUTE];
					changed = true;
					functionChanged = true;
					blockChanged = true;
					return [
						clustered
							? {
									...instruction,
									opcode: "loadPropertyStatic",
									inputs: instruction.inputs.slice(0, 1),
									attributes,
								}
							: { ...instruction, attributes },
					];
				},
			);
			return blockChanged ? { ...block, instructions } : block;
		});
		return functionChanged
			? {
					...fn,
					blocks,
					values: fn.values.filter(
						(value) =>
							value.definition.kind !== "instruction" ||
							!removedShapeCases.has(value.definition.instruction),
					),
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
	});
	return { program: changed ? { ...program, functions } : program, changed };
}

/**
 * Attach guarded own-slot candidates to profitable residual static accesses.
 *
 * This pass owns and retracts the attribute. The access remains in Core unchanged
 * as the exact fallback; the candidate says only which initial layout a target
 * may cheaply test before executing that fallback.
 */
export function selectCoreKnownOwnSlots(
	program: CoreProgram,
	provenance: CoreShapeProvenanceAnalysis,
): CoreKnownOwnSlotSelection {
	let changed = false;
	const provisionalByFunction = new Map<
		number,
		ReadonlyMap<CoreInstructionId, CoreKnownOwnSlot>
	>();
	const functions = program.functions.map((fn): CoreFunction => {
		const claimed = new Set(fn.regions.flatMap((region) => region.claimedInstructions));
		let provisional: Map<CoreInstructionId, CoreKnownOwnSlot> | undefined;
		let functionChanged = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.map((instruction): CoreInstruction => {
				let selected: CoreKnownOwnSlot | undefined;
				let exact: CoreExactShapeOwnSlot | undefined;
				if (
					(instruction.opcode === "loadPropertyStatic" ||
						instruction.opcode === "storePropertyStatic") &&
					!claimed.has(instruction.id) &&
					instruction.inputs.length ===
						(instruction.opcode === "loadPropertyStatic" ? 1 : 2)
				) {
					const stringIndex = instruction.attributes.stringIndex;
					const receiver = instruction.inputs[0]!;
					const candidates = provenance.candidates(fn.functionIndex, receiver);
					if (typeof stringIndex === "number") {
						exact = provenance.exactOwnSlot(fn.functionIndex, receiver, stringIndex);
						const selectedCandidates: Array<CoreKnownOwnSlotCandidate> = [];
						const seenLayouts = new Set<string>();
						for (const origin of candidates.origins) {
							const slot = origin.keyStringIndices.indexOf(stringIndex);
							if (slot < 0) continue;
							// Literal shapes are interned from their ordered canonical keys. One
							// representative therefore covers identical layouts from any number of
							// allocation sites, while genuinely different layouts retain their own
							// exact pointer+slot guard.
							const layout = origin.keyStringIndices.join(",");
							if (seenLayouts.has(layout)) continue;
							seenLayouts.add(layout);
							selectedCandidates.push({
								shapeFunctionIndex: origin.functionIndex,
								shapeInstruction: origin.instruction,
								slot,
							});
						}
						if (exact === undefined && selectedCandidates.length > 0) {
							const candidate: CoreKnownOwnSlot = {
								candidates: Object.freeze(selectedCandidates),
							};
							// Raw string-index identity is conservative: the array is also the
							// runtime slot order, so an equivalent constant at another index simply
							// declines until a later canonical-key selector generalizes this proof.
							// A candidate crossing a function boundary is precision, not a
							// frequency proof. Residual property ICs are already cheap when warm,
							// so publish an independent guard only where a loop repeats the access.
							// Origins may still flow through any number of ordinary calls before
							// reaching either admission form.
							if (provenance.isLoopBlock(fn.functionIndex, block.id)) {
								selected = candidate;
							} else if (instruction.opcode === "loadPropertyStatic") {
								// Acyclic sites are not profitable as independent guarded loads.
								// Keep their proof ephemeral so only a safe repeated-load cluster
								// can consume it; every residual site stays a generic property IC.
								(provisional ??= new Map()).set(instruction.id, candidate);
							}
						}
					}
				}
				const hasExisting = CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes;
				const existing = coreKnownOwnSlotFromAttribute(
					instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
				);
				const hasExistingExact =
					CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE in instruction.attributes;
				const existingExact = coreExactShapeOwnSlotFromAttribute(
					instruction.attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE],
				);
				if (
					(selected === undefined
						? !hasExisting
						: hasExisting && knownOwnSlotsEqual(existing, selected)) &&
					(exact === undefined
						? !hasExistingExact
						: hasExistingExact && exactShapeOwnSlotsEqual(existingExact, exact))
				) {
					return instruction;
				}
				const attributes: Record<string, CoreAttributeValue> = {
					...instruction.attributes,
				};
				delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
				delete attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE];
				if (selected !== undefined) {
					attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE] = {
						candidates: selected.candidates.map((candidate) => ({
							shapeFunctionIndex: candidate.shapeFunctionIndex,
							shapeInstruction: candidate.shapeInstruction,
							slot: candidate.slot,
						})),
					};
				}
				if (exact !== undefined) {
					attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE] = {
						slot: exact.slot,
						origins: exact.origins.map((origin) => ({
							shapeFunctionIndex: origin.shapeFunctionIndex,
							shapeInstruction: origin.shapeInstruction,
						})),
					};
				}
				changed = true;
				functionChanged = true;
				blockChanged = true;
				return { ...instruction, attributes };
			});
			return blockChanged ? { ...block, instructions } : block;
		});
		if (provisional !== undefined) {
			provisionalByFunction.set(fn.functionIndex, provisional);
		}
		return functionChanged ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	});
	const clusteredFunctions = functions.map((fn) => {
		const clustered = consolidateKnownOwnSlotLoads(
			fn,
			provisionalByFunction.get(fn.functionIndex),
		);
		if (clustered !== fn) changed = true;
		return clustered;
	});
	return {
		program: changed ? { ...program, functions: clusteredFunctions } : program,
		changed,
	};
}
