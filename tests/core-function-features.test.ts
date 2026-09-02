import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_FUNCTION_HAS_ALLOCATIONS,
	CORE_FUNCTION_HAS_BACKEDGES,
	CORE_FUNCTION_HAS_BRANCHES,
	CORE_FUNCTION_HAS_CALLS,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CORE_FUNCTION_HAS_EXCEPTIONS,
	CORE_FUNCTION_HAS_MEMORY_ACCESSES,
	CoreFunctionFeatureIndex,
	scanCoreFunctionFeatures,
} from "../src/compiler/core/core-function-features.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

describe("Core function features", () => {
	it("classifies control, effects, calls, allocations, and candidate opcodes", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } });
		builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 0 },
		});
		builder.appendInstruction(entry, "call", [parameter, parameter]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: parameter,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: entry, arguments: [parameter] },
		});
		builder.setTerminator(exit, { kind: "return", value: parameter });
		const fn = program.function(builder.finish(entry).function);
		const candidates = new Uint8Array(coreOpcodeRegistry.entries().length);
		candidates[coreOpcodeRegistry.require("loadGlobal").id] = 1;

		const features = scanCoreFunctionFeatures(fn, candidates);

		expect(features).toBe(
			CORE_FUNCTION_HAS_BRANCHES |
				CORE_FUNCTION_HAS_EXCEPTIONS |
				CORE_FUNCTION_HAS_BACKEDGES |
				CORE_FUNCTION_HAS_MEMORY_ACCESSES |
				CORE_FUNCTION_HAS_ALLOCATIONS |
				CORE_FUNCTION_HAS_CALLS |
				CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
		);
	});

	it("rescans once after a relevant committed edit", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const handler = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: value! });
		builder.setTerminator(handler, { kind: "return", value: value! });
		const functionId = builder.finish(entry).function;
		const features = new CoreFunctionFeatureIndex(program);

		expect(features.get(functionId) & CORE_FUNCTION_HAS_BACKEDGES).toBe(0);
		expect(features.get(functionId) & CORE_FUNCTION_HAS_BACKEDGES).toBe(0);
		expect(features.scans).toBe(1);
		const representationEditor = CoreEditor.open(program, functionId);
		representationEditor.setValueRepresentation(value!, "f64");
		representationEditor.commit();
		expect(features.get(functionId) & CORE_FUNCTION_HAS_BACKEDGES).toBe(0);
		expect(features.scans).toBe(1);
		const handlerEditor = CoreEditor.open(program, functionId);
		handlerEditor.setHandler(entry, handler, []);
		handlerEditor.commit();
		expect(features.get(functionId) & CORE_FUNCTION_HAS_EXCEPTIONS).not.toBe(0);
		expect(features.scans).toBe(2);
		const editor = CoreEditor.open(program, functionId);
		editor.replaceTerminator(entry, {
			kind: "jump",
			edge: { block: entry, arguments: [] },
		});
		editor.commit();

		expect(features.get(functionId) & CORE_FUNCTION_HAS_BACKEDGES).not.toBe(0);
		expect(features.scans).toBe(3);
	});

	it("does not infer cycles from block identity order", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const exit = builder.createBlock();
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: value! });
		const fn = program.function(builder.finish(entry).function);

		expect(scanCoreFunctionFeatures(fn) & CORE_FUNCTION_HAS_BACKEDGES).toBe(0);
	});
});
