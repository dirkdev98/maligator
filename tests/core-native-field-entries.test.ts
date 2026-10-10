import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
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
	validateNativeDirectEntry,
} from "../src/compiler/target/program-image.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";

describe("own-field native entry contracts", () => {
	it("retains origin proofs across verification and rejects incompatible field hypotheses", () => {
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`class Mix { read(order) { return +order.payload + order.net; } }
				const rules = [new Mix()];
				for (let i = 0; i < 3; i++) globalThis.result = rules[i % rules.length].read({
					net:i * 7, payload:{valueOf(){return 2;}}
				});`,
				"field-origin-proof.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
			(_phase, run) => run(),
		);
		const entry = core.plan.directEntries.find(
			(entry) => entry.fieldParameters !== undefined,
		)!;
		expect(entry).toBeDefined();
		expect(() =>
			verifyCoreOptimizationPlan(core.program, core.plan, core.context),
		).not.toThrow();
		const fields = {
			...entry.fieldParameters!,
			representations: entry.fieldParameters!.representations.map((rep) =>
				rep === "boxed" ? ("f64" as const) : rep,
			),
		};
		const fn = core.program.function(entry.function);
		const variant = analyzeCoreNativeEntry(
			fn,
			buildCoreControlFlow(core.program, entry.function, { exceptions: true }),
			entry.parameterRepresentations,
			undefined,
			entry.callSites,
			fields,
		);
		const forged = { ...entry, ...variant, fieldParameters: fields };
		expect(() =>
			verifyCoreOptimizationPlan(
				core.program,
				{
					...core.plan,
					directEntries: core.plan.directEntries.map((current) =>
						current === entry ? forged : current,
					),
				},
				core.context,
			),
		).toThrow(/field argument proof/);
	});

	it("transports Boolean, String and boxed fields with their proven ABI", () => {
		const image = compactProgramImageConstants(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`class Mix { read(order) {
						const base = +order.payload;
						return order.active ? order.label + (order.net + base) : order.label;
					} }
					const rules = [new Mix()];
					for (let i = 0; i < 3; i++) globalThis.result = rules[i % rules.length].read({
						net: i * 7, active: i > 0, label: 'label-' + i, payload: {valueOf(){return 2;}}
					});`,
					"mixed-field-contract.js",
				),
				{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
			),
		).definition;
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const caller = decoded.native.functions.find((fn) => fn.fieldCalls !== undefined)!;
		expect(caller).toBeDefined();
		const site = caller.fieldCalls![0]!;
		expect(site.valueRepresentations).toEqual(["number", "boolean", "string", "boxed"]);
		const selected = site.entries[0]!;
		const target = decoded.native.functions[selected.functionIndex]!;
		const entry = target.directEntries[selected.entryId]!;
		expect(entry.fieldParameters!.representations).toEqual([
			"boxed",
			"boolean",
			"string",
			"number",
		]);
		const emitted = emitCompiledFunction(target, selected.functionIndex, "", false)!;
		expect(emitted.directEntries[0]!.leaf).toBeUndefined();
		expect(emitted.directEntries[0]!.source).toContain("MalValue fp0");
		expect(emitted.directEntries[0]!.source).toContain("bool fp1");
		expect(emitted.directEntries[0]!.source).toContain("mal_vm_unary_op");
		const load = entry.fieldParameters!.loads.find((load) => load.field === 3)!;
		const malformed = {
			...entry,
			fieldParameters: {
				...entry.fieldParameters!,
				representations: entry.fieldParameters!.representations.map((rep, index) =>
					index === load.field ? ("boxed" as const) : rep,
				),
			},
		};
		expect(() => validateNativeDirectEntry(target.body, malformed)).toThrow(/field load/);
		const forgedSource = {
			...caller,
			fieldCalls: [
				{
					...site,
					valueRepresentations: ["boxed", "boolean", "string", "boxed"] as const,
				},
			],
		};
		expect(() =>
			validateNativeFieldCalls(caller.body, forgedSource, decoded.native.functions),
		).toThrow(/field entry target/);
	});

	it("joins disagreeing field facts and selects caller-specific boxing", () => {
		const image = compactProgramImageConstants(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`class Mix { read(order) { return order.value + order.net; } }
					const rules = [new Mix()];
					for (let i = 0; i < 3; i++) {
						globalThis.first = rules[i % rules.length].read({value:i * 2, net:i * 7});
						globalThis.second = rules[i % rules.length].read({value:'value-' + i, net:i * 7});
					}`,
					"mixed-field-join.js",
				),
				{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
			),
		).definition;
		const calls = image.native.functions
			.flatMap((fn) => fn.storage!.callTransports)
			.flatMap((plan) => plan.targets)
			.filter((target) => target.fields.length > 0);
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((call) => call.entryId)).size).toBe(1);
		expect(calls.map((call) => call.fields[0]!.conversion)).toEqual([
			"box-number",
			"identity",
		]);
	});

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
			expect(calls).toHaveLength(1);
			const target = calls[0]!.entries[0]!;
			const native = image.native.functions[target.functionIndex]!;
			const emitted = emitCompiledFunction(native, target.functionIndex, "", false)!;
			expect(emitted.directEntries).toHaveLength(1);
			// Replaceable Math methods keep their identity guard and an unknown result.
			if (primordials === "mutable" && expression.startsWith("Math."))
				expect(emitted.directEntries[0]!.source).toContain("_callee_matches(");
			else expect(emitted.directEntries[0]!.source).not.toContain("mal_vm_binary_op");
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

	it("dispatches strict targets to field entries when mutable Math methods stay generic", () => {
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
		expect(calls[0]!.entries).toHaveLength(2);
	});
});
