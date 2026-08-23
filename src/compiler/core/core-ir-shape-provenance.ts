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
 * block arguments, compiler-owned global/captured cells, and finite ordinary-call
 * argument/return edges. Cells remain open, but in-image stores still contribute
 * guarded candidates. It excludes aggregate heap cells and call forms whose
 * positional or result semantics are not exact in Core, so the solve is one
 * monotone worklist over O(values + cells + edges).
 */

import { analyzeCoreCalleeTargets } from "./core-ir-call-targets.ts";
import type { CoreCalleeTargetAnalysis } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreOwnCellResolver, coreProvenance } from "./core-ir-provenance.ts";
import { coreInstructionId } from "./core-ir.ts";
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

export interface CoreKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
	readonly slot: number;
}

export interface CoreKnownOwnSlot {
	readonly candidates: ReadonlyArray<CoreKnownOwnSlotCandidate>;
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
	/** Compiler-created object fields carrying candidate values. */
	readonly aggregateCellNodes: number;
	/** Strict node-state rises during the bounded solve. */
	readonly propagations: number;
	/** Values that observed more origins than the finite candidate bound. */
	readonly saturatedValues: number;
}

export interface CoreShapeProvenanceAnalysis {
	candidates(functionIndex: number, value: CoreValueId): CoreShapeCandidates;
	isLoopBlock(functionIndex: number, block: CoreBlockId): boolean;
	readonly origins: ReadonlyArray<CoreShapeOrigin>;
	readonly statistics: CoreShapeProvenanceStatistics;
}

export interface CoreShapeProvenanceOptions {
	readonly registry?: CoreOpcodeRegistry;
	readonly calleeTargets?: CoreCalleeTargetAnalysis;
	readonly controlFlow?: (fn: CoreFunction) => CoreControlFlow;
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
	options: CoreShapeProvenanceOptions = {},
): CoreShapeProvenanceAnalysis {
	const registry = options.registry ?? coreOpcodeRegistry;
	const calleeTargets =
		options.calleeTargets ?? analyzeCoreCalleeTargets(program, registry);
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
	const aggregateFunctions = new Set<number>();
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

	for (const fn of activeFunctions) {
		const base = valueBase.get(fn.functionIndex)!;
		const node = (value: CoreValueId): number => base + value;
		const cfg = controlFlowByFunction.get(fn.functionIndex)!;
		const provenance = aggregateFunctions.has(fn.functionIndex)
			? coreProvenance(fn, cfg, program.stringConstants)
			: undefined;
		const aggregateCells = new Map<CoreInstructionId, Map<number, number>>();
		for (const layout of provenance?.layouts ?? []) {
			if (layout.kind !== "named-slots") continue;
			const cells = new Map<number, number>();
			aggregateCells.set(layout.instruction, cells);
			for (const [index, keyStringIndex] of layout.keys.entries()) {
				const key = cellForString(keyStringIndex);
				const initial = layout.initialValues[index];
				if (key?.kind !== "object-slot" || initial === undefined) continue;
				const cell = aggregateNode(fn.functionIndex, layout.instruction, key.key);
				cells.set(key.key, cell);
				addEdge(node(initial), cell);
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
		// A function can always be entered by code this candidate graph does not name.
		// Known calls add useful origins below, but never turn a formal into a closed
		// current-shape proof.
		for (const parameter of fn.parameters) opaqueSeeds.push(node(parameter));
		for (const block of fn.blocks) {
			if (!cfg.reachable.has(block.id)) continue;
			const incoming = (cfg.predecessors[block.id] ?? []).filter(({ from }) =>
				cfg.reachable.has(from),
			);
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

/** Retract target-facing hints before transforms or region selection mutate Core. */
export function retractCoreKnownOwnSlots(
	program: CoreProgram,
): CoreKnownOwnSlotSelection {
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		let functionChanged = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			let blockChanged = false;
			const instructions = block.instructions.map((instruction): CoreInstruction => {
				if (!(CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes)) {
					return instruction;
				}
				const attributes: Record<string, CoreAttributeValue> = {
					...instruction.attributes,
				};
				delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
				changed = true;
				functionChanged = true;
				blockChanged = true;
				return { ...instruction, attributes };
			});
			return blockChanged ? { ...block, instructions } : block;
		});
		return functionChanged ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	});
	return { program: changed ? { ...program, functions } : program, changed };
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
): CoreKnownOwnSlotSelection {
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		const claimed = new Set(fn.regions.flatMap((region) => region.claimedInstructions));
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
					if (typeof stringIndex === "number") {
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
						if (selectedCandidates.length > 0) {
							// Raw string-index identity is conservative: the array is also the
							// runtime slot order, so an equivalent constant at another index simply
							// declines until a later canonical-key selector generalizes this proof.
							// A candidate crossing a function boundary is precision, not a
							// frequency proof. Residual property ICs are already cheap when warm,
							// so publish extra guarded output only where the load itself repeats.
							// Origins may still flow through any number of ordinary calls before
							// reaching this loop-resident consumer.
							if (provenance.isLoopBlock(fn.functionIndex, block.id)) {
								selected = {
									candidates: Object.freeze(selectedCandidates),
								};
							}
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
						candidates: selected.candidates.map((candidate) => ({
							shapeFunctionIndex: candidate.shapeFunctionIndex,
							shapeInstruction: candidate.shapeInstruction,
							slot: candidate.slot,
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
		return functionChanged ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	});
	return {
		program: changed ? { ...program, functions } : program,
		changed,
	};
}
