import type { CoreFunctionOpcodeSites } from "./core-function-opcode-sites.ts";
import type { CoreBlockId, CoreFunctionId, CoreOpcodeId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_FUNCTION_HAS_BRANCHES = 1 << 0;
export const CORE_FUNCTION_HAS_EXCEPTIONS = 1 << 1;
export const CORE_FUNCTION_HAS_BACKEDGES = 1 << 2;
export const CORE_FUNCTION_HAS_MEMORY_ACCESSES = 1 << 3;
export const CORE_FUNCTION_HAS_ALLOCATIONS = 1 << 4;
export const CORE_FUNCTION_HAS_CALLS = 1 << 5;
export const CORE_FUNCTION_HAS_CANDIDATE_OPCODES = 1 << 6;
export const CORE_FUNCTION_HAS_EDGE_ARGUMENTS = 1 << 7;
export const CORE_FUNCTION_FEATURE_MASK =
	CORE_FUNCTION_HAS_BRANCHES |
	CORE_FUNCTION_HAS_EXCEPTIONS |
	CORE_FUNCTION_HAS_BACKEDGES |
	CORE_FUNCTION_HAS_MEMORY_ACCESSES |
	CORE_FUNCTION_HAS_ALLOCATIONS |
	CORE_FUNCTION_HAS_CALLS |
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES |
	CORE_FUNCTION_HAS_EDGE_ARGUMENTS;

export type CoreFunctionFeatureBits = number;

function hasControlCycle(fn: CoreFunctionStore): boolean {
	const colors = new Uint8Array(fn.blockCapacity);
	const blocks: Array<CoreBlockId> = [];
	const edges: Array<number> = [];
	for (let rootIndex = 0; rootIndex < fn.blockCapacity; rootIndex++) {
		const rootBlock = rootIndex as CoreBlockId;
		if (fn.kernel.blockLive(rootBlock) === 0) continue;
		if (colors[rootBlock] !== 0) continue;
		let depth = 0;
		blocks[0] = rootBlock;
		edges[0] = 0;
		colors[rootBlock] = 1;
		while (depth >= 0) {
			const block = blocks[depth]!;
			const terminator = fn.blockTerminator(block);
			const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
			const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
			const handler = fn.kernel.blockHandlerBlock(block);
			const edgeIndex = edges[depth]!;
			if (edgeIndex >= edgeCount + (handler === undefined ? 0 : 1)) {
				colors[block] = 2;
				depth--;
				continue;
			}
			edges[depth] = edgeIndex + 1;
			const target =
				edgeIndex < edgeCount
					? fn.kernel.terminatorEdgeBlock(edgeStart + edgeIndex)
					: handler!;
			if (!fn.isBlockLive(target)) continue;
			if (colors[target] === 1) return true;
			if (colors[target] !== 0) continue;
			depth++;
			blocks[depth] = target;
			edges[depth] = 0;
			colors[target] = 1;
		}
	}
	return false;
}

function controlFeatures(fn: CoreFunctionStore): CoreFunctionFeatureBits {
	let bits = 0;
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = blockIndex as CoreBlockId;
		if (fn.kernel.blockLive(block) === 0) continue;
		if (fn.kernel.blockHandlerBlock(block) !== undefined)
			bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "branch" || kind === "switch" || kind === "guard")
			bits |= CORE_FUNCTION_HAS_BRANCHES;
		if (kind === "throw") bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
		if ((bits & CORE_FUNCTION_HAS_EDGE_ARGUMENTS) !== 0) continue;
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let index = 0; index < edgeCount; index++) {
			if (fn.kernel.terminatorEdgeArgumentCount(edgeStart + index) === 0) continue;
			bits |= CORE_FUNCTION_HAS_EDGE_ARGUMENTS;
			break;
		}
	}
	if (hasControlCycle(fn)) bits |= CORE_FUNCTION_HAS_BACKEDGES;
	return bits;
}

function opcodeFeatures(
	fn: CoreFunctionStore,
	opcode: CoreOpcodeId,
	candidateOpcodes: ArrayLike<number> | undefined,
): CoreFunctionFeatureBits {
	const descriptor = fn.registry.byId(opcode);
	let bits = 0;
	if (descriptor.effects.mayThrow) bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
	if (descriptor.effects.reads.length > 0 || descriptor.effects.writes.length > 0)
		bits |= CORE_FUNCTION_HAS_MEMORY_ACCESSES;
	if (descriptor.allocation !== undefined) bits |= CORE_FUNCTION_HAS_ALLOCATIONS;
	if (descriptor.callTransfer !== undefined || descriptor.effects.callsUserCode)
		bits |= CORE_FUNCTION_HAS_CALLS;
	if ((candidateOpcodes?.[opcode] ?? 0) !== 0)
		bits |= CORE_FUNCTION_HAS_CANDIDATE_OPCODES;
	return bits;
}

export function scanCoreFunctionFeatures(
	fn: CoreFunctionStore,
	candidateOpcodes?: ArrayLike<number>,
): CoreFunctionFeatureBits {
	let bits = controlFeatures(fn);
	for (const opcode of fn.opcodeSites().opcodes)
		bits |= opcodeFeatures(fn, opcode, candidateOpcodes);
	return bits;
}

interface FunctionFeatures {
	readonly fn: CoreFunctionStore;
	version: number;
	opcodes: CoreFunctionOpcodeSites | undefined;
	opcodeBits: CoreFunctionFeatureBits;
	cfgVersion: number;
	exceptionVersion: number;
	controlBits: CoreFunctionFeatureBits;
}

export class CoreFunctionFeatureIndex {
	readonly #program: CoreProgram;
	readonly #candidateOpcodes: ArrayLike<number> | undefined;
	readonly #opcodeBits: Array<CoreFunctionFeatureBits | undefined> = [];
	readonly #features: Array<FunctionFeatures | undefined> = [];

	constructor(program: CoreProgram, candidateOpcodes?: ArrayLike<number>) {
		this.#program = program;
		this.#candidateOpcodes = candidateOpcodes;
	}

	get(functionId: CoreFunctionId): CoreFunctionFeatureBits {
		const fn = this.#program.function(functionId);
		if (fn.hasActiveEditor) return scanCoreFunctionFeatures(fn, this.#candidateOpcodes);
		let entry = this.#features[functionId];
		if (entry?.fn !== fn) {
			entry = {
				fn,
				version: -1,
				opcodes: undefined,
				opcodeBits: 0,
				cfgVersion: -1,
				exceptionVersion: -1,
				controlBits: 0,
			};
			this.#features[functionId] = entry;
		}
		if (entry.version !== fn.featureVersion) {
			const sites = fn.opcodeSites();
			if (entry.opcodes !== sites) {
				entry.opcodes = sites;
				entry.opcodeBits = 0;
				for (const opcode of sites.opcodes) {
					const bits = (this.#opcodeBits[opcode] ??= opcodeFeatures(
						fn,
						opcode,
						this.#candidateOpcodes,
					));
					entry.opcodeBits |= bits;
				}
			}
			const cfgVersion = fn.version("cfg");
			const exceptionVersion = fn.version("exceptionFlow");
			if (
				entry.cfgVersion !== cfgVersion ||
				entry.exceptionVersion !== exceptionVersion
			) {
				entry.cfgVersion = cfgVersion;
				entry.exceptionVersion = exceptionVersion;
				entry.controlBits = controlFeatures(fn);
			}
			entry.version = fn.featureVersion;
		}
		return entry.opcodeBits | entry.controlBits;
	}

	hasAnyOpcode(functionId: CoreFunctionId, opcodes: ArrayLike<number>): boolean {
		return this.#program.function(functionId).opcodeSites().hasAny(opcodes);
	}
}
