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
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked", profile = false) {
	const path = "/map-flow.mjs";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: false, realms: false, primordials } }),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function inspect(source,flag,observe){${body}}globalThis.inspect=inspect;
			console.log(inspect(globalThis.input,'string',globalThis.observe),
			inspect(globalThis.input,NaN,globalThis.observe));`,
			path,
		),
		{ facts, profile, coreVerification: "per-pass" },
	);
}

const deadSets = `const a=source.get(1),b=source.get(2);
if(flag!==flag){source.set(1,a);source.set(2,b);}return [a,b];`;

describe("Map hints on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"retires dead endpoint pairs while retaining canonical hints under %s primordials",
		(primordials) => {
			for (const body of [
				deadSets,
				`if(flag!==flag){const a=source.get(1),b=source.get(2);
				source.set(1,a);source.set(2,b);}return flag;`,
			]) {
				const original = compile(body, primordials);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const fn = image.native.functions[1]!;
					expect(fn.storage!.mapEntries).toHaveLength(2);
					const entry = fn.directEntries.find(
						(e) => e.parameterRepresentations[1] === "string",
					)!;
					expect(entry.storage!.mapEntries).toEqual([]);
					expect(
						fn.storage!.mapEntries.every((plan) =>
							plan.claimedIps.some((ip) =>
								entry.storage!.controlFlow!.unreachableIps.includes(ip),
							),
						),
					).toBe(true);
					const emitted = emitCompiledFunction(
						fn,
						fn.functionIndex,
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
					expect(emitted.source).toContain("u32 __map_entry_");
					expect(emitted.directEntries[entry.id]!.source).not.toContain(
						"u32 __map_entry_",
					);
					expect(() =>
						validateNativeProgramStorage(image.native, image.runtime.stringConstants),
					).not.toThrow();
					expect(() =>
						serializeCompilerArtifact({
							...image,
							native: {
								...image.native,
								functions: image.native.functions.with(1, {
									...fn,
									directEntries: fn.directEntries.map((e) =>
										e !== entry
											? e
											: {
													...e,
													storage: { ...e.storage!, mapEntries: fn.storage!.mapEntries },
												},
									),
								}),
							},
						}),
					).toThrow(/storage/);
				}
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"retains revalidated reuse across a dead receiver overwrite under %s primordials",
		(primordials) => {
			const image = compile(
				`let alias=source;const a=source.get(1),b=source.get(2);
			if(flag!==flag)alias=observe();alias.set(1,a);alias.set(2,b);return [a,b];`,
				primordials,
			);
			const fn = image.native.functions[1]!;
			expect(fn.storage!.mapEntries).toHaveLength(2);
			const entry = fn.directEntries.find(
				(e) => e.parameterRepresentations[1] === "string",
			)!;
			expect(entry.storage!.mapEntries).toHaveLength(2);
			expect(
				deserializeCompilerArtifact(serializeCompilerArtifact(image)).native,
			).toEqual(image.native);
		},
	);
	it("keeps profiled observations and declines hint reuse", () => {
		const image = compile(deadSets, "locked", true);
		const fn = image.native.functions[1]!;
		expect(fn.storage!.mapEntries).toEqual([]);
		for (const entry of fn.directEntries) expect(entry.storage!.mapEntries).toEqual([]);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(image)).profiling,
		).toEqual(image.profiling);
	});
});
