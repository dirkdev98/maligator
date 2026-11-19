import { equal } from "node:assert";
import { describe, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_FUNCTION_HAS_ALLOCATIONS,
	CORE_FUNCTION_HAS_CALLS,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CORE_FUNCTION_HAS_EXCEPTIONS,
	CORE_FUNCTION_HAS_MEMORY_ACCESSES,
	scanCoreFunctionFeatures,
} from "../src/compiler/core/core-function-features.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";

function fixture(includeEffects: boolean) {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	builder.appendInstruction(entry, "createUndefined", []);
	if (includeEffects) {
		builder.appendInstruction(entry, "createArray", [], { attributes: { length: 0 } });
		builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } });
		builder.appendInstruction(entry, "call", [value!, value!]);
	}
	builder.setTerminator(entry, { kind: "return", value: value! });
	return program.function(builder.finish(entry).function);
}

describe("Opcode feature masks", () => {
	const dispatch = new Uint8Array(coreOpcodeRegistry.entries().length);
	dispatch[coreOpcodeRegistry.require("createUndefined").id] = 1;

	it("combines descriptor effects across the opcodes present", () => {
		equal(
			scanCoreFunctionFeatures(fixture(true), dispatch),
			CORE_FUNCTION_HAS_ALLOCATIONS |
				CORE_FUNCTION_HAS_CALLS |
				CORE_FUNCTION_HAS_EXCEPTIONS |
				CORE_FUNCTION_HAS_MEMORY_ACCESSES |
				CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
		);
	});

	it("applies the caller's candidate mask to the same inventory", () => {
		const fn = fixture(false);
		equal(scanCoreFunctionFeatures(fn, dispatch), CORE_FUNCTION_HAS_CANDIDATE_OPCODES);
		equal(scanCoreFunctionFeatures(fn), 0);
	});
});
