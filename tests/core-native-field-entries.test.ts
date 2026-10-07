import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeEntryLookup } from "../src/compiler/target/lower-native-calls.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import {
	compactProgramImageConstants,
	validateNativeFieldCalls,
} from "../src/compiler/target/program-image.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";

describe("numeric own-field native entry contracts", () => {
	it("clears auxiliary field roots on every exceptional exit from a native window", () => {
		const image = compactProgramImageConstants(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`class Quote { read(order) { return order.net + 7; } }
					class Other { read(order) { return order.net + 8; } }
					const rules = [new Quote(), new Other()];
					for (let i = 0; i < 3; i++) {
						const order = {net:i * 7, metadata:{i}};
						globalThis.checkpoint();
						globalThis.result = rules[i % 2].read(order);
					}`,
					"field-root-cleanup.js",
				),
				{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
			),
		).definition;
		const caller = image.native.functions.find((fn) => fn.fieldCalls !== undefined)!;
		expect(caller).toBeDefined();
		const site = caller.fieldCalls![0]!;
		expect(
			caller.body.instructions
				.slice(site.allocationIp + 1, site.callIp)
				.some((op) => op.opcode === "CALL"),
		).toBe(true);
		const handlerIp = caller.body.instructions.length - 1;
		const body = {
			...caller.body,
			handlers: [{ startIp: site.allocationIp, endIp: site.callIp + 1, handlerIp }],
		};
		const native = { ...caller, body };
		validateNativeFieldCalls(body, native, image.native.functions);
		const entries = nativeEntryLookup(image.native.functions);
		const lowered = lowerNativeFunctionStorage(
			native,
			entries,
			image.runtime.stringConstants,
		);
		const emitted = emitCompiledFunction(
			lowered,
			caller.functionIndex,
			"",
			false,
			"static",
			new Set(image.native.functions.map((fn) => fn.functionIndex)),
			image.native.semanticProtectors,
			entries,
		)!;
		const fallback = emitted.source.slice(emitted.source.indexOf("__field_target_"));
		const slot = fallback.match(/MalValue\[\]\)\{[^\n]*__gc_slots\[(\d+)\]/)?.[1];
		expect(slot).toBeDefined();
		const transfers = [
			...emitted.source.matchAll(new RegExp(`goto L${handlerIp};`, "g")),
		];
		expect(transfers.length).toBeGreaterThan(1);
		for (const transfer of transfers) {
			const line = emitted.source.slice(
				emitted.source.lastIndexOf("\n", transfer.index) + 1,
				transfer.index,
			);
			expect(line).toContain(`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
		}
	});

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
			const emitted = emitCompiledFunction(native, target.functionIndex, "", false)!;
			expect(emitted.directEntries).toHaveLength(1);
			expect(emitted.directEntries[0]!.source).not.toContain("mal_vm_binary_op");
		}
	});

	it("specializes all three pricing methods and retains a guarded materialization fallback", () => {
		const image = compactProgramImageConstants(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`
					class StandardPricing { quote(order) { return order.net + 7; } }
					class VolumePricing { quote(order) { return order.net - Math.floor(order.net / 12); } }
					class PriorityPricing { quote(order) { return order.net + Math.max(15, order.quantity * 3); } }
					const rules = [new StandardPricing(), new VolumePricing(), new PriorityPricing()];
					for (let index = 0; index < 9; index++)
						globalThis.result = rules[index % rules.length].quote({ net: (index * 47) % 800, quantity: (index % 9) + 1 });
				`,
					"field-entry-contract.js",
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
		expect(() =>
			validateNativeFieldCalls(
				{
					...caller.body,
					handlers: [{ startIp: call.allocationIp, endIp: call.callIp, handlerIp: 0 }],
				},
				caller,
				decoded.native.functions,
			),
		).toThrow(/Invalid native field call/);
		expect(call.entries).toHaveLength(3);
		expect(caller.body.instructions[call.allocationIp]).toMatchObject({
			opcode: "CREATE_OBJECT_SHAPED",
			count: 2,
		});
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
			const emitted = emitCompiledFunction(native, selected.functionIndex, "", false)!;
			expect(emitted.directEntries).toHaveLength(1);
			expect(emitted.directEntries[0]!.source).toContain("fp0");
			expect(emitted.directEntries[0]!.source).not.toContain("mal_vm_binary_op");
			const leaf = emitted.directEntries[0]!;
			if (
				native.body.instructions.every(
					(op) => op.opcode !== "CALL" && op.opcode !== "CALL_KNOWN",
				)
			) {
				expect(leaf.leaf).toBe(true);
				const worker = leaf.source.slice(
					0,
					leaf.source.lastIndexOf("\n", leaf.source.indexOf(`${leaf.symbol}(`)),
				);
				expect(worker).not.toMatch(/MalVm|MalEnv|mal_gc_|vm->/);
			} else expect(leaf.leaf).toBeUndefined();
		}
		const emitted = emitCompiledFunction(
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

	it("retains eligible arithmetic entries when mutable Math methods stay generic", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Standard { quote(order) { return order.net + 7; } }
				class Volume { quote(order) { return order.net - Math.floor(order.net / 12); } }
				const rules = [new Standard(), new Volume()];
				for (let index = 0; index < 8; index++)
					globalThis.result = rules[index & 1].quote({ net: index * 7 });`,
				"mutable-partial-field-entry.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials: "mutable" } }),
				),
			},
		);
		const calls = image.native.functions.flatMap((fn) => fn.fieldCalls ?? []);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.entries).toHaveLength(1);
	});
});
