import { coreOpcodeId } from "./core-ir.ts";
import type { CoreBlockId, CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_FUNCTION_HAS_BRANCHES = 1 << 0;
export const CORE_FUNCTION_HAS_EXCEPTIONS = 1 << 1;
export const CORE_FUNCTION_HAS_BACKEDGES = 1 << 2;
export const CORE_FUNCTION_HAS_MEMORY_ACCESSES = 1 << 3;
export const CORE_FUNCTION_HAS_ALLOCATIONS = 1 << 4;
export const CORE_FUNCTION_HAS_CALLS = 1 << 5;
export const CORE_FUNCTION_HAS_CANDIDATE_OPCODES = 1 << 6;
export const CORE_FUNCTION_FEATURE_MASK =
	CORE_FUNCTION_HAS_BRANCHES |
	CORE_FUNCTION_HAS_EXCEPTIONS |
	CORE_FUNCTION_HAS_BACKEDGES |
	CORE_FUNCTION_HAS_MEMORY_ACCESSES |
	CORE_FUNCTION_HAS_ALLOCATIONS |
	CORE_FUNCTION_HAS_CALLS |
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES;

export type CoreFunctionFeatureBits = number;

function hasControlCycle(fn: CoreFunctionStore): boolean {
	const colors = new Map<CoreBlockId, number>();
	const blocks: Array<CoreBlockId> = [];
	const edges: Array<number> = [];
	for (let rootIndex = 0; rootIndex < fn.blockCapacity; rootIndex++) {
		const rootBlock = rootIndex as CoreBlockId;
		if (fn.kernel.blockLive(rootBlock) === 0) continue;
		if ((colors.get(rootBlock) ?? 0) !== 0) continue;
		let depth = 0;
		blocks[0] = rootBlock;
		edges[0] = 0;
		colors.set(rootBlock, 1);
		while (depth >= 0) {
			const block = blocks[depth]!;
			const terminator = fn.blockTerminator(block);
			const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
			const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
			const handler = fn.kernel.blockHandlerBlock(block);
			const edgeIndex = edges[depth]!;
			if (edgeIndex >= edgeCount + (handler === undefined ? 0 : 1)) {
				colors.set(block, 2);
				depth--;
				continue;
			}
			edges[depth] = edgeIndex + 1;
			const target =
				edgeIndex < edgeCount
					? fn.kernel.terminatorEdgeBlock(edgeStart + edgeIndex)
					: handler!;
			if (!fn.isBlockLive(target)) continue;
			if (colors.get(target) === 1) return true;
			if ((colors.get(target) ?? 0) !== 0) continue;
			depth++;
			blocks[depth] = target;
			edges[depth] = 0;
			colors.set(target, 1);
		}
	}
	return false;
}

function scanFeatures(
	fn: CoreFunctionStore,
	candidateOpcodes: ArrayLike<number> | undefined,
	opcodePresence: Uint32Array | undefined,
	opcodeOffset: number,
): CoreFunctionFeatureBits {
	let bits = 0;
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = blockIndex as CoreBlockId;
		if (fn.kernel.blockLive(block) === 0) continue;
		if (fn.kernel.blockHandlerBlock(block) !== undefined) {
			bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
		}
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "branch" || kind === "switch" || kind === "guard") {
			bits |= CORE_FUNCTION_HAS_BRANCHES;
		}
		if (kind === "throw") bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
		for (
			let instructionIndex = fn.kernel.blockFirstInstruction(block);
			instructionIndex >= 0;
			instructionIndex = fn.kernel.instructionNext(instructionIndex as CoreInstructionId)
		) {
			const instruction = instructionIndex as CoreInstructionId;
			if (fn.kernel.instructionOpcode(instruction) < 0) continue;
			const opcode = fn.kernel.instructionOpcode(instruction);
			if (opcode < 0) continue;
			if (opcodePresence !== undefined) {
				opcodePresence[opcodeOffset + (opcode >>> 5)]! |= 1 << (opcode & 31);
			}
			const descriptor = fn.registry.byId(coreOpcodeId(opcode));
			if (descriptor.effects.mayThrow) bits |= CORE_FUNCTION_HAS_EXCEPTIONS;
			if (descriptor.effects.reads.length > 0 || descriptor.effects.writes.length > 0) {
				bits |= CORE_FUNCTION_HAS_MEMORY_ACCESSES;
			}
			if (descriptor.allocation !== undefined) bits |= CORE_FUNCTION_HAS_ALLOCATIONS;
			if (descriptor.callTransfer !== undefined || descriptor.effects.callsUserCode) {
				bits |= CORE_FUNCTION_HAS_CALLS;
			}
			if ((candidateOpcodes?.[opcode] ?? 0) !== 0) {
				bits |= CORE_FUNCTION_HAS_CANDIDATE_OPCODES;
			}
		}
	}
	if (hasControlCycle(fn)) bits |= CORE_FUNCTION_HAS_BACKEDGES;
	return bits;
}

export function scanCoreFunctionFeatures(
	fn: CoreFunctionStore,
	candidateOpcodes?: ArrayLike<number>,
): CoreFunctionFeatureBits {
	return scanFeatures(fn, candidateOpcodes, undefined, 0);
}

export class CoreFunctionFeatureIndex {
	readonly #program: CoreProgram;
	readonly #candidateOpcodes: ArrayLike<number> | undefined;
	readonly #opcodeWords: number;
	#bits: Uint32Array;
	#versions: Float64Array;
	#opcodeVersions: Float64Array;
	#opcodePresence: Uint32Array;
	#scans = 0;

	constructor(program: CoreProgram, candidateOpcodes?: ArrayLike<number>) {
		this.#program = program;
		this.#candidateOpcodes = candidateOpcodes;
		this.#opcodeWords = Math.ceil(program.registry.entries().length / 32);
		this.#bits = new Uint32Array(program.functionCapacity);
		this.#versions = new Float64Array(program.functionCapacity);
		this.#opcodeVersions = new Float64Array(program.functionCapacity);
		this.#opcodePresence = new Uint32Array(program.functionCapacity * this.#opcodeWords);
		this.#versions.fill(-1);
		this.#opcodeVersions.fill(-1);
	}

	get scans(): number {
		return this.#scans;
	}

	get(functionId: CoreFunctionId): CoreFunctionFeatureBits {
		this.#grow(functionId + 1);
		const fn = this.#program.function(functionId);
		if (this.#versions[functionId] !== fn.featureVersion) {
			this.#scan(functionId, fn);
		}
		return this.#bits[functionId]!;
	}

	hasAnyOpcode(functionId: CoreFunctionId, opcodes: ArrayLike<number>): boolean {
		this.#grow(functionId + 1);
		const fn = this.#program.function(functionId);
		if (this.#opcodeVersions[functionId] !== fn.version("body")) {
			this.#scan(functionId, fn);
		}
		const opcodeOffset = functionId * this.#opcodeWords;
		for (let index = 0; index < opcodes.length; index++) {
			const opcode = opcodes[index]!;
			if (
				(this.#opcodePresence[opcodeOffset + (opcode >>> 5)]! & (1 << (opcode & 31))) !==
				0
			)
				return true;
		}
		return false;
	}

	#scan(functionId: CoreFunctionId, fn: CoreFunctionStore): void {
		const opcodeOffset = functionId * this.#opcodeWords;
		this.#opcodePresence.fill(0, opcodeOffset, opcodeOffset + this.#opcodeWords);
		this.#bits[functionId] = scanFeatures(
			fn,
			this.#candidateOpcodes,
			this.#opcodePresence,
			opcodeOffset,
		);
		this.#versions[functionId] = fn.featureVersion;
		this.#opcodeVersions[functionId] = fn.version("body");
		this.#scans++;
	}

	#grow(required: number): void {
		if (required <= this.#bits.length) return;
		const capacity = Math.max(required, this.#bits.length * 2, 16);
		const bits = new Uint32Array(capacity);
		const versions = new Float64Array(capacity);
		const opcodeVersions = new Float64Array(capacity);
		const opcodePresence = new Uint32Array(capacity * this.#opcodeWords);
		versions.fill(-1);
		opcodeVersions.fill(-1);
		bits.set(this.#bits);
		versions.set(this.#versions);
		opcodeVersions.set(this.#opcodeVersions);
		opcodePresence.set(this.#opcodePresence);
		this.#bits = bits;
		this.#versions = versions;
		this.#opcodeVersions = opcodeVersions;
		this.#opcodePresence = opcodePresence;
	}
}
