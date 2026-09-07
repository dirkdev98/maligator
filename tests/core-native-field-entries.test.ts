import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { compactProgramImageConstants } from "../src/compiler/target/program-image.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";

describe("numeric own-field native entry contracts", () => {
	it.each([
		"r.x + (r.y > 0)",
		"r.x + (r.y > 0 ? null : undefined)",
		"Math.abs(r.x) + Math.ceil(r.y)",
	])("uses certified field computations for %s", (expression) => {
		for (const primordials of ["locked", "mutable"] as const) {
			const image = deserializeCompilerArtifact(
				serializeCompilerArtifact(
					compileSemanticProgramToProgramImage(
						analyzeSourceAndRunSemanticAnalysis(
							`
					class Price { quote(r) { return ${expression}; } }
					const price = new Price();
					for (let i = 0; i < 3; i++) globalThis.result = price.quote({x:i, y:1, metadata:'retail'});
				`,
							"field-unions.js",
						),
						{
							facts: compilerProgramFactsFromConfig(
								resolveBuildConfig({ engine: { primordials } }),
							),
						},
					),
				),
			);
			const calls = image.native.functions.flatMap((fn) => fn.fieldCalls ?? []);
			if (primordials === "mutable" && expression.startsWith("Math.")) {
				expect(calls).toHaveLength(0);
				continue;
			}
			expect(calls).toHaveLength(1);
			const target = calls[0]!.entries[0]!;
			const native = image.native.functions[target.functionIndex]!;
			const emitted = emitCompiledFunction(
				image.runtime.functions[target.functionIndex]!,
				native,
				target.functionIndex,
				"",
				false,
			)!;
			expect(emitted.directEntries).toHaveLength(1);
			expect(emitted.directEntries[0]!.source).not.toContain("mal_vm_binary_op");
		}
	});

	it("specializes all three pricing methods and retains a guarded materialization fallback", () => {
		const image = compactProgramImageConstants(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					readFileSync("bench/javascript.mjs", "utf8"),
					"field-benchmark.mjs",
				),
				{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
			),
		).definition;
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(decoded.native.functions.map((fn) => fn.fieldCalls)).toEqual(
			image.native.functions.map((fn) => fn.fieldCalls),
		);
		const caller = decoded.native.functions.find((fn) => fn.fieldCalls !== undefined)!;
		expect(caller.fieldCalls).toHaveLength(1);
		const call = caller.fieldCalls![0]!;
		expect(call.entries).toHaveLength(3);
		const entries = new Map(
			call.entries.map((selected) => [
				directCompiledEntryKey(selected.functionIndex, selected.entryId),
				decoded.native.functions[selected.functionIndex]!.directEntries[
					selected.entryId
				]!,
			]),
		);
		for (const selected of call.entries) {
			const native = decoded.native.functions[selected.functionIndex]!;
			const entry = native.directEntries[selected.entryId]!;
			expect(entry.resultRepresentation).toBe("number");
			const emitted = emitCompiledFunction(
				decoded.runtime.functions[selected.functionIndex]!,
				native,
				selected.functionIndex,
				"",
				false,
			)!;
			expect(emitted.directEntries).toHaveLength(1);
			expect(emitted.directEntries[0]!.source).toContain("fp0");
			expect(emitted.directEntries[0]!.source).not.toContain("mal_vm_binary_op");
			const leaf = emitted.directEntries[0]!;
			if (
				decoded.runtime.functions[selected.functionIndex]!.instructions.every(
					(op) => op.opcode !== "CALL",
				)
			) {
				expect(leaf.leaf).toBe(true);
				const worker = leaf.source.slice(
					0,
					leaf.source.indexOf(`\nstatic double ${leaf.symbol}(`),
				);
				expect(worker).not.toMatch(/MalVm|MalEnv|mal_gc_|vm->/);
			} else expect(leaf.leaf).toBeUndefined();
		}
		const emitted = emitCompiledFunction(
			decoded.runtime.functions[caller.functionIndex]!,
			caller,
			caller.functionIndex,
			"",
			false,
			"static",
			new Set(call.entries.map((entry) => entry.functionIndex)),
			decoded.native.semanticProtectors,
			entries,
		)!;
		expect(emitted.source).toContain("__field_target_");
		expect(emitted.source).toContain("mal_vm_create_object_shaped");
		for (const selected of call.entries)
			expect(emitted.source).toContain(
				`mal_direct_${selected.functionIndex}_${selected.entryId}(`,
			);
		const target = decoded.native.functions[call.entries[0]!.functionIndex]!;
		const malformed = {
			...decoded,
			native: {
				...decoded.native,
				functions: decoded.native.functions.map((fn) =>
					fn !== target
						? fn
						: {
								...fn,
								directEntries: fn.directEntries.map((entry) => ({
									...entry,
									fieldParameters: { ...entry.fieldParameters!, keys: [0xffffffff] },
								})),
							},
				),
			},
		};
		expect(() => serializeCompilerArtifact(malformed)).toThrow(/field/);
	});
});
