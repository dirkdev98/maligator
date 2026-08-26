/**
 * Closed value-class provenance for immutable heap brands.
 *
 * The graph follows identity-preserving SSA edges, compiler-certified
 * single-assignment global/captured cells, and private fields whose hidden key is
 * held in one of those captured cells. A closed candidate set materializes as an
 * exact native brand, not a speculative guard. Object escape does not invalidate
 * an immutable ECMAScript brand; unknown writers to a value-bearing cell do.
 */

import { exactBuiltinCallDescriptor } from "../shared/builtin-registry.ts";
import type { CompilerNumericTypedArrayKind } from "../shared/compiler-instruction.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	analyzeCoreInterproceduralValueFlow,
	coreCallReceiver,
	corePositionalCallArguments,
} from "./core-ir-interprocedural-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { analyzeCoreProgramSummaries } from "./core-ir-summaries.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreAttributeValue,
	CoreAttributeObject,
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

export const CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE = "exactTypedArrayKind";
export const CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE = "exactCollectionReceiver";

export type CoreNumericTypedArrayKind = CompilerNumericTypedArrayKind;
export type CoreExactCollectionBrand = "Map" | "Set";
export type CoreExactHeapBrand = CoreNumericTypedArrayKind | CoreExactCollectionBrand;

const NUMERIC_TYPED_ARRAY_KINDS: ReadonlySet<string> = new Set([
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

export function coreNumericTypedArrayKind(
	value: unknown,
): CoreNumericTypedArrayKind | undefined {
	return typeof value === "string" && NUMERIC_TYPED_ARRAY_KINDS.has(value)
		? (value as CoreNumericTypedArrayKind)
		: undefined;
}

export function coreExactCollectionBrand(
	value: unknown,
): CoreExactCollectionBrand | undefined {
	return value === "Map" || value === "Set" ? value : undefined;
}

function coreExactHeapBrand(value: unknown): CoreExactHeapBrand | undefined {
	return coreNumericTypedArrayKind(value) ?? coreExactCollectionBrand(value);
}

interface HeapBrandOrigin {
	readonly brand: CoreExactHeapBrand;
	readonly functionIndex: number;
	readonly instruction: CoreInstructionId;
}

export interface CoreValueClassAnalysis {
	exactHeapBrand(
		functionIndex: number,
		value: CoreValueId,
		at: CoreInstructionId,
	): CoreExactHeapBrand | undefined;
	exactNumericTypedArray(
		functionIndex: number,
		value: CoreValueId,
		at: CoreInstructionId,
	): CoreNumericTypedArrayKind | undefined;
	containedCollection(
		functionIndex: number,
		value: CoreValueId,
		at: CoreInstructionId,
	): CoreExactCollectionBrand | undefined;
}

function valueLimit(fn: CoreFunction): number {
	let limit = 0;
	for (const { id } of fn.values) limit = Math.max(limit, id + 1);
	return limit;
}

function capturedKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

/** Solve immutable heap brands through local SSA and stable compiler cells. */
export function analyzeCoreValueClasses(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	controlFlow: (fn: CoreFunction) => CoreControlFlow = (fn) =>
		buildCoreControlFlow(fn, coreOpcodeRegistry),
	summaries?: CoreProgramSummaries,
): CoreValueClassAnalysis {
	if (context?.facts.world.primordialPolicy !== "locked") {
		return {
			exactHeapBrand: () => undefined,
			exactNumericTypedArray: () => undefined,
			containedCollection: () => undefined,
		};
	}
	const functions = program.functions;
	const functionsByIndex = new Map(
		functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	const valueBases = new Map<number, number>();
	const valueLimits = new Map<number, number>();
	const receiverNodes = new Map<number, number>();
	const returnNodes = new Map<number, number>();
	let nodeCount = 0;
	for (const fn of functions) {
		const limit = valueLimit(fn);
		valueBases.set(fn.functionIndex, nodeCount);
		valueLimits.set(fn.functionIndex, limit);
		nodeCount += limit;
		receiverNodes.set(fn.functionIndex, nodeCount++);
		returnNodes.set(fn.functionIndex, nodeCount++);
	}
	const wholeProgram =
		summaries ?? analyzeCoreProgramSummaries(program, coreOpcodeRegistry, context);
	const interprocedural = analyzeCoreInterproceduralValueFlow(
		program,
		wholeProgram,
		coreOpcodeRegistry,
	);
	const stableGlobals = new Set(context.data.singleAssignmentGlobalSlots);
	const stableCaptured = new Set(
		context.data.singleAssignmentCapturedSlots.map(({ owner, index }) =>
			capturedKey(owner, index),
		),
	);
	const globalNodes = new Map<number, number>();
	const capturedNodes = new Map<string, number>();
	const privateNodes = new Map<string, number>();
	const globalNode = (slot: number): number => {
		let node = globalNodes.get(slot);
		if (node === undefined) {
			node = nodeCount++;
			globalNodes.set(slot, node);
		}
		return node;
	};
	const capturedNode = (owner: number, index: number): number => {
		const key = capturedKey(owner, index);
		let node = capturedNodes.get(key);
		if (node === undefined) {
			node = nodeCount++;
			capturedNodes.set(key, node);
		}
		return node;
	};
	const privateNode = (key: string): number => {
		let node = privateNodes.get(key);
		if (node === undefined) {
			node = nodeCount++;
			privateNodes.set(key, node);
		}
		return node;
	};
	const valueNode = (functionIndex: number, value: CoreValueId): number =>
		valueBases.get(functionIndex)! + value;
	const dependents = new Map<number, Array<number>>();
	const addEdge = (source: number, destination: number): void => {
		const existing = dependents.get(source);
		if (existing === undefined) dependents.set(source, [destination]);
		else existing.push(destination);
	};
	const origins: Array<HeapBrandOrigin> = [];
	const originSeeds: Array<readonly [number, number]> = [];
	const opaqueSeeds: Array<number> = [];
	const emptySeeds: Array<number> = [];
	const rootsByFunction = new Map<number, ReadonlyMap<CoreValueId, CoreValueId>>();
	const cfgByFunction = new Map<number, CoreControlFlow>();
	const locationsByFunction = new Map<
		number,
		Map<CoreInstructionId, { readonly block: CoreBlockId; readonly position: number }>
	>();
	const definitionsByFunction = new Map<
		number,
		ReadonlyMap<CoreValueId, CoreInstruction>
	>();
	const safeCellStores = new Set<string>();
	const safePrivateStores = new Set<string>();
	const instructionKey = (
		functionIndex: number,
		instruction: CoreInstructionId,
	): string => `${functionIndex}:${instruction}`;
	for (const fn of functions) {
		const functionParameters = new Set(fn.parameters);
		const cfg = controlFlow(fn);
		cfgByFunction.set(fn.functionIndex, cfg);
		const roots = coreCanonicalValueRoots(fn, cfg);
		rootsByFunction.set(fn.functionIndex, roots);
		const definitions = new Map<CoreValueId, CoreInstruction>();
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlockId; readonly position: number }
		>();
		for (const block of fn.blocks) {
			for (const [position, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block: block.id, position });
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		locationsByFunction.set(fn.functionIndex, locations);
		definitionsByFunction.set(fn.functionIndex, definitions);
		const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
		const privateKey = (value: CoreValueId): string | undefined => {
			const definition = definitions.get(root(value));
			if (definition?.opcode !== "loadCaptured") return undefined;
			const owner = definition.attributes.functionIndex;
			const index = definition.attributes.index;
			if (
				typeof owner !== "number" ||
				typeof index !== "number" ||
				!stableCaptured.has(capturedKey(owner, index))
			) {
				return undefined;
			}
			return capturedKey(owner, index);
		};
		for (const [index, parameter] of fn.parameters.entries()) {
			if (interprocedural.parameterOpen(fn.functionIndex, index)) {
				opaqueSeeds.push(valueNode(fn.functionIndex, parameter));
			}
		}
		if (interprocedural.receiverOpen(fn.functionIndex)) {
			opaqueSeeds.push(receiverNodes.get(fn.functionIndex)!);
		}
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				const destination = valueNode(fn.functionIndex, parameter.value);
				if (block.id === fn.entry && functionParameters.has(parameter.value)) {
					// Open formals were seeded above; closed formals receive only named
					// call-edge inputs later. Do not overwrite those inputs with opacity.
					continue;
				}
				let ordinary = false;
				let excluded = block.id === fn.entry || parameter.role === "exception";
				for (const edge of incoming) {
					if (edge.kind !== "ordinary" || edge.arguments[index] === undefined) {
						excluded = true;
						continue;
					}
					ordinary = true;
					addEdge(valueNode(fn.functionIndex, edge.arguments[index]), destination);
				}
				if (!ordinary || excluded) opaqueSeeds.push(destination);
			}
			for (const instruction of block.instructions) {
				const output = instruction.outputs[0];
				if (instruction.opcode === "loadThis" && output !== undefined) {
					addEdge(
						receiverNodes.get(fn.functionIndex)!,
						valueNode(fn.functionIndex, output),
					);
					for (const extra of instruction.outputs.slice(1)) {
						opaqueSeeds.push(valueNode(fn.functionIndex, extra));
					}
					continue;
				}
				if (instruction.opcode === "construct" && output !== undefined) {
					const callee = instruction.inputs[0];
					const calleeDefinition =
						callee === undefined ? undefined : definitions.get(root(callee));
					const brand = coreExactHeapBrand(calleeDefinition?.attributes.intrinsic);
					if (brand !== undefined && instruction.inputs.length >= 1) {
						const origin = origins.length;
						origins.push({
							brand,
							functionIndex: fn.functionIndex,
							instruction: instruction.id,
						});
						originSeeds.push([valueNode(fn.functionIndex, output), origin]);
						for (const extra of instruction.outputs.slice(1)) {
							opaqueSeeds.push(valueNode(fn.functionIndex, extra));
						}
						continue;
					}
				}
				const transfer = coreOpcodeRegistry.get(instruction.opcode)?.callTransfer;
				if (transfer?.result === "call-completion" && output !== undefined) {
					for (const extra of instruction.outputs.slice(1)) {
						opaqueSeeds.push(valueNode(fn.functionIndex, extra));
					}
					continue;
				}
				if (instruction.opcode === "loadPrivate" && output !== undefined) {
					const key = instruction.inputs[1];
					const resolved = key === undefined ? undefined : privateKey(key);
					if (resolved === undefined) {
						opaqueSeeds.push(valueNode(fn.functionIndex, output));
					} else {
						addEdge(privateNode(resolved), valueNode(fn.functionIndex, output));
					}
					continue;
				}
				if (
					instruction.opcode === "storePrivate" ||
					instruction.opcode === "definePrivate"
				) {
					const key = instruction.inputs[1];
					const source = instruction.inputs[2];
					const resolved = key === undefined ? undefined : privateKey(key);
					if (resolved !== undefined && source !== undefined) {
						addEdge(valueNode(fn.functionIndex, source), privateNode(resolved));
						safePrivateStores.add(instructionKey(fn.functionIndex, instruction.id));
					}
					continue;
				}
				if (instruction.opcode === "initPrivateFields") {
					for (const key of instruction.inputs.slice(1)) {
						const resolved = privateKey(key);
						if (resolved !== undefined) opaqueSeeds.push(privateNode(resolved));
					}
					continue;
				}
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					instruction.outputs.length === 1
				) {
					addEdge(
						valueNode(fn.functionIndex, instruction.inputs[0]!),
						valueNode(fn.functionIndex, instruction.outputs[0]!),
					);
					continue;
				}
				if (instruction.opcode === "loadCaptured" && output !== undefined) {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					if (
						typeof owner === "number" &&
						typeof index === "number" &&
						stableCaptured.has(capturedKey(owner, index))
					) {
						const cell = capturedNode(owner, index);
						addEdge(cell, valueNode(fn.functionIndex, output));
						emptySeeds.push(cell);
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
						source !== undefined &&
						stableCaptured.has(capturedKey(owner, index))
					) {
						const cell = capturedNode(owner, index);
						if (definitions.get(root(source))?.opcode === "createEmpty") {
							emptySeeds.push(cell);
							continue;
						}
						addEdge(valueNode(fn.functionIndex, source), cell);
						safeCellStores.add(instructionKey(fn.functionIndex, instruction.id));
						continue;
					}
				}
				if (instruction.opcode === "loadGlobal" && output !== undefined) {
					const slot = instruction.attributes.index;
					if (typeof slot === "number" && stableGlobals.has(slot)) {
						const cell = globalNode(slot);
						addEdge(cell, valueNode(fn.functionIndex, output));
						emptySeeds.push(cell);
						continue;
					}
				}
				if (instruction.opcode === "storeGlobal") {
					const slot = instruction.attributes.index;
					const source = instruction.inputs[0];
					if (
						typeof slot === "number" &&
						source !== undefined &&
						stableGlobals.has(slot)
					) {
						const cell = globalNode(slot);
						if (definitions.get(root(source))?.opcode === "createEmpty") {
							emptySeeds.push(cell);
							continue;
						}
						addEdge(valueNode(fn.functionIndex, source), cell);
						safeCellStores.add(instructionKey(fn.functionIndex, instruction.id));
						continue;
					}
				}
				for (const value of instruction.outputs) {
					opaqueSeeds.push(valueNode(fn.functionIndex, value));
				}
			}
			if (block.terminator.kind === "return") {
				addEdge(
					valueNode(fn.functionIndex, block.terminator.value),
					returnNodes.get(fn.functionIndex)!,
				);
			}
		}
	}

	for (const call of interprocedural.calls) {
		const arguments_ = corePositionalCallArguments(call);
		const receiver = coreCallReceiver(call);
		for (const target of call.targets) {
			if (arguments_ !== undefined) {
				for (const [index, parameter] of target.parameters.entries()) {
					const argument = arguments_[index];
					if (argument !== undefined) {
						addEdge(
							valueNode(call.caller, argument),
							valueNode(target.functionIndex, parameter),
						);
					}
				}
			}
			if (receiver !== undefined) {
				addEdge(
					valueNode(call.caller, receiver),
					receiverNodes.get(target.functionIndex)!,
				);
			}
		}
		const result = call.instruction.outputs[0];
		if (call.transfer.result !== "call-completion" || result === undefined) continue;
		const resultNode = valueNode(call.caller, result);
		if (call.open) opaqueSeeds.push(resultNode);
		for (const target of call.targets) {
			if (target.isAsync || target.isGenerator) {
				opaqueSeeds.push(resultNode);
				continue;
			}
			addEdge(returnNodes.get(target.functionIndex)!, resultNode);
		}
	}

	const candidates = new Array<Array<number> | undefined>(nodeCount).fill(undefined);
	const opaque = new Uint8Array(nodeCount);
	const maybeEmpty = new Uint8Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let queueIndex = 0;
	const enqueue = (node: number): void => {
		if (queued[node] !== 0) return;
		queued[node] = 1;
		queue.push(node);
	};
	const raiseBit = (bits: Uint8Array, node: number): void => {
		if (bits[node] !== 0) return;
		bits[node] = 1;
		enqueue(node);
	};
	const raiseOrigin = (node: number, origin: number): void => {
		let values = candidates[node];
		if (values?.includes(origin) === true) return;
		if (values === undefined) {
			values = [];
			candidates[node] = values;
		}
		if (values.length === 4) {
			raiseBit(opaque, node);
			return;
		}
		values.push(origin);
		values.sort((left, right) => left - right);
		enqueue(node);
	};
	for (const [node, origin] of originSeeds) raiseOrigin(node, origin);
	for (const node of opaqueSeeds) raiseBit(opaque, node);
	for (const node of emptySeeds) raiseBit(maybeEmpty, node);
	while (queueIndex < queue.length) {
		const source = queue[queueIndex++]!;
		queued[source] = 0;
		for (const destination of dependents.get(source) ?? []) {
			for (const origin of candidates[source] ?? []) raiseOrigin(destination, origin);
			if (opaque[source] !== 0) raiseBit(opaque, destination);
			if (maybeEmpty[source] !== 0) raiseBit(maybeEmpty, destination);
		}
	}

	const unsafeOrigins = new Uint8Array(origins.length);
	const decodeStaticKey = (
		instruction: CoreInstruction | undefined,
	): string | undefined => {
		if (instruction?.opcode !== "loadPropertyStatic") return undefined;
		const stringIndex = instruction.attributes.stringIndex;
		const units =
			typeof stringIndex === "number" ? program.stringConstants[stringIndex] : undefined;
		return units === undefined ? undefined : String.fromCharCode(...units);
	};
	const collectionReceiverCallKey = (
		fn: CoreFunction,
		instruction: CoreInstruction,
	): string | undefined => {
		if (instruction.opcode !== "call" || instruction.inputs.length < 2) return undefined;
		const roots = rootsByFunction.get(fn.functionIndex)!;
		const definitions = definitionsByFunction.get(fn.functionIndex)!;
		const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
		const property = definitions.get(root(instruction.inputs[0]!));
		if (
			property?.inputs.length !== 1 ||
			root(property.inputs[0]!) !== root(instruction.inputs[1]!)
		) {
			return undefined;
		}
		return decodeStaticKey(property);
	};
	const keySafeForBrand = (key: string | undefined, brand: CoreExactHeapBrand): boolean =>
		brand === "Map"
			? key === "get" ||
				key === "set" ||
				key === "has" ||
				key === "delete" ||
				key === "keys" ||
				key === "values" ||
				key === "entries" ||
				key === "clear"
			: brand === "Set"
				? key === "add" ||
					key === "has" ||
					key === "delete" ||
					key === "keys" ||
					key === "values" ||
					key === "entries" ||
					key === "clear"
				: false;
	const markUnsafe = (
		functionIndex: number,
		value: CoreValueId,
		allow?: (brand: CoreExactHeapBrand) => boolean,
	): void => {
		const node = valueNode(functionIndex, value);
		for (const origin of candidates[node] ?? []) {
			const brand = origins[origin]!.brand;
			if (allow?.(brand) === true) continue;
			unsafeOrigins[origin] = 1;
		}
	};
	for (const fn of functions) {
		const usedValues = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const input of instruction.inputs) usedValues.add(input);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const argument of edge.arguments) usedValues.add(argument);
			}
			if (block.terminator.kind === "branch" || block.terminator.kind === "guard") {
				usedValues.add(block.terminator.condition);
			} else if (block.terminator.kind === "switch") {
				usedValues.add(block.terminator.discriminant);
			} else if (
				block.terminator.kind === "return" ||
				block.terminator.kind === "throw"
			) {
				usedValues.add(block.terminator.value);
			}
			for (const argument of block.handler?.arguments ?? []) usedValues.add(argument);
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const site = instructionKey(fn.functionIndex, instruction.id);
				const receiverKey = collectionReceiverCallKey(fn, instruction);
				for (const [index, input] of instruction.inputs.entries()) {
					if (instruction.opcode === "move" && index === 0) continue;
					if (
						(instruction.opcode === "storeCaptured" ||
							instruction.opcode === "storeGlobal") &&
						index === 0 &&
						safeCellStores.has(site)
					) {
						continue;
					}
					if (
						(instruction.opcode === "storePrivate" ||
							instruction.opcode === "definePrivate") &&
						index === 2 &&
						safePrivateStores.has(site)
					) {
						continue;
					}
					if (
						(instruction.opcode === "loadPrivate" ||
							instruction.opcode === "hasPrivate" ||
							instruction.opcode === "storePrivate" ||
							instruction.opcode === "definePrivate") &&
						index === 0
					) {
						continue;
					}
					if (instruction.opcode === "loadPropertyStatic" && index === 0) continue;
					if (instruction.opcode === "getIterator" && index === 0) continue;
					if (
						(instruction.opcode === "throwIfTdz" ||
							instruction.opcode === "isEmpty" ||
							instruction.opcode === "requireCoercible") &&
						index === 0
					) {
						continue;
					}
					if (instruction.opcode === "call" && index === 1) {
						markUnsafe(fn.functionIndex, input, (brand) =>
							keySafeForBrand(receiverKey, brand),
						);
						if (
							(receiverKey === "set" || receiverKey === "add") &&
							instruction.outputs.some((output) => usedValues.has(output))
						) {
							markUnsafe(fn.functionIndex, input);
						}
						continue;
					}
					if (instruction.opcode === "callBuiltin" && index === 0) {
						const operation = instruction.attributes.operation;
						const brand = coreCollectionReceiverBrandForOperation(operation);
						markUnsafe(fn.functionIndex, input, (candidate) => candidate === brand);
						if (
							(operation === "Map.prototype.set" || operation === "Set.prototype.add") &&
							instruction.outputs.some((output) => usedValues.has(output))
						) {
							markUnsafe(fn.functionIndex, input);
						}
						continue;
					}
					markUnsafe(fn.functionIndex, input);
				}
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const argument of edge.arguments) markUnsafe(fn.functionIndex, argument);
			}
			if (block.terminator.kind === "branch" || block.terminator.kind === "guard") {
				markUnsafe(fn.functionIndex, block.terminator.condition);
			} else if (block.terminator.kind === "switch") {
				markUnsafe(fn.functionIndex, block.terminator.discriminant);
			} else if (
				block.terminator.kind === "return" ||
				block.terminator.kind === "throw"
			) {
				markUnsafe(fn.functionIndex, block.terminator.value);
			}
			for (const argument of block.handler?.arguments ?? []) {
				markUnsafe(fn.functionIndex, argument);
			}
		}
	}

	const tdzDominates = (
		fn: CoreFunction,
		value: CoreValueId,
		at: CoreInstructionId,
	): boolean => {
		const cfg = cfgByFunction.get(fn.functionIndex)!;
		const roots = rootsByFunction.get(fn.functionIndex)!;
		const target = roots.get(value) ?? value;
		const locations = locationsByFunction.get(fn.functionIndex)!;
		const use = locations.get(at);
		if (use === undefined) return false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode !== "throwIfTdz" ||
					instruction.inputs.length !== 1 ||
					(roots.get(instruction.inputs[0]!) ?? instruction.inputs[0]) !== target
				) {
					continue;
				}
				const check = locations.get(instruction.id)!;
				if (
					check.block === use.block
						? check.position < use.position
						: cfg.instructionDominatesBlock(check.block, use.block)
				) {
					return true;
				}
			}
		}
		return false;
	};
	const exactHeapBrand = (
		functionIndex: number,
		value: CoreValueId,
		at: CoreInstructionId,
	): CoreExactHeapBrand | undefined => {
		const fn = functionsByIndex.get(functionIndex);
		const base = valueBases.get(functionIndex);
		const limit = valueLimits.get(functionIndex);
		if (fn === undefined || base === undefined || limit === undefined || value >= limit) {
			return undefined;
		}
		const node = base + value;
		const candidateIds = candidates[node] ?? [];
		if (
			candidateIds.length === 0 ||
			opaque[node] !== 0 ||
			(maybeEmpty[node] !== 0 && !tdzDominates(fn, value, at))
		) {
			return undefined;
		}
		const brands = new Set(candidateIds.map((origin) => origins[origin]!.brand));
		return brands.size === 1 ? [...brands][0] : undefined;
	};
	return {
		exactHeapBrand,
		exactNumericTypedArray(functionIndex, value, at) {
			return coreNumericTypedArrayKind(exactHeapBrand(functionIndex, value, at));
		},
		containedCollection(functionIndex, value, at) {
			const brand = coreExactCollectionBrand(exactHeapBrand(functionIndex, value, at));
			const base = valueBases.get(functionIndex);
			if (brand === undefined || base === undefined) return undefined;
			const originIds = candidates[base + value] ?? [];
			return originIds.length > 0 &&
				originIds.every((origin) => unsafeOrigins[origin] === 0)
				? brand
				: undefined;
		},
	};
}

export interface CoreExactHeapSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function coreCollectionReceiverBrandForOperation(
	operation: unknown,
): CoreExactCollectionBrand | undefined {
	if (
		operation === "Map.prototype.get" ||
		operation === "Map.prototype.set" ||
		operation === "Map.prototype.has" ||
		operation === "Map.prototype.delete"
	) {
		return "Map";
	}
	if (
		operation === "Set.prototype.add" ||
		operation === "Set.prototype.has" ||
		operation === "Set.prototype.delete"
	) {
		return "Set";
	}
	return undefined;
}

function collectionReceiverBrand(
	instruction: CoreInstruction,
): CoreExactCollectionBrand | undefined {
	if (instruction.opcode !== "call") return undefined;
	const call = instruction.attributes.knownBuiltinCall;
	if (call === null || typeof call !== "object" || Array.isArray(call)) return undefined;
	return coreCollectionReceiverBrandForOperation(
		(call as Readonly<Record<string, unknown>>).operation,
	);
}

function attributeRecord(value: unknown): CoreAttributeObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as CoreAttributeObject)
		: undefined;
}

function exactCollectionKnownCall(
	value: CoreAttributeValue | undefined,
	operation: string,
): CoreAttributeValue | undefined {
	const call = attributeRecord(value);
	const identity = attributeRecord(call?.identity);
	const semantics = attributeRecord(call?.semantics);
	const identityProof = attributeRecord(identity?.proof);
	const semanticsProof = attributeRecord(semantics?.proof);
	const dependencyLists = [identityProof?.dependencies, semanticsProof?.dependencies];
	if (
		call?.operation !== operation ||
		identity?.kind !== "known" ||
		identity.value !== operation ||
		semantics?.kind !== "known" ||
		identityProof === undefined ||
		semanticsProof === undefined ||
		!dependencyLists.some(
			(dependencies) => Array.isArray(dependencies) && dependencies.length > 0,
		) ||
		dependencyLists.some(
			(dependencies) =>
				Array.isArray(dependencies) &&
				dependencies.some(
					(dependency) =>
						attributeRecord(dependency)?.kind !== "world" ||
						attributeRecord(dependency)?.fact !== "primordials.locked",
				),
		)
	) {
		return undefined;
	}
	const dischargeLoadedCallee = (proof: CoreAttributeObject): CoreAttributeValue => ({
		...proof,
		obligations: Array.isArray(proof.obligations)
			? proof.obligations.filter((obligation) => {
					const record = attributeRecord(obligation);
					return record?.kind !== "fallback" || record.cause !== "loaded-callee";
				})
			: [],
	});
	return {
		...call,
		identity: {
			...identity,
			proof: dischargeLoadedCallee(identityProof),
		},
		semantics: {
			...semantics,
			proof: dischargeLoadedCallee(semanticsProof),
		},
	};
}

/** Publish exact heap brands at target operations that can consume them. */
export function selectCoreExactHeapAccesses(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	controlFlow?: (fn: CoreFunction) => CoreControlFlow,
	summaries?: CoreProgramSummaries,
): CoreExactHeapSelection {
	const analysis = analyzeCoreValueClasses(program, context, controlFlow, summaries);
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		let functionChanged = false;
		const cfg =
			controlFlow === undefined
				? buildCoreControlFlow(fn, coreOpcodeRegistry)
				: controlFlow(fn);
		const roots = coreCanonicalValueRoots(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
		const definitions = new Map<CoreValueId, CoreInstruction>();
		const useCounts = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
				for (const input of instruction.inputs) {
					useCounts.set(root(input), (useCounts.get(root(input)) ?? 0) + 1);
				}
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const argument of edge.arguments) {
					useCounts.set(root(argument), (useCounts.get(root(argument)) ?? 0) + 1);
				}
			}
		}
		const exactCalls = new Map<CoreInstructionId, CoreInstruction>();
		const removedInstructions = new Set<CoreInstructionId>();
		const removedValues = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "call" || instruction.inputs.length < 2) continue;
				const known = attributeRecord(instruction.attributes.knownBuiltinCall);
				const operation = known?.operation;
				if (typeof operation !== "string") continue;
				const expectedBrand = coreCollectionReceiverBrandForOperation(operation);
				const exact = exactBuiltinCallDescriptor(operation);
				const receiver = instruction.inputs[1]!;
				if (
					expectedBrand === undefined ||
					exact === undefined ||
					analysis.containedCollection(fn.functionIndex, receiver, instruction.id) !==
						expectedBrand
				) {
					continue;
				}
				const callee = instruction.inputs[0]!;
				const property = definitions.get(root(callee));
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.outputs.length !== 1 ||
					root(property.outputs[0]!) !== root(callee) ||
					property.inputs.length !== 1 ||
					root(property.inputs[0]!) !== root(receiver) ||
					useCounts.get(root(callee)) !== 1
				) {
					continue;
				}
				const exactKnownCall = exactCollectionKnownCall(
					instruction.attributes.knownBuiltinCall,
					operation,
				);
				if (exactKnownCall === undefined) continue;
				const arguments_ = instruction.inputs.slice(2);
				const forwarded =
					exact.forwardedArgumentLimit === undefined
						? arguments_
						: arguments_.slice(0, exact.forwardedArgumentLimit);
				exactCalls.set(instruction.id, {
					...instruction,
					opcode: "callBuiltin",
					inputs: [receiver, ...forwarded],
					attributes: {
						operation,
						knownBuiltinCall: exactKnownCall,
					},
				});
				removedInstructions.add(property.id);
				for (const output of property.outputs) removedValues.add(output);
			}
		}
		const blocks = fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.flatMap((original): Array<CoreInstruction> => {
				if (removedInstructions.has(original.id)) {
					changed = true;
					functionChanged = true;
					return [];
				}
				const instruction = exactCalls.get(original.id) ?? original;
				if (instruction !== original) {
					changed = true;
					functionChanged = true;
				}
				let kind: CoreNumericTypedArrayKind | undefined;
				let collectionBrand: CoreExactCollectionBrand | undefined;
				if (instruction.opcode === "loadProperty" && instruction.inputs.length === 2) {
					kind = analysis.exactNumericTypedArray(
						fn.functionIndex,
						instruction.inputs[0]!,
						instruction.id,
					);
				}
				const expectedCollectionBrand = collectionReceiverBrand(instruction);
				if (
					expectedCollectionBrand !== undefined &&
					instruction.inputs[1] !== undefined
				) {
					const actual = analysis.exactHeapBrand(
						fn.functionIndex,
						instruction.inputs[1],
						instruction.id,
					);
					if (actual === expectedCollectionBrand) collectionBrand = actual;
				}
				const existing = coreNumericTypedArrayKind(
					instruction.attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
				);
				const existingCollection = coreExactCollectionBrand(
					instruction.attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE],
				);
				if (existing === kind && existingCollection === collectionBrand)
					return [instruction];
				const attributes: Record<string, CoreAttributeValue> = {
					...instruction.attributes,
				};
				delete attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE];
				delete attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE];
				if (kind !== undefined) attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE] = kind;
				if (collectionBrand !== undefined) {
					attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE] = collectionBrand;
				}
				changed = true;
				functionChanged = true;
				return [{ ...instruction, attributes }];
			}),
		}));
		return functionChanged
			? {
					...fn,
					blocks,
					values: fn.values.filter(({ id }) => !removedValues.has(id)),
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
	});
	return { program: changed ? { ...program, functions } : program, changed };
}
