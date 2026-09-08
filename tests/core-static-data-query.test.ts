import { describe, expect, it } from "vitest";
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
