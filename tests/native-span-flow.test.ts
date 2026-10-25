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
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import {
	lowerNativeStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(
	producer: string,
	overwrite: boolean,
	primordials: "mutable" | "locked",
	profile = false,
) {
	const path = "/surviving-span.js";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: false, realms: false, primordials } }),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function classify(source, escape, observe) {
				let part=${producer};
				if(escape!==escape) ${overwrite ? "part=" : ""}observe(part);
				return part.length+(part==='if'?10:0);
				}
				console.log(classify(globalThis.input,'string',globalThis.observe),
				classify(globalThis.input,NaN,globalThis.observe));`,
				path,
			),
			{ facts, profile, coreVerification: "per-pass" },
		),
		"precise",
	);
}

const producers = ["source.split('|')[1]", "/x(.*)z/.exec(source)[1]"];

describe("span lifetime on surviving entry flow", () => {
	it.each(["mutable", "locked"] as const)(
		"drops dead observers without inventing helper entries under %s primordials",
		(primordials) => {
			for (const producer of producers) {
				const original = compile(producer, false, primordials);
				for (const image of [
					original,
					deserializeCompilerArtifact(serializeCompilerArtifact(original)),
				]) {
					const native = image.native.functions[1]!;
					const canonical = native.storage!.spanContinuations[0]!;
					const observer = canonical.consumers.find((c) => c.kind === "materialize")!;
					expect(observer).toBeDefined();
					const entry = native.directEntries.find(
						(e) => e.parameterRepresentations[1] === "string",
					)!;
					const storage = entry.storage!;
					expect(storage.controlFlow!.unreachableIps).toContain(observer.ip);
					expect(storage.spanContinuations).toHaveLength(1);
					expect(storage.spanContinuations[0]!.consumers.map((c) => c.kind)).toEqual([
						"length",
						"equal",
					]);
					expect(storage.stringComparisons).toContainEqual(
						expect.objectContaining({ length: 2, kind: "boxed" }),
					);
					expect(() =>
						validateNativeStorage(native, new Map(), image.runtime.stringConstants),
					).not.toThrow();
					const emitted = emitCompiledFunction(
						native,
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
					for (const source of [emitted.source, emitted.directEntries[0]!.source]) {
						expect(source).toContain("mal_builtin_string_span_equal(");
						expect(source).toContain("mal_ops_strict_equal_string_constant(");
					}
					expect(() =>
						validateNativeStorage(
							{
								...native,
								directEntries: native.directEntries.map((e) =>
									e.id !== entry.id
										? e
										: {
												...e,
												storage: { ...storage, spanContinuations: [canonical] },
											},
								),
							},
							new Map(),
							image.runtime.stringConstants,
						),
					).toThrow(/storage/i);
				}
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"ignores a dead overwrite but retains live mixed aliases under %s primordials",
		(primordials) => {
			for (const producer of producers) {
				const image = compile(producer, true, primordials);
				const native = image.native.functions[1]!;
				expect(native.storage!.spanContinuations).toEqual([]);
				const entry = native.directEntries.find(
					(e) => e.parameterRepresentations[1] === "string",
				)!;
				expect(entry.storage!.controlFlow!.unreachableIps.length).toBeGreaterThan(0);
				expect(entry.storage!.spanContinuations).toHaveLength(1);
				expect(entry.storage!.spanContinuations[0]!.consumers.map((c) => c.kind)).toEqual(
					["length", "equal"],
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
				expect(() => emitProgramImage(image)).not.toThrow();
			}
		},
	);
	it("keeps every profiling instruction visible", () => {
		const image = compile(producers[0]!, false, "locked", true);
		for (const native of image.native.functions) {
			expect(native.storage!.spanContinuations).toEqual([]);
			for (const entry of native.directEntries)
				expect(entry.storage!.spanContinuations).toEqual([]);
		}
		expect(() => emitProgramImage(image)).not.toThrow();
	});
});
