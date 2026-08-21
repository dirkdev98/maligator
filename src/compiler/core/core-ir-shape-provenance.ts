/**
 * Bounded allocation-site provenance for ordinary shaped objects.
 *
 * This is deliberately not a claim about an object's current runtime shape. A
 * `createObjectShaped` origin says only which initial ordinary-object layout may
 * have produced an SSA value; user code may subsequently delete properties,
 * install accessors, change descriptors, or otherwise move the object to another
 * shape. Consumers must therefore validate the live shape and retain the original
 * operation as an exact fallback.
 *
 * The lattice keeps at most four useful origins plus an independent `opaque` bit.
 * Opaque covers every producer outside this analysis and finite overflow. Keeping
 * the bounded candidates is still useful for guarded consumers: an unlisted
 * origin simply takes their fallback. The graph contains SSA moves, ordinary
 * block arguments, and finite ordinary-call argument/return edges. It excludes
 * heap cells and call forms whose positional or result semantics are not exact in
 * Core, so the solve is one monotone worklist over O(values + edges).
 */

import { analyzeCoreCalleeTargets } from "./core-ir-call-targets.ts";
import type { CoreCalleeTargetAnalysis } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreOwnCellResolver } from "./core-ir-provenance.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlock,
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

export interface CoreKnownOwnSlot {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
	readonly slot: number;
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
	if (
		Object.keys(record).length !== 3 ||
		!isNonnegativeSafeInteger(record.shapeFunctionIndex) ||
		!isNonnegativeSafeInteger(record.shapeInstruction) ||
		!isNonnegativeSafeInteger(record.slot)
	) {
		return undefined;
	}
	return Object.freeze({
		shapeFunctionIndex: record.shapeFunctionIndex,
		shapeInstruction: coreInstructionId(record.shapeInstruction),
		slot: record.slot,
	});
}

function knownOwnSlotsEqual(
	left: CoreKnownOwnSlot | undefined,
	right: CoreKnownOwnSlot | undefined,
): boolean {
	return (
		left?.shapeFunctionIndex === right?.shapeFunctionIndex &&
		left?.shapeInstruction === right?.shapeInstruction &&
		left?.slot === right?.slot
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
	/** Strict node-state rises during the bounded solve. */
	readonly propagations: number;
	/** Values that observed more origins than the finite candidate bound. */
	readonly saturatedValues: number;
}

export interface CoreShapeProvenanceAnalysis {
	candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates;
	readonly origins: ReadonlyArray<CoreShapeOrigin>;
	readonly statistics: CoreShapeProvenanceStatistics;
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

function valueLimit(fn: CoreFunction): number {
	let limit = 0;
	for (const { id } of fn.values) limit = Math.max(limit, id + 1);
	return limit;
}

/**
 * Find the initial shaped-object origins that may reach each Core SSA value.
 *
 * The callee-target result is an input proof, not copied metadata. A finite
 * target wires actual arguments to that function's ABI parameters and its
 * ordinary returns back to the call result. An open target keeps those advisory
 * edges while opening the result; unknown callers are represented by the open
 * seeds on every formal and `loadThis` value.
 */
export function analyzeCoreShapeProvenance(
	program: CoreProgram,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	calleeTargets: CoreCalleeTargetAnalysis = analyzeCoreCalleeTargets(program, registry),
): CoreShapeProvenanceAnalysis {
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	const valueBase = new Map<number, number>();
	const valueLimits = new Map<number, number>();
	const returnNodes = new Map<number, number>();
	let nodeCount = 0;
	for (const fn of program.functions) {
		const limit = valueLimit(fn);
		valueBase.set(fn.functionIndex, nodeCount);
		valueLimits.set(fn.functionIndex, limit);
		nodeCount += limit;
		returnNodes.set(fn.functionIndex, nodeCount++);
	}
	const valueNode = (functionIndex: number, value: CoreValueId): number =>
		valueBase.get(functionIndex)! + value;

	const origins: Array<CoreShapeOrigin> = [];
	const originByInstruction = new Map<string, number>();
	const thisNodes = new Map<number, Array<number>>();
	const cellForString = coreOwnCellResolver(program.stringConstants);
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const keys = coreShapedObjectKeys(program, instruction, cellForString);
				if (keys !== undefined) {
					const origin = origins.length;
					origins.push(
						Object.freeze({
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
	}

	const dependents = new Map<number, Array<number>>();
	const originSeeds: Array<readonly [number, number]> = [];
	const opaqueSeeds: Array<number> = [];
	let edges = 0;
	const addEdge = (source: number, destination: number): void => {
		const existing = dependents.get(source);
		if (existing === undefined) dependents.set(source, [destination]);
		else existing.push(destination);
		edges++;
	};
	const openOutputs = (fn: CoreFunction, instruction: CoreInstruction): void => {
		for (const output of instruction.outputs) {
			opaqueSeeds.push(valueNode(fn.functionIndex, output));
		}
	};

	for (const fn of program.functions) {
		const base = valueBase.get(fn.functionIndex)!;
		const node = (value: CoreValueId): number => base + value;
		const cfg = buildCoreControlFlow(fn, registry);
		// A function can always be entered by code this candidate graph does not name.
		// Known calls add useful origins below, but never turn a formal into a closed
		// current-shape proof.
		for (const parameter of fn.parameters) opaqueSeeds.push(node(parameter));
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				const destination = node(parameter.value);
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
				if (instruction.opcode === "loadThis") {
					openOutputs(fn, instruction);
					continue;
				}
				if (
					instruction.opcode === "call" &&
					instruction.inputs.length >= 2 &&
					instruction.outputs.length === 1
				) {
					const result = node(instruction.outputs[0]!);
					const targets = calleeTargets.targets(fn.functionIndex, instruction.inputs[0]!);
					let modelledResultTarget = false;
					let excludedResultTarget = targets.anyScript || targets.opaque;
					for (const targetIndex of targets.functions) {
						const target = functionsByIndex.get(targetIndex);
						if (target === undefined || target.metadata.isClassConstructor) {
							excludedResultTarget = true;
							continue;
						}
						const receiver = instruction.inputs[1]!;
						for (const destination of thisNodes.get(targetIndex) ?? []) {
							addEdge(node(receiver), destination);
						}
						for (const [index, parameter] of target.parameters.entries()) {
							const argument = instruction.inputs[index + 2];
							if (argument !== undefined) {
								addEdge(node(argument), valueNode(targetIndex, parameter));
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
				openOutputs(fn, instruction);
			}
			if (block.terminator.kind === "return" && !fn.isAsync && !fn.isGenerator) {
				addEdge(node(block.terminator.value), returnNodes.get(fn.functionIndex)!);
			}
		}
	}

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

	const queryCache = new Map<number, CoreShapeCandidates>();
	return {
		candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates {
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
		origins: Object.freeze(origins),
		statistics: Object.freeze({
			nodes: nodeCount,
			edges,
			origins: origins.length,
			propagations,
			saturatedValues,
		}),
	};
}

export interface CoreKnownOwnSlotSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

/**
 * Attach guarded own-slot candidates to profitable residual static loads.
 *
 * This pass owns and retracts the attribute. The load remains in Core unchanged
 * as the exact fallback; the candidate says only which initial layout a target
 * may cheaply test before executing that fallback.
 */
export function selectCoreKnownOwnSlots(
	program: CoreProgram,
	provenance: CoreShapeProvenanceAnalysis,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): CoreKnownOwnSlotSelection {
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		const claimed = new Set(fn.regions.flatMap((region) => region.claimedInstructions));
		const cfg = buildCoreControlFlow(fn, registry);
		const loopBlocks = new Set(
			[...cfg.loops, ...cfg.irreducibleCycles].flatMap((loop) => [...loop.blocks]),
		);
		let functionChanged = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.map((instruction): CoreInstruction => {
				let selected: CoreKnownOwnSlot | undefined;
				if (
					instruction.opcode === "loadPropertyStatic" &&
					!claimed.has(instruction.id) &&
					instruction.inputs.length === 1
				) {
					const stringIndex = instruction.attributes.stringIndex;
					const receiver = instruction.inputs[0]!;
					const candidates = provenance.candidates(fn.functionIndex, receiver);
					if (typeof stringIndex === "number" && candidates.origins.length === 1) {
						const origin = candidates.origins[0]!;
						// Raw string-index identity is conservative: the array is also the
						// runtime slot order, so an equivalent constant at another index simply
						// declines until a later canonical-key selector generalizes this proof.
						const slot = origin.keyStringIndices.indexOf(stringIndex);
						if (
							slot >= 0 &&
							(origin.functionIndex !== fn.functionIndex || loopBlocks.has(block.id))
						) {
							selected = {
								shapeFunctionIndex: origin.functionIndex,
								shapeInstruction: origin.instruction,
								slot,
							};
						}
					}
				}
				const hasExisting = CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes;
				const existing = coreKnownOwnSlotFromAttribute(
					instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
				);
				if (
					selected === undefined
						? !hasExisting
						: hasExisting && knownOwnSlotsEqual(existing, selected)
				) {
					return instruction;
				}
				const attributes: Record<string, CoreAttributeValue> = {
					...instruction.attributes,
				};
				delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
				if (selected !== undefined) {
					attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE] = {
						shapeFunctionIndex: selected.shapeFunctionIndex,
						shapeInstruction: selected.shapeInstruction,
						slot: selected.slot,
					};
				}
				changed = true;
				functionChanged = true;
				blockChanged = true;
				return { ...instruction, attributes };
			});
			return blockChanged ? { ...block, instructions } : block;
		});
		return functionChanged ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	});
	return {
		program: changed ? { ...program, functions } : program,
		changed,
	};
}
