import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { coreStaticDataQueryPlan } from "../src/compiler/core/core-static-data-query.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateRuntimeImageMetadata } from "../src/compiler/target/runtime-image.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string) {
	return inspectStaticValueFunction(
		`function probe(x, from) { ${body} } globalThis.probe = probe;`,
		"probe",
	);
}

describe("static-data query representation", () => {
	it.each(["indexOf", "lastIndexOf"])(
		"compares dynamic elements directly for a short %s receiver",
		(method) => {
			const inspected = inspect(`return [x, , undefined, x].${method}(from);`);
			expect(inspected.structure.allocations).toBe(0);
			expect(inspected.structure.genericLookups).toBe(0);
			expect(inspected.structure.genericCalls).toBe(0);
			expect(inspected.structure.operations).toHaveLength(0);
			expect(
				inspected.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(false);
		},
	);

	it("refreshes pooled payload references after immutable pool replacement", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[120]],
			bigintConstants: [5n],
		});
		const builder = new CoreFunctionBuilder(program),
			entry = builder.createBlock();
		const [text] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [bigint] = builder.appendInstruction(entry, "createBigint", [], {
			attributes: { bigintIndex: 0 },
		});
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 2 },
		});
		for (const [index, value] of [text!, bigint!].entries()) {
			const [key] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: index },
			});
			builder.appendInstruction(entry, "defineProperty", [array!, key!, value], {
				attributes: { enumerable: true },
			});
		}
		const [result] = builder.appendInstruction(entry, "callKnown", [array!, text!], {
			attributes: { operation: "Array.prototype.includes" },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const id = builder.finish(entry).function;
		const query = () => {
			const fn = program.function(id);
			const analysis = new CoreStaticValueAnalysis(program, fn, () =>
				buildCoreControlFlow(program, id),
			);
			return coreStaticDataQueryPlan(
				program,
				fn,
				analysis,
				coreInstructionId(fn.kernel.valueDefinitionOwner(result!)),
			);
		};
		expect(query()?.words).toEqual([8, 2, 5, 0, 6, 0]);
		const editor = CoreEditor.open(program, id);
		editor.appendStringConstants([[120]]);
		editor.appendBigintConstants([5n]);
		editor.commit();
		expect(query()?.words).toEqual([8, 2, 5, 1, 6, 1]);
	});

	it.each([32, 4096])("keeps executable code bounded for %s elements", (count) => {
		const inspected = inspect(
			`return [${Array.from({ length: count }, (_, index) => index).join(",")}].includes(x, from);`,
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(
			inspected.core.filter((operation) => operation.opcode === "queryStaticData"),
		).toHaveLength(1);
		expect(inspected.core.length).toBeLessThan(8);
		expect(inspected.c.source.length).toBeLessThan(12000);
	});

	it.each([
		["indexOf", "index-of"],
		["lastIndexOf", "last-index-of"],
	])("lowers %s to an allocation-free ordered table search", (method, kind) => {
		const inspected = inspect(
			`return [1, , undefined, NaN, -0, 1, "equal", 5n].${method}(x, from);`,
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(inspected.structure.genericLookups).toBe(0);
		expect(inspected.structure.genericCalls).toBe(0);
		const queries = inspected.fn.instructions.filter(
			(instruction) => instruction.opcode === "QUERY_STATIC_DATA",
		);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.queryKind).toBe(kind);
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(inspected.image),
		);
		expect(restored.runtime.functions).toEqual(inspected.image.runtime.functions);
	});

	it("keeps holes distinct from explicit undefined in indexed searches", () => {
		const inspected = inspect("return [, undefined].indexOf(x, from);");
		const query = inspected.fn.instructions.find(
			(instruction) => instruction.opcode === "QUERY_STATIC_DATA",
		);
		if (query?.opcode !== "QUERY_STATIC_DATA") throw new Error("missing static query");
		expect(
			inspected.image.runtime.literalTemplateData.slice(
				query.templateOffset,
				query.templateOffset + 4,
			),
		).toEqual([8, 2, 7, 11]);
	});

	it("rebases data and its string/bigint references through merges and codec round trips", () => {
		const prefix = inspect('return ["prefix", 999n].includes(x, from);').image;
		const original = inspect('return ["needle", 5n].includes(x, from);').image;
		const merged = mergeProgramImages([prefix, original]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(merged.image));
		const index = merged.functionBases[1]!;
		const query = restored.runtime.functions
			.slice(index)
			.flatMap((fn) => fn.instructions)
			.find((instruction) => instruction.opcode === "QUERY_STATIC_DATA");
		if (query?.opcode !== "QUERY_STATIC_DATA") throw new Error("missing static query");
		expect(query.templateOffset).toBeGreaterThanOrEqual(
			prefix.runtime.literalTemplateData.length,
		);
		const data = restored.runtime.literalTemplateData.slice(
			query.templateOffset,
			query.templateOffset + 6,
		);
		expect(data).toEqual([
			8,
			2,
			5,
			prefix.runtime.stringConstants.length + original.runtime.literalTemplateData[3]!,
			6,
			prefix.runtime.bigintConstants.length,
		]);
		expect(restored.runtime.functions).toEqual(merged.image.runtime.functions);
	});

	it("rejects object payloads and invalid registers before emission", () => {
		const image = inspect('return ["x"].includes(x, from);').image;
		const query = image.runtime.functions
			.flatMap((fn) => fn.instructions)
			.find((instruction) => instruction.opcode === "QUERY_STATIC_DATA");
		if (query?.opcode !== "QUERY_STATIC_DATA") throw new Error("missing static query");
		expect(() =>
			validateRuntimeImageMetadata({
				...image.runtime,
				literalTemplateData: [8, 1, 9, 0],
			}),
		).toThrow(/primitive/);
		expect(() =>
			validateRuntimeImageMetadata({
				...image.runtime,
				functions: image.runtime.functions.map((fn) => ({
					...fn,
					instructions: fn.instructions.map((instruction) =>
						instruction === query ? { ...query, needle: fn.registerCount } : instruction,
					),
				})),
			}),
		).toThrow(/operands/);
	});

	it("represents an omitted lastIndexOf offset as floating-point infinity", () => {
		const inspected = inspect("return [1, 2, 1].lastIndexOf(x);");
		expect(
			inspected.core.some(
				(operation) =>
					operation.opcode === "createF64" && operation.attributes.value === Infinity,
			),
		).toBe(true);
	});
});

describe("constant static-array search results", () => {
	it.each(["includes", "indexOf", "lastIndexOf"])(
		"keeps native BigInt literal wrapping in %s comparisons",
		(method) => {
			for (const operands of [
				"[340282366920938463463374607431768211456n].METHOD(0n)",
				"[0n].METHOD(340282366920938463463374607431768211456n)",
			]) {
				const output = inspect(`return ${operands.replace("METHOD", method)};`);
				expect(
					output.core.some(
						(operation) =>
							operation.opcode === "queryStaticData" ||
							(operation.opcode === "binary" && operation.attributes.operator === "==="),
					),
				).toBe(true);
			}
		},
	);

	it.each([
		["includes", "Infinity", false],
		["indexOf", "99", -1],
		["lastIndexOf", "-Infinity", -1],
	] as const)(
		"folds the empty %s range with an effectful needle",
		(method, from, expected) => {
			const values = Array.from({ length: 32 }, (_, index) => index).join(",");
			const output = inspect(`return [${values}].${method}(x(), ${from});`);
			expect(output.structure.genericCalls).toBe(1);
			expect(
				output.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(false);
			expect(
				output.core
					.filter(
						(operation) =>
							operation.opcode ===
							(typeof expected === "boolean" ? "createBoolean" : "createNumber"),
					)
					.map((operation) => operation.attributes.value),
			).toContain(expected);
		},
	);

	it.each([
		["[NaN].includes(NaN)", true],
		["[NaN].includes(0)", false],
		["[-0].includes(0)", true],
		["[0].includes(-0)", true],
		["[,].includes()", true],
		["[,].includes(null)", false],
		["[undefined].includes()", true],
		["[5].includes(5n)", false],
		["[5n].includes(5n)", true],
		['["equal", "different"].includes("equal")', true],
		["[false, 0].includes(null)", false],
		["[1, 2, 1].includes(2, undefined)", true],
		["[1, 2, 1].includes(2, true)", true],
		["[1, 2, 1].includes(2, null)", true],
		['[1, 2, 1].includes(2, " 1.9 ")', true],
		['[1, 2, 1].includes(2, "-1")', false],
		['[1, 2, 1].includes(1, "Infinity")', false],
		['[1, 2, 1].includes(1, "-Infinity")', true],
		["[1, 2, 1].includes(1, NaN)", true],
		["[].includes(1, 1n)", false],
		[`[${Array.from({ length: 32 }, (_, index) => index).join(",")}].includes(31)`, true],
		[
			`[${Array.from({ length: 32 }, (_, index) => index).join(",")}].includes(32)`,
			false,
		],
		[`[${",".repeat(32)}].includes(undefined, 31)`, true],
	])("selects the SameValueZero result of %s", (expression, expected) => {
		const inspected = inspect(`return ${expression};`);
		expect(inspected.structure.allocations).toBe(0);
		expect(
			inspected.core.some((operation) =>
				["queryStaticData", "callKnown"].includes(operation.opcode),
			),
		).toBe(false);
		expect(
			inspected.core
				.filter((operation) => operation.opcode === "createBoolean")
				.map((operation) => operation.attributes.value),
		).toEqual([expected]);
	});

	it.each(['"1"', '"0b1"', "true", "null", "undefined"])(
		"uses the bounded includes chain for a dynamic needle and primitive offset %s",
		(from) => {
			const inspected = inspect(`return [1, 2, 1].includes(x, ${from});`);
			expect(inspected.structure.allocations).toBe(0);
			expect(inspected.structure.genericCalls).toBe(0);
			expect(
				inspected.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(false);
		},
	);

	it.each(["1n", "Symbol.iterator", "{ valueOf() { return 1; } }"])(
		"preserves nonempty includes offset coercion for %s",
		(from) => {
			const inspected = inspect(`return [1, 2, 1].includes(1, ${from});`);
			expect(
				inspected.core.filter((operation) => operation.opcode === "queryStaticData"),
			).toHaveLength(1);
		},
	);

	it.each([
		["[1, 2, 1].indexOf(1)", 0],
		["[1, 2, 1].lastIndexOf(1)", 2],
		["[1, 2, 1].lastIndexOf(1, undefined)", 0],
		["[1, 2, 1].lastIndexOf(1, NaN)", 0],
		["[1, 2, 1].indexOf(1, true)", 2],
		["[1, 2, 1].lastIndexOf(1, true)", 0],
		["[1, 2, 1].indexOf(1, false)", 0],
		["[1, 2, 1].lastIndexOf(1, false)", 0],
		["[1, 2, 1].indexOf(1, null)", 0],
		["[1, 2, 1].lastIndexOf(1, null)", 0],
		['[1, 2, 1].indexOf(1, "1")', 2],
		['[1, 2, 1].lastIndexOf(1, "2")', 2],
		['[1, 2, 1].indexOf(1, " -1.9 ")', 2],
		['[1, 2, 1].lastIndexOf(1, " -1.9 ")', 2],
		['[1, 2, 1].indexOf(1, "0x1")', 2],
		['[1, 2, 1].indexOf(1, "0b10")', 2],
		['[1, 2, 1].lastIndexOf(1, "")', 0],
		['[1, 2, 1].lastIndexOf(1, "invalid")', 0],
		['[1, 2, 1].indexOf(1, "Infinity")', -1],
		['[1, 2, 1].lastIndexOf(1, "-Infinity")', -1],
		["[1, 2, 1].indexOf(1, 0.9)", 0],
		["[1, 2, 1].indexOf(1, -1.9)", 2],
		["[1, 2, 1].lastIndexOf(1, -1.9)", 2],
		["[1, 2, 1].lastIndexOf(1, -2)", 0],
		["[1, 2, 1].indexOf(1, Infinity)", -1],
		["[1, 2, 1].indexOf(1, -Infinity)", 0],
		["[1, 2, 1].lastIndexOf(1, Infinity)", 2],
		["[1, 2, 1].lastIndexOf(1, -Infinity)", -1],
		["[1, 2, 1].lastIndexOf(1, -4)", -1],
		["[, undefined].indexOf()", 1],
		["[undefined, ,].lastIndexOf()", 0],
		["[, ,].indexOf(undefined)", -1],
		["[NaN, NaN].indexOf(NaN)", -1],
		["[NaN, NaN].lastIndexOf(NaN)", -1],
		["[-0, 0].indexOf(0)", 0],
		["[0, -0].lastIndexOf(0)", 1],
		["[5, 5n].indexOf(5n)", 1],
		["[5n, 5].lastIndexOf(5n)", 0],
		['["equal", "different", "equal"].lastIndexOf("equal")', 2],
		["[false, null, undefined].indexOf(null)", 1],
		["[false, 0].indexOf(0)", 1],
	])("selects the numeric result of %s", (expression, expected) => {
		const inspected = inspect(`return ${expression};`);
		expect(inspected.structure.allocations).toBe(0);
		expect(
			inspected.core.some((operation) => operation.opcode === "queryStaticData"),
		).toBe(false);
		expect(inspected.core.some((operation) => operation.opcode === "callKnown")).toBe(
			false,
		);
		expect(
			inspected.core
				.filter((operation) => ["createNumber", "createF64"].includes(operation.opcode))
				.map((operation) => operation.attributes.value),
		).toEqual([expected]);
	});

	it.each(["includes", "indexOf", "lastIndexOf"])(
		"preserves %s argument producer effects",
		(method) => {
			const inspected = inspect(
				`return [1, 2, 1].${method}((x(), 1), (x(), undefined), x());`,
			);
			expect(inspected.structure.genericCalls).toBe(3);
			expect(
				inspected.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(false);
		},
	);

	it.each(["includes", "indexOf", "lastIndexOf"])(
		"skips %s offset coercion for empty arrays",
		(method) => {
			const inspected = inspect(`return [].${method}(x(), from);`);
			expect(inspected.structure.genericCalls).toBe(1);
			expect(inspected.structure.allocations).toBe(0);
			expect(
				inspected.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(false);
		},
	);

	it.each(["from", "1n", "Symbol.iterator", "{ valueOf() { return 1; } }"])(
		"retains coercion for unsupported offset %s",
		(from) => {
			const inspected = inspect(`return [1, 2, 1].indexOf(1, ${from});`);
			expect(
				inspected.core.filter((operation) => operation.opcode === "queryStaticData"),
			).toHaveLength(1);
		},
	);
});
