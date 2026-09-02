import { coreBlockId, coreInstructionId, coreOpcodeId } from "./core-ir.ts";
import type { CoreFunctionId } from "./core-ir.ts";
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
	const colors = new Uint8Array(fn.blockCapacity);
	const blocks = new Int32Array(fn.blockCapacity);
	const edges = new Int32Array(fn.blockCapacity);
	for (let root = 0; root < fn.blockCapacity; root++) {
		const rootBlock = coreBlockId(root);
		if (fn.kernel.blockLive(rootBlock) === 0 || colors[root] !== 0) continue;
		let depth = 0;
		blocks[0] = root;
		edges[0] = 0;
		colors[root] = 1;
		while (depth >= 0) {
			const block = coreBlockId(blocks[depth]!);
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
			if (fn.kernel.blockLive(target) === 0) continue;
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

export function scanCoreFunctionFeatures(
	fn: CoreFunctionStore,
	candidateOpcodes?: ArrayLike<number>,
): CoreFunctionFeatureBits {
	let bits = 0;
	for (let blockId = 0; blockId < fn.blockCapacity; blockId++) {
		const block = coreBlockId(blockId);
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
			let instructionId = fn.kernel.blockFirstInstruction(block);
			instructionId >= 0 && instructionId !== terminator;
			instructionId = fn.kernel.instructionNext(coreInstructionId(instructionId))
		) {
			const instruction = coreInstructionId(instructionId);
			const opcode = fn.kernel.instructionOpcode(instruction);
			if (opcode < 0) continue;
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

export class CoreFunctionFeatureIndex {
	readonly #program: CoreProgram;
	readonly #candidateOpcodes: ArrayLike<number> | undefined;
	#bits: Uint32Array;
	#versions: Float64Array;
	#scans = 0;

	constructor(program: CoreProgram, candidateOpcodes?: ArrayLike<number>) {
		this.#program = program;
		this.#candidateOpcodes = candidateOpcodes;
		this.#bits = new Uint32Array(program.functionCapacity);
		this.#versions = new Float64Array(program.functionCapacity);
		this.#versions.fill(-1);
	}

	get scans(): number {
		return this.#scans;
	}

	get(functionId: CoreFunctionId): CoreFunctionFeatureBits {
		this.#grow(functionId + 1);
		const fn = this.#program.function(functionId);
		if (this.#versions[functionId] !== fn.featureVersion) {
			this.#bits[functionId] = scanCoreFunctionFeatures(fn, this.#candidateOpcodes);
			this.#versions[functionId] = fn.featureVersion;
			this.#scans++;
		}
		return this.#bits[functionId]!;
	}

	#grow(required: number): void {
		if (required <= this.#bits.length) return;
		const capacity = Math.max(required, this.#bits.length * 2, 16);
		const bits = new Uint32Array(capacity);
		const versions = new Float64Array(capacity);
		versions.fill(-1);
		bits.set(this.#bits);
		versions.set(this.#versions);
		this.#bits = bits;
		this.#versions = versions;
	}
}
