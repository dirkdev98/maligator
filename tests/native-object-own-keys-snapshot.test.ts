import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(method: string, body: string, primordials: "mutable" | "locked") {
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect=function inspect(record,index,observe){const snapshot=${method === "ownKeys" ? "Reflect" : "Object"}.${method}(record);${body}};`,
			"own-keys.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
	const fn = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "inspect",
	)!;
	return { image, fn };
}

describe("own string and Symbol key snapshot contracts", () => {
	for (const [method, kind] of [
		["getOwnPropertyNames", "names"],
		["getOwnPropertySymbols", "symbols"],
		["ownKeys", "own_keys"],
	] as const) {
		it.each(["mutable", "locked"] as const)(
			`retains ${method} across calls and materializing reads under %s primordials`,
			(primordials) => {
				const { image, fn } = compile(
					method,
					"observe(record);return [snapshot.length,snapshot[index],snapshot[0]];",
					primordials,
				);
				const plan = fn.storage!.objectEnumerationSnapshots[0]!;
				expect(plan.kind).toBe(kind);
				expect(plan.lengthIps).toHaveLength(1);
				expect(plan.elementIps).toHaveLength(2);
				const source = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
				expect(source).toContain(`MAL_OBJECT_ENUMERATION_${kind.toUpperCase()}`);
				expect(source).toContain("mal_builtin_object_enumeration_materialize(vm,");
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() =>
					serializeCompilerArtifact({
						...image,
						native: {
							...image.native,
							functions: image.native.functions.with(image.native.functions.indexOf(fn), {
								...fn,
								storage: {
									...fn.storage!,
									objectEnumerationSnapshots: [
										{ ...plan, kind: kind === "names" ? "symbols" : "names" },
									],
								},
							}),
						},
					}),
				).toThrow(/invalid or stale storage plan/);
			},
		);
		it.each([
			"observe(snapshot);return snapshot.length;",
			"try{observe(record);}catch(error){return snapshot[0];}return snapshot.length;",
		])(`declines escaping or protected ${method} lifetimes: %s`, (body) => {
			expect(
				compile(method, body, "mutable").fn.storage!.objectEnumerationSnapshots,
			).toEqual([]);
		});
	}
});
