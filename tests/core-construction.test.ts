import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreTerminatorPayload,
} from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";

function compile(source: string) {
	return lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "core-construction.js"),
	);
}

function operationNames(program: CoreProgram, functionId: CoreFunctionId): Array<string> {
	const fn = program.function(functionId);
	return [...fn.instructionIds()].flatMap((instruction) =>
		fn.instructionKind(instruction) === "operation"
			? [fn.instructionOpcodeName(instruction)]
			: [],
	);
}

function terminators(program: CoreProgram, functionId: CoreFunctionId) {
	const fn = program.function(functionId);
	return [...fn.blockIds()].map((block) =>
		inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)),
	);
}

function targetBlocks(payload: CoreTerminatorPayload): Array<CoreBlockId> {
	switch (payload.kind) {
		case "jump":
			return [payload.edge.block];
		case "branch":
			return [payload.consequent.block, payload.alternate.block];
		case "guard":
			return [payload.success.block, payload.fallback.block];
		case "switch":
			return [...payload.cases.map(({ edge }) => edge.block), payload.default.block];
		case "return":
		case "throw":
		case "unreachable":
			return [];
	}
}

describe("Core construction", () => {
	it("constructs straight-line Core directly in one program-owned store", () => {
		const compilation = compile("let value = 1 + 2; globalThis.answer = value;");
		const [entry] = [...compilation.program.functionIds()];
		const fn = compilation.program.function(entry!);
		expect([...fn.blockIds()].length).toBeGreaterThan(0);
		expect(operationNames(compilation.program, entry!)).toEqual(
			expect.arrayContaining(["createNumber", "binary", "storeProperty"]),
		);
		expect(compilation.program.globalCount).toBeGreaterThan(0);
		expect(compilation.program.stringConstants.length).toBeGreaterThan(0);
		expect(compilation.program.sourcePositions.length).toBeGreaterThan(0);
	});

	it("constructs branches, joins, and loops with block parameters", () => {
		const compilation = compile(`
			let value = 0;
			if (globalThis.flag) value = 1;
			else value = 2;
			for (let index = 0; index < 3; index++) value += index;
			globalThis.answer = value;
		`);
		const [entry] = [...compilation.program.functionIds()];
		const fn = compilation.program.function(entry!);
		const payloads = terminators(compilation.program, entry!);
		expect(payloads.some(({ kind }) => kind === "branch")).toBe(true);
		expect(
			[...fn.blockIds()].some(
				(block) => inspectCoreBlockParameters(fn, block).length > 0,
			),
		).toBe(true);
		expect(
			[...fn.blockIds()].some((block) =>
				targetBlocks(inspectCoreTerminatorPayload(fn, fn.blockTerminator(block))).some(
					(target) => target < block,
				),
			),
		).toBe(true);
	});

	it("constructs exceptional flow, async metadata, and captured storage", () => {
		const compilation = compile(`
			let globalValue = 1;
			async function outer(argument) {
				let captured = argument;
				try {
					await Promise.resolve(captured);
				} catch (error) {
					captured = error;
				}
				return () => captured + globalValue;
			}
			globalThis.outer = outer;
		`);
		const functions = [...compilation.program.functionIds()];
		expect(functions.length).toBeGreaterThanOrEqual(3);
		expect(functions.some((id) => compilation.program.function(id).isAsync)).toBe(true);
		expect(
			functions.some((id) => compilation.program.function(id).metadata.capturedCount > 0),
		).toBe(true);
		expect(
			functions.some((id) =>
				[...compilation.program.function(id).blockIds()].some(
					(block) =>
						inspectCoreBlockHandler(compilation.program.function(id), block) !==
						undefined,
				),
			),
		).toBe(true);
		const names = functions.flatMap((id) => operationNames(compilation.program, id));
		expect(names).toEqual(expect.arrayContaining(["loadCaptured", "storeCaptured"]));
	});

	it("constructs guard facts with stable instruction and fact identities", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const success = builder.createBlock();
		const fallback = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: success, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: {
				kind: "test-identity",
				value: true,
				claims: [{ kind: "identity", subject: condition!, identities: [true] }],
				origin: "core-construction-test",
			},
		});
		builder.setTerminator(success, { kind: "return", value: condition! });
		builder.setTerminator(fallback, { kind: "return", value: condition! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const payload = inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry));
		expect(payload).toMatchObject({ kind: "guard", fact });
		expect(fn.fact(fact).validity).toEqual({
			kind: "guard",
			instruction: fn.blockTerminator(entry),
		});
	});
});
