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
});
