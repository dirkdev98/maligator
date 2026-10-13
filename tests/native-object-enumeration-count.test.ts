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
const methods = [
	"keys",
	"values",
	"entries",
	"getOwnPropertyNames",
	"getOwnPropertySymbols",
	"ownKeys",
];
describe("count-only enumeration transport", () => {
	for (const method of methods)
		it.each(["mutable", "locked"] as const)(
			`${method} retains ignored argument evaluation under %s primordials`,
			(primordials) => {
				const image = compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`globalThis.count=function count(record,observe,unused){const snapshot=${method === "ownKeys" ? "Reflect" : "Object"}.${method}(record,observe(record),unused);return snapshot.length;};`,
						"extra-count.js",
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
						) === "count",
				)!;
				expect(fn.storage!.objectEnumerationSnapshots).toHaveLength(1);
				const call =
					fn.body.instructions[fn.storage!.objectEnumerationSnapshots[0]!.callIp]!;
				expect(call.opcode === "CALL" || call.opcode === "CALL_KNOWN").toBe(true);
				if (
					primordials === "mutable" &&
					(call.opcode === "CALL" || call.opcode === "CALL_KNOWN")
				)
					expect(call.arguments.length).toBeGreaterThan(1);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			},
		);
	for (const method of methods)
		it.each(["mutable", "locked"] as const)(
			`${method} keeps only the count across later effects under %s primordials`,
			(primordials) => {
				const image = compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`globalThis.count=function count(record,observe){const snapshot=${method === "ownKeys" ? "Reflect" : "Object"}.${method}(record);observe(record);return snapshot.length+snapshot.length;};`,
						"count.js",
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
						) === "count",
				)!;
				const plan = fn.storage!.objectEnumerationSnapshots[0]!;
				expect(plan.elementIps).toEqual([]);
				expect(plan.lengthIps.length).toBeGreaterThan(0);
				const source = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
				expect(source).toContain("mal_builtin_object_enumeration_count(");
				expect(source).not.toContain("mal_builtin_object_enumeration_snapshot(");
				expect(source).not.toContain("mal_builtin_object_enumeration_materialize(");
				expect(source).toContain(`MalValue __gc_slots[${fn.storage!.rootSlotCount}];`);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			},
		);
});
