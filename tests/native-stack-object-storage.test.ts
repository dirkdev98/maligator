import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function test(input) { ${body} } globalThis.test=test; globalThis.result=test(12);`,
			"/stack-fields.js",
		),
	);
}

describe("native typed stack fields", () => {
	it("persists three independent field representations from an activation-local certificate", () => {
		const image = compile(
			"const o={x:1.5,y:2,flag:true}; o.y=3; return o===input?-1:o.x+o.y+(o.flag?1:0);",
		);
		const native = image.native.functions[1]!;
		expect(native.storage!.stackObjects).toHaveLength(1);
		expect(native.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"int32",
			"boolean",
		]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(native.directEntries.length).toBeGreaterThan(0);
		for (const entry of native.directEntries)
			expect(entry.storage!.stackObjects[0]!.slotRepresentations).toEqual([
				"number",
				"int32",
				"boolean",
			]);
	});

	it.each([
		"const n=+input; const o={x:n,y:2,flag:true}; return o===input?-1:o.x+o.y;",
		"const o={x:1.5,y:2,flag:true}; o.y=input; return o===input?-1:o.y;",
		"const o={x:1.5,y:2,flag:true}; return input?o:o.x;",
	])(
		"retains boxed storage when a field or materialization lacks the typed contract",
		(body) => {
			const native = compile(body).native.functions[1]!;
			expect(native.storage!.stackObjects).toEqual([]);
		},
	);

	it("rejects missing layouts, wrong field types and a forged allocation", () => {
		const image = compile(
			"const o={x:1.5,y:2,flag:true}; o.y=3; return o===input?-1:o.x+o.y+(o.flag?1:0);",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.stackObjects[0]!;
		for (const stackObjects of [
			[],
			[{ ...plan, slotRepresentations: ["boolean", "int32", "boolean"] as const }],
			[{ ...plan, slotRepresentations: ["number"] as const }],
			[{ ...plan, allocationIp: plan.allocationIp + 1 }],
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, stackObjects },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
