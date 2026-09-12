import { equal } from "node:assert";
import { describe, it } from "vitest";
import {
	CORE_FUNCTION_HAS_ALLOCATIONS,
	CORE_FUNCTION_HAS_CALLS,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CORE_FUNCTION_HAS_EXCEPTIONS,
	CORE_FUNCTION_HAS_MEMORY_ACCESSES,
	CoreFunctionFeatureIndex,
	scanCoreFunctionFeatures,
} from "../src/compiler/core/core-function-features.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "../src/compiler/core/core-store.ts";

function fixture() {
	const opcodes = [0, 0, 1, 1, -1];
	const effects = { mayThrow: false, callsUserCode: false, reads: [], writes: [] };
	const descriptors = [
		{ effects },
		{
			effects: { mayThrow: true, callsUserCode: true, reads: ["host"], writes: [] },
			allocation: {},
		},
	];
	let version = 1;
	const registry = {
		byId: (opcode: number) => descriptors[opcode],
		entries: () => descriptors,
	};
	const fn = {
		id: 0,
		blockCapacity: 1,
		get featureVersion() {
			return version;
		},
		version: () => version,
		blockTerminator: () => opcodes.length,
		instructionKind: () => "return",
		kernel: {
			blockLive: () => 1,
			blockHandlerBlock: () => undefined,
			terminatorEdgeStart: () => 0,
			terminatorEdgeCount: () => 0,
			blockFirstInstruction: () => (opcodes.length === 0 ? -1 : 0),
			instructionNext: (instruction: number) =>
				instruction + 1 < opcodes.length ? instruction + 1 : -1,
			instructionOpcode: (instruction: number) => opcodes[instruction],
		},
		registry,
	} as unknown as CoreFunctionStore;
	const program = {
		functionCapacity: 1,
		function: () => fn,
		registry,
	} as unknown as CoreProgram;
	return {
		fn,
		program,
		opcodes,
		invalidate: () => {
			version++;
		},
	};
}

describe("Per-scan opcode feature masks", () => {
	it("preserves all descriptor-derived flags across repeated opcodes", () => {
		const { fn } = fixture();
		equal(
			scanCoreFunctionFeatures(fn, [1, 0]),
			CORE_FUNCTION_HAS_ALLOCATIONS |
				CORE_FUNCTION_HAS_CALLS |
				CORE_FUNCTION_HAS_EXCEPTIONS |
				CORE_FUNCTION_HAS_MEMORY_ACCESSES |
				CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
		);
	});

	it("keeps candidate masks specific to each scan", () => {
		const f = fixture();
		f.opcodes.splice(0, f.opcodes.length, 0, 0, 0);
		equal(scanCoreFunctionFeatures(f.fn), 0);
		equal(scanCoreFunctionFeatures(f.fn, [1]), CORE_FUNCTION_HAS_CANDIDATE_OPCODES);
		equal(scanCoreFunctionFeatures(f.fn, [0]), 0);
	});

	it("keeps opcode presence and invalidation behavior intact", () => {
		const f = fixture();
		const index = new CoreFunctionFeatureIndex(f.program);
		const id = 0 as CoreFunctionId;
		equal(index.hasAnyOpcode(id, [1]), true);
		f.opcodes.splice(0, f.opcodes.length, 0, 0);
		f.invalidate();
		equal(index.hasAnyOpcode(id, [1]), false);
		equal(index.hasAnyOpcode(id, [0]), true);
		equal(index.get(id), 0);
	});
});
