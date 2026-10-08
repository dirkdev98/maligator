import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { selectNativeDirectHeapObjects } from "../src/compiler/target/lower-native-objects.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { vmRegionActions } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, preamble = "") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`${preamble} function test(input) { ${body} } globalThis.test=test; globalThis.result=test(12);`,
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

	it("keeps scalar fields in C locals and roots only the heap fields of a mixed object", () => {
		const image = compile(`
			const o={x:-0,payload:input,label:"old",flag:true};
			if(input){o.x=0/0;o.payload=globalThis.payload;o.label="new";o.flag=false;}
			else{o.payload=globalThis.other;o.label="next";}
			return o===input?"identity":[o.x,o.payload,o.label,o.flag];
		`);
		const native = image.native.functions[1]!;
		const plan = native.storage!.stackObjects[0]!;
		expect(plan.slotRepresentations).toEqual(["number", "boxed", "string", "boolean"]);
		const region = native.specializations.find(
			(candidate) => candidate.kind === "stack-object-plan",
		)!;
		if (region.kind !== "stack-object-plan") throw new Error("Missing stack certificate");
		const site = region.sites.find(
			(candidate) => candidate.allocationIp === plan.allocationIp,
		)!;
		for (const slot of [1, 2]) {
			const accesses = site.accesses.filter((access) => access.slot === slot);
			expect(
				accesses.some((access) =>
					native.body.instructions[access.ip]!.opcode.startsWith("LOAD_"),
				),
			).toBe(true);
			expect(
				accesses.some((access) =>
					native.body.instructions[access.ip]!.opcode.startsWith("STORE_"),
				),
			).toBe(true);
		}
		const output = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		expect(output).toContain(`.slot_count = ${native.storage!.rootSlotCount + 2}`);
		for (const slot of [0, 3])
			expect(output).toContain(`__stack_object_${plan.allocationIp}_slot_${slot}`);
		for (const slot of [1, 2])
			expect(output).not.toContain(`__stack_object_${plan.allocationIp}_slot_${slot}`);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("persists a heap-rooted string field for a real typed entry", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function test(input, other) {
					const o={x:1.5,label:input};
					return o===input?0:o.x+o.label.length;
				}
				globalThis.test=test; globalThis.result=test("hi", "bye");`,
				"/stack-string-field.js",
			),
		);
		const native = image.native.functions[1]!;
		const entry = native.directEntries.find((candidate) =>
			candidate.parameterRepresentations.every((rep) => rep === "string"),
		)!;
		expect(entry.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"string",
		]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.directEntries[entry.id]!.storage).toEqual(
			entry.storage,
		);
		expect(
			emitCompiledFunction(restored.native.functions[1]!, 1, "", false),
		).not.toBeNull();
	});

	it("joins numeric writes losslessly and downgrades only an independently unknown field", () => {
		const image = compile(`
			const o={x:2,y:1.5,flag:true};
			if(input){o.x=1.5;o.y=input;}
			return o===input?0:[o.x,o.y,o.flag];
		`);
		const native = image.native.functions[1]!;
		const plan = native.storage!.stackObjects[0]!;
		expect(plan.slotRepresentations).toEqual(["number", "boxed", "boolean"]);
		const output = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		expect(output).toContain(`__stack_object_${plan.allocationIp}_slot_0 = (f64)`);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("refines an all-writer numeric cell join while retaining integer write transport", () => {
		const native = compile(`
			const o={x:2,flag:true};
			if(input)o.x=1.5;
			return o===input?0:o.x+1;
		`).native.functions[1]!;
		const plan = native.storage!.stackObjects[0]!;
		expect(plan.slotRepresentations).toEqual(["number", "boolean"]);
		const region = native.specializations.find(
			(candidate) => candidate.kind === "stack-object-plan",
		)!;
		if (region.kind !== "stack-object-plan") throw new Error("Missing stack certificate");
		const loads = region.sites[0]!.accesses.filter(
			(access) =>
				access.slot === 0 &&
				native.body.instructions[access.ip]!.opcode.startsWith("LOAD_"),
		);
		expect(loads.length).toBeGreaterThan(0);
		for (const access of loads) {
			const op = native.body.instructions[access.ip]!;
			if (
				op.opcode === "LOAD_PROPERTY_STATIC" ||
				op.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
			)
				expect(native.registerRepresentations[op.dst]).toBe("number");
		}
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
	});

	it.each([
		"const o={x:1.5,payload:input}; o.x=input; return o===input?-1:o.x;",
		"const o={x:1.5,payload:input}; return o.x+o.missing;",
		"const o={payload:input,label:input}; return o===input?0:o.payload;",
	])(
		"retains boxed storage when a field or materialization lacks the typed contract",
		(body) => {
			const native = compile(body).native.functions[1]!;
			expect(native.storage!.stackObjects).toEqual([]);
		},
	);

	it("keeps stable fields typed until a certified partial return materializes them", () => {
		const image = compile(
			"const o={x:-0,y:2,flag:true}; if(input){o.x=0/0;o.y=3;o.flag=false;} if(input)return o;return 0;",
		);
		const native = image.native.functions[1]!;
		const entry = native.directEntries.find(
			(candidate) => candidate.storage!.stackObjects.length > 0,
		)!;
		expect(entry.resultRepresentation).toBe("boxed");
		expect(entry.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"int32",
			"boolean",
		]);
		const region = native.specializations.find(
			(candidate) => candidate.kind === "stack-object-plan",
		)!;
		if (region.kind !== "stack-object-plan")
			throw new Error("Missing return certificate");
		expect(region.license.materialization).toBe("on-demand");
		expect(region.sites[0]!.materializations.length).toBeGreaterThan(0);
		const emitted = emitCompiledFunction(native, native.functionIndex, "", false)!;
		const output = emitted.directEntries.find(
			(candidate) => candidate.id === entry.id && !candidate.leaf,
		)!.source;
		expect(output).toContain("mal_vm_materialize_stack_object_fields(vm,");
		expect(output).toMatch(
			/MalValue __stack_return_values_\d+\[3\] = \{ mal_ops_number_value\([^)]*\), mal_value_from_i32\(/,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("keeps a module-stored Number scalar inside stack fields", () => {
		const native = compile(
			"const n=+input; snapshot=n; const o={x:n,y:2,flag:true}; return o===input?-1:o.x+o.y;",
			"let snapshot;",
		).native.functions[1]!;
		expect(native.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"int32",
			"boolean",
		]);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
	});

	it.each([false, true])(
		"converts a proven scalar read after stack recipe rejection with generic=%s",
		(generic) => {
			const image = compile(
				"const o={x:2,flag:true}; if(input)o.x=1.5; return o===input?0:o.x+1;",
			);
			const original = image.native.functions[1]!;
			const loads = original.body.instructions.flatMap((op, ip) =>
				(op.opcode === "LOAD_PROPERTY_STATIC" ||
					op.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
				original.registerRepresentations[op.dst] === "number"
					? [{ op, ip }]
					: [],
			);
			expect(loads.length).toBeGreaterThan(0);
			const loadIps = new Set(loads.map(({ ip }) => ip));
			const regions = original.specializations.filter(
				(region) => region.kind !== "stack-object-plan",
			);
			const native = lowerNativeFunctionStorage({
				...original,
				specializations: regions,
				regionActions: vmRegionActions(regions),
				instructions: generic
					? original.instructions.map((plan, ip) => (loadIps.has(ip) ? undefined : plan))
					: original.instructions,
				directEntries: [],
			});
			expect(native.storage!.stackObjects).toEqual([]);
			const output = emitCompiledFunction(
				native,
				native.functionIndex,
				"",
				false,
			)!.source;
			for (const { op, ip } of loads) {
				if (!generic) {
					expect(output).toContain(
						`r${op.dst} = mal_ops_number_as_f64(mal_object_field_load(`,
					);
					continue;
				}
				const fallback = output.indexOf(`MalValue __boxed_load_${ip} =`);
				expect(fallback).toBeGreaterThan(-1);
				const check = output.indexOf(
					"if (vm->completion.kind == MAL_COMPLETION_THROW)",
					fallback,
				);
				const conversion = output.indexOf(
					`r${op.dst} = mal_ops_number_as_f64(__boxed_load_${ip});`,
					fallback,
				);
				expect(check).toBeGreaterThan(fallback);
				expect(conversion).toBeGreaterThan(check);
			}
		},
	);

	it("allocates an immediately returned certificate directly on the heap in every native entry", () => {
		const image = compile("return {numeric:input+1.5,payload:input,label:'ready'};");
		const native = image.native.functions[1]!;
		expect(native.directEntries.length).toBeGreaterThan(0);
		const allocationIp = native.body.instructions.findIndex(
			(op) => op.opcode === "CREATE_OBJECT_SHAPED",
		);
		expect(allocationIp).toBeGreaterThanOrEqual(0);
		const allocation = native.body.instructions[allocationIp]!;
		if (allocation.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error("Missing shaped allocation");
		for (const storage of [
			native.storage!,
			...native.directEntries.map((entry) => entry.storage!),
		]) {
			expect(storage.directHeapObjectIps).toEqual([allocationIp]);
			expect(storage.stackObjects).toEqual([]);
		}
		const point = native.gc.safepoints.find(
			(point) => point.instructionIp === allocationIp,
		)!;
		for (const register of allocation.valueRegisters)
			if (["boxed", "string"].includes(native.registerRepresentations[register]!))
				expect(point.incomingRootRegisters).toContain(register);
		expect(point.outgoingRootRegisters).toContain(allocation.dst);
		const emitted = emitCompiledFunction(native, native.functionIndex, "", false)!;
		expect(emitted.directEntries.length).toBeGreaterThan(0);
		for (const source of [
			emitted.source,
			...emitted.directEntries.map((entry) => entry.source),
		]) {
			expect(source).toContain("mal_vm_create_object_shaped(vm,");
			expect(source).not.toContain("mal_object_init_embedded_stack(");
			expect(source).not.toContain("mal_vm_materialize_stack_object");
		}
		expect(emitted.source).toContain(`.slot_count = ${native.storage!.rootSlotCount}`);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it.each([
		"const o={numeric:1.5,payload:input}; if(input)o.numeric=2; return o;",
		"const o={numeric:1.5,payload:input}; globalThis.consume(input); return o;",
		"try {return {numeric:1.5,payload:input};} catch(error){return error;}",
	])(
		"retains stack materialization outside the immediate unprotected window: %s",
		(body) => {
			const native = compile(body).native.functions[1]!;
			expect(native.storage!.directHeapObjectIps).toEqual([]);
			expect(
				emitCompiledFunction(native, native.functionIndex, "", false),
			).not.toBeNull();
		},
	);

	it("declines direct heap selection without complete allocation roots or in resumable mode", () => {
		const native = compile("return {numeric:1.5,payload:input};").native.functions[1]!;
		const allocationIp = native.storage!.directHeapObjectIps[0]!;
		expect(allocationIp).toBeDefined();
		expect(selectNativeDirectHeapObjects({ ...native, mode: "resumable" })).toEqual([]);
		for (const phase of ["incomingRootRegisters", "outgoingRootRegisters"] as const)
			expect(
				selectNativeDirectHeapObjects({
					...native,
					gc: {
						safepoints: native.gc.safepoints.map((point) =>
							point.instructionIp === allocationIp ? { ...point, [phase]: [] } : point,
						),
					},
				}),
			).toEqual([]);
	});

	it("rejects missing, duplicated and forged direct heap selections", () => {
		const image = compile("return {numeric:1.5,payload:input};");
		const native = image.native.functions[1]!;
		const ip = native.storage!.directHeapObjectIps[0]!;
		expect(ip).toBeDefined();
		for (const directHeapObjectIps of [[], [ip, ip], [ip + 1]])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, directHeapObjectIps },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

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
