import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeNumericBuiltinInstruction } from "../src/compiler/target/lower-native-fast-paths.ts";
import { analyzeRecordIteration } from "../src/compiler/target/native-record-iteration.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

const UPDATE = `
let total = 0;
for (const row of rows) {
  const point = row.point;
  point.x += row.delta;
  const value = row.profile?.x ?? 7;
  if (row.active) total += point.x + value;
}
return total;
`;

function compile(body = UPDATE) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel = function kernel(rows) { ${body} };`,
			"/record-iteration.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: { primordials: "locked", eval: false, realms: false },
				}),
			),
		},
	);
}

function graphPlans(image: ReturnType<typeof compile>) {
	return image.native.functions[1]!.storage!.numericLoopRegions.filter(
		(plan) => plan.kind === "array-iteration" && plan.recordGraph !== undefined,
	);
}

describe("native record iteration planning", () => {
	it("invalidates a nullish predicate after its tested register changes", () => {
		const template = compile().native.functions[1]!;
		const fn = {
			...template.body,
			instructions: [
				{ opcode: "ITERATOR_STEP", valueDst: 0, doneDst: 1, iterator: 20, next: 21 },
				{ opcode: "JUMP_IF", cond: 1, targetIp: 11 },
				{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 0, stringIndex: 0, icIndex: 0 },
				{ opcode: "CREATE_UNDEFINED", dst: 3 },
				{ opcode: "CREATE_UNDEFINED", dst: 4 },
				{ opcode: "BINARY", dst: 5, left: 3, right: 4, operator: "==" },
				{ opcode: "CREATE_BOOLEAN", dst: 3, value: true },
				{ opcode: "JUMP_IF", cond: 5, targetIp: 9 },
				{ opcode: "JUMP", targetIp: 10 },
				{ opcode: "BINARY", dst: 6, left: 3, right: 2, operator: "+" },
				{ opcode: "JUMP", targetIp: 0 },
				{ opcode: "RETURN", value: 2 },
			],
		} satisfies typeof template.body;
		expect(
			analyzeRecordIteration(
				fn,
				fn.instructions.slice(0, -1).map((_, ip) => ip),
				0,
				Array.from({ length: 22 }, () => "boxed"),
				nativeNumericBuiltinInstruction,
			),
		).toBeUndefined();
	});
	it("carries nested records, Boolean fields and nullish Number joins through the codec", () => {
		const image = deserializeCompilerArtifact(serializeCompilerArtifact(compile()));
		const [plan] = graphPlans(image);
		expect(plan?.kind).toBe("array-iteration");
		if (plan?.kind !== "array-iteration") throw new Error("Missing record iteration");
		expect(plan.recordGraph!.references.some((reference) => reference.nullable)).toBe(
			true,
		);
		expect(new Set(plan.recordGraph!.fields.map((field) => field.kind))).toEqual(
			new Set(["reference", "number", "boolean"]),
		);
		expect(plan.recordGraph!.fields.some((field) => field.stored)).toBe(true);
		expect(emitCompiledFunction(image.native.functions[1]!, 1, "", false)).not.toBeNull();
	});

	it("rejects forged field kinds before native emission", () => {
		const image = compile();
		const [plan] = graphPlans(image);
		if (plan?.kind !== "array-iteration") throw new Error("Missing record iteration");
		const altered = {
			...plan,
			recordGraph: {
				...plan.recordGraph!,
				fields: plan.recordGraph!.fields.map((field) => ({
					...field,
					kind: "number" as const,
				})),
			},
		};
		const native = image.native.functions[1]!;
		const bad = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) =>
					fn !== native
						? fn
						: {
								...fn,
								storage: {
									...fn.storage!,
									numericLoopRegions: fn.storage!.numericLoopRegions.map((region) =>
										region === plan ? altered : region,
									),
								},
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(bad)).toThrow(/storage|loop/i);
	});

	it.each([
		"let carry=1,total=0; for(const row of rows){total+=carry;carry=!row.active;} return total;",
		"let total=0;for(const row of rows){if(row.active)globalThis.saved=row.point;total+=row.point.x;}return total;",
		"let total=0;for(const row of rows){row.point.x+=row.delta;total+=row.profile.x;row.point={x:1};}return total;",
		"let total=0;for(const row of rows){row.point.x+=row.delta;total+=row.read();}return total;",
	])(
		"keeps changing kinds, escapes and observable effects outside the region: %s",
		(body) => {
			const image = compile(body);
			expect(graphPlans(image)).toEqual([]);
			expect(
				emitCompiledFunction(image.native.functions[1]!, 1, "", false),
			).not.toBeNull();
		},
	);
});
