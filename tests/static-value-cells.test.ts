import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreMemoryVersions } from "../src/compiler/core/core-ir-memory.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreStaticCellIndex } from "../src/compiler/core/core-static-value-cells.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

type Scenario =
	| "private"
	| "escape"
	| "primitive"
	| "alias"
	| "alias-write"
	| "self"
	| "early-getter";
function fixture(scenario: Scenario) {
	const program = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 1,
		stringConstants: [[120], [121], [115, 101, 108, 102]],
	});
	const context = {
		facts: conservativeCompilerProgramFacts(),
		data: {
			entrypointPath: "cells.js",
			moduleEvaluationOrder: [],
			sourceFiles: [],
			cjsModuleFunctionIndices: [],
			hostInstallCandidates: [],
			singleAssignmentGlobalSlots: [0],
			singleAssignmentCapturedSlots: [],
			retainedHostInstallers: [],
		},
	};
	const writer = new CoreFunctionBuilder(program),
		entry = writer.createBlock();
	const [seven] = writer.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 7 },
	});
	const [nine] = writer.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 9 },
	});
	writer.appendInstruction(entry, "storeLocal", [nine!], { attributes: { index: 0 } });
	const [unused] = writer.appendInstruction(entry, "loadLocal", [], {
		attributes: { index: 0 },
	});
	const [object] = writer.appendInstruction(
		entry,
		"createObjectShaped",
		[seven!, unused!],
		{ attributes: { keyStringIndices: [0, 1] } },
	);
	let value = scenario === "primitive" ? seven! : object!;
	if (scenario === "alias-write" || scenario === "alias")
		value = writer.appendInstruction(entry, "move", [object!])[0]!;
	if (scenario === "self") {
		const [self] = writer.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 2 },
		});
		writer.appendInstruction(entry, "defineProperty", [object!, self!, object!]);
	}
	let escaped;
	if (scenario === "early-getter") {
		const [key] = writer.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 1 },
		});
		const [getter] = writer.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		writer.appendInstruction(entry, "defineAccessor", [object!, key!, getter!], {
			attributes: { kind: "get" },
		});
		[escaped] = writer.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		writer.appendInstruction(entry, "defineProperty", [object!, key!, seven!]);
		writer.appendInstruction(entry, "storePropertyStatic", [object!, seven!], {
			attributes: { stringIndex: 0 },
		});
	}
	writer.appendInstruction(entry, "storeGlobal", [value], { attributes: { index: 0 } });
	if (scenario === "alias-write" || escaped !== undefined)
		writer.appendInstruction(entry, "storePropertyStatic", [escaped ?? object!, nine!], {
			attributes: { stringIndex: 0 },
		});
	writer.setTerminator(entry, { kind: "return", value: seven! });
	const writerFn = program.function(writer.finish(entry).function);
	const reader = new CoreFunctionBuilder(program),
		readEntry = reader.createBlock();
	const [loaded] = reader.appendInstruction(readEntry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	reader.appendInstruction(readEntry, "throwIfTdz", [loaded!]);
	if (scenario === "self") {
		const [self] = reader.appendInstruction(readEntry, "loadPropertyStatic", [loaded!], {
			attributes: { stringIndex: 2 },
		});
		const [replacement] = reader.appendInstruction(readEntry, "createNumber", [], {
			attributes: { value: 9 },
		});
		reader.appendInstruction(readEntry, "storePropertyStatic", [self!, replacement!], {
			attributes: { stringIndex: 0 },
		});
	}
	const [read] = reader.appendInstruction(readEntry, "loadPropertyStatic", [loaded!], {
		attributes: { stringIndex: 0 },
	});
	reader.setTerminator(readEntry, {
		kind: "return",
		value: scenario === "escape" || scenario === "primitive" ? loaded! : read!,
	});
	const readerFn = program.function(reader.finish(readEntry).function);
	const index = new CoreStaticCellIndex(program, context);
	let memoryQueries = 0;
	const writerFacts = new CoreStaticValueAnalysis(
		program,
		writerFn,
		() => buildCoreControlFlow(program, writerFn.id),
		undefined,
		context,
		() => {
			memoryQueries++;
			return analyzeCoreMemoryVersions(program, writerFn.id);
		},
	);
	const readerFacts: CoreStaticValueAnalysis = new CoreStaticValueAnalysis(
		program,
		readerFn,
		() => buildCoreControlFlow(program, readerFn.id),
		undefined,
		context,
		undefined,
		(fn, load, value, consumer, requestedKey) =>
			index.query(
				fn,
				load,
				value,
				consumer,
				(functionId) => (functionId === writerFn.id ? writerFacts : readerFacts),
				() => buildCoreControlFlow(program, fn.id),
				requestedKey,
			),
	);
	return {
		program,
		writerFn,
		readerFn,
		entry,
		readEntry,
		writerFacts,
		readerFacts,
		loaded: loaded!,
		consumer: coreInstructionId(readerFn.kernel.valueDefinitionOwner(read!)),
		memoryQueries: () => memoryQueries,
	};
}

describe("demanded private-cell contents", () => {
	it("skips an unread memory-backed field while retaining full and later field queries", () => {
		const f = fixture("private");
		const x = f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer);
		if (x?.member.kind !== "constant") throw new Error("Expected selected x");
		expect(f.readerFacts.descriptionConstant(x.member.description)).toEqual({
			kind: "number",
			value: 7,
		});
		expect(f.memoryQueries()).toBe(0);
		f.readerFacts.verifyProperty(x, f.consumer);
		const complete = f.readerFacts.queryAt(f.loaded, f.consumer);
		if (complete.kind !== "known") throw new Error("Expected full object");
		expect(f.memoryQueries()).toBeGreaterThan(0);
		const y = f.readerFacts.queryPropertyAt(f.loaded, "y", f.consumer);
		if (y?.member.kind !== "constant") throw new Error("Expected later y");
		expect(f.readerFacts.descriptionConstant(y.member.description)).toEqual({
			kind: "number",
			value: 9,
		});
	});

	it("retains a safe move alias through the full proof fallback", () => {
		const f = fixture("alias");
		const property = f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer);
		if (property?.member.kind !== "constant")
			throw new Error("Expected safe alias property");
		expect(f.readerFacts.descriptionConstant(property.member.description)).toEqual({
			kind: "number",
			value: 7,
		});
	});

	it("rejects escaping objects before querying initializer values", () => {
		const f = fixture("escape");
		expect(f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer)).toBeUndefined();
		expect(f.writerFacts.statistics.queries).toBe(0);
		expect(f.memoryQueries()).toBe(0);
	});

	it("retains primitive facts even when the cell is returned", () => {
		const f = fixture("primitive");
		expect(f.readerFacts.constant(f.loaded, f.consumer)).toEqual({
			kind: "number",
			value: 7,
		});
	});

	it.each(["alias-write", "self", "early-getter"] as const)(
		"does not hide a mutable alias from %s",
		(scenario) => {
			const f = fixture(scenario);
			expect(f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer)).toBeUndefined();
		},
	);

	it("does not cache a failed initialization check as an ineligible cell", () => {
		const f = fixture("private");
		const load = coreInstructionId(f.readerFn.kernel.valueDefinitionOwner(f.loaded));
		expect(f.readerFacts.queryPropertyAt(f.loaded, "x", load)).toBeUndefined();
		expect(f.writerFacts.statistics.queries).toBe(0);
		expect(f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer)).toBeDefined();
	});

	it("retires projected proofs when another helper exposes the cell", () => {
		const f = fixture("private");
		const property = f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer);
		if (property === undefined) throw new Error("Expected private field");
		const editor = CoreEditor.open(f.program, f.writerFn.id);
		const {
			outputs: [exposed],
		} = editor.appendInstruction(f.entry, "loadGlobal", [], { attributes: { index: 0 } });
		editor.replaceTerminator(f.entry, { kind: "return", value: exposed! });
		editor.commit();
		expect(() => f.readerFacts.verifyProperty(property, f.consumer)).toThrow("not owned");
		expect(f.readerFacts.queryPropertyAt(f.loaded, "x", f.consumer)).toBeUndefined();
	});
});
