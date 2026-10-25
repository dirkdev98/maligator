import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked", profile = false) {
	const path = "/enumeration-flow.js";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: false, realms: false, primordials } }),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function inspect(source,flag,observe){${body}}globalThis.inspect=inspect;
				console.log(inspect(globalThis.input,'string',globalThis.observe),
				inspect(globalThis.input,NaN,globalThis.observe));`,
				path,
			),
			{ facts, profile, coreVerification: "per-pass" },
		),
		"precise",
	);
}

const methods = [
	["Object.keys", "keys"],
	["Object.values", "values"],
	["Object.entries", "entries"],
	["Object.getOwnPropertyNames", "names"],
	["Object.getOwnPropertySymbols", "symbols"],
	["Reflect.ownKeys", "own_keys"],
] as const;

describe("enumeration lifetime on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"admits counts and snapshots after dead observations under %s primordials",
		(primordials) => {
			for (const [method, kind] of methods) {
				for (const elements of [false, true]) {
					const original = compile(
						`const list=${method}(source);if(flag!==flag)observe(list);
						return ${elements ? "[list.length,list[0]]" : "list.length"};`,
						primordials,
					);
					for (const image of [
						original,
						deserializeCompilerArtifact(serializeCompilerArtifact(original)),
					]) {
						const fn = image.native.functions[1]!;
						expect(fn.storage!.objectEnumerationSnapshots).toEqual([]);
						const observerIp = fn.body.instructions.findIndex(
							(op) => op.opcode === "CALL" && op.callee === 2,
						);
						const entry = fn.directEntries.find(
							(e) => e.parameterRepresentations[1] === "string",
						)!;
						expect(entry.storage!.controlFlow!.unreachableIps).toContain(observerIp);
						const plans = entry.storage!.objectEnumerationSnapshots;
						expect(plans).toHaveLength(1);
						expect(plans[0]!.kind).toBe(kind);
						expect(plans[0]!.lengthIps).toHaveLength(1);
						expect(plans[0]!.elementIps).toHaveLength(elements ? 1 : 0);
						const emitted = emitCompiledFunction(
							fn,
							1,
							"",
							false,
							"static",
							new Set(),
							image.native.semanticProtectors,
							new Map(),
							false,
							new Set(),
							image.runtime.stringConstants,
						)!;
						expect(emitted.directEntries[entry.id]!.source).toContain(
							elements
								? "mal_builtin_object_enumeration_snapshot("
								: "mal_builtin_object_enumeration_count(",
						);
						expect(() =>
							validateNativeStorage(
								{
									...fn,
									directEntries: fn.directEntries.map((e) =>
										e.id !== entry.id
											? e
											: {
													...e,
													storage: { ...e.storage!, objectEnumerationSnapshots: [] },
												},
									),
								},
								new Map(),
								image.runtime.stringConstants,
							),
						).toThrow(/storage/i);
					}
				}
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"ignores a dead alias overwrite while retaining the generic path under %s primordials",
		(primordials) => {
			for (const [method, kind] of methods) {
				const image = compile(
					`let list=${method}(source);if(flag!==flag)list=observe(list);return list.length;`,
					primordials,
				);
				const fn = image.native.functions[1]!;
				expect(fn.storage!.objectEnumerationSnapshots).toEqual([]);
				const entry = fn.directEntries.find(
					(e) => e.parameterRepresentations[1] === "string",
				)!;
				expect(entry.storage!.objectEnumerationSnapshots).toEqual([
					expect.objectContaining({ kind, elementIps: [] }),
				]);
			}
		},
	);
	it("keeps protected lifetimes and profiling observations visible", () => {
		for (const [body, profile] of [
			[
				"try{const list=Object.values(source);if(flag!==flag)observe(list);return list.length;}catch(error){return error;}",
				false,
			],
			[
				"const list=Object.values(source);try{observe();}catch(error){return list.length;}return list.length;",
				false,
			],
			[
				"const list=Object.values(source);if(flag!==flag)observe(list);return list.length;",
				true,
			],
		] as const) {
			const image = compile(body, "locked", profile);
			for (const fn of image.native.functions) {
				expect(fn.storage!.objectEnumerationSnapshots).toEqual([]);
				for (const entry of fn.directEntries)
					expect(entry.storage!.objectEnumerationSnapshots).toEqual([]);
			}
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored.native).toEqual(image.native);
			expect(restored.runtime).toEqual(image.runtime);
			expect(restored.profiling).toEqual(image.profiling);
		}
	});
});
