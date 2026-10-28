import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_NUMBER,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { selectNativeDirectHeapObjects } from "../src/compiler/target/lower-native-objects.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { validateNativeStackObject } from "../src/compiler/target/native-stack-object.ts";
import {
	createConservativeNativePlan,
	vmRegionActions,
} from "../src/compiler/target/program-image.ts";
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
	it.each([
		["number", "1.5", "number"],
		["boolean", "true", "boolean"],
		["string", '"old"', "string"],
	] as const)(
		"uses a branch-local %s proof for writes from boxed input",
		(type, initial, representation) => {
			const image = compile(
				`const o={x:${initial},keep:2};if(typeof input==="${type}")o.x=input;return o===globalThis.other?input:o.x;`,
			);
			const native = image.native.functions[1]!;
			expect(native.registerRepresentations[0]).toBe("boxed");
			expect(native.storage!.stackObjects[0]!.slotRepresentations).toEqual([
				representation,
				"int32",
			]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it("uses initializer and writer proofs independently of boxed register storage", () => {
		const image = compile(
			"const o={x:1.5,y:2,flag:true};if(input){o.x=-0;o.y=3;o.flag=false;}return o===input?input:[o.x,o.y,o.flag];",
		);
		const original = image.native.functions[1]!;
		const boxed = createConservativeNativePlan(
			image.native.functions.map((fn) => fn.body),
			image.runtime.stringConstants,
		).functions[1]!;
		const native = lowerNativeFunctionStorage({
			...original,
			gc: boxed.gc,
			registerRepresentations: boxed.registerRepresentations,
		});
		expect(native.storage!.stackObjects[0]!.slotRepresentations).toEqual([
			"number",
			"int32",
			"boolean",
		]);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
		const widened = {
			...image,
			native: { ...image.native, functions: image.native.functions.with(1, native) },
		};
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(widened))).toEqual(
			widened,
		);
	});

	it("withdraws scalar field storage when a boxed writer loses its Number bound", () => {
		const image = compile(
			'const o={x:1.5,keep:2};if(typeof input==="number")o.x=input;return o===globalThis.other?input:o.x;',
		);
		const original = image.native.functions[1]!;
		const ip = original.body.instructions.findIndex(
			(op) =>
				(op.opcode === "STORE_PROPERTY_STATIC" ||
					op.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
				op.value === 0,
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		const native = {
			...original,
			facts: original.facts!.map((facts, index) =>
				index === ip
					? {
							...facts!,
							inputKindMasks: facts!.inputKindMasks!.map((kind) =>
								kind === COMPILER_VALUE_KIND_NUMBER
									? kind | COMPILER_VALUE_KIND_BIGINT
									: kind,
							),
						}
					: facts,
			),
		};
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: { ...image.native, functions: image.native.functions.with(1, native) },
			}),
		).toThrow(/invalid or stale storage plan/);
		expect(
			lowerNativeFunctionStorage(native).storage!.stackObjects[0]!.slotRepresentations,
		).toEqual(["boxed", "int32"]);
	});

	it("validates returned objects created on exceptional control-flow", () => {
		const image = compile(
			"try { globalThis.observe(input); return {status: 0, signal: null}; } catch (error) { return {status: error.status, signal: error.signal}; }",
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		for (const fn of image.native.functions)
			expect(() => emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toThrow();
	});
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
		expect(output).toContain(
			`MalValue __gc_slots[${native.storage!.rootSlotCount + 2}];`,
		);
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

	it("keeps final fields typed until immediate heap materialization", () => {
		const image = compile(
			"const o={x:-0,y:2,flag:true}; if(input){o.x=0/0;o.y=3;o.flag=false;} if(input)return o;return 0;",
		);
		const native = image.native.functions[1]!;
		const allocation = native.body.instructions.find(
			(op) => op.opcode === "CREATE_OBJECT_SHAPED",
		)!;
		if (allocation.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error("Missing final shaped allocation");
		const entry = native.directEntries.find(
			(candidate) => candidate.storage!.directHeapObjectIps.length > 0,
		)!;
		expect(entry).toBeDefined();
		expect(entry.resultRepresentation).toBe("boxed");
		for (const representations of [
			native.registerRepresentations,
			entry.registerRepresentations,
		])
			expect(allocation.valueRegisters.map((value) => representations[value])).toEqual([
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
		expect(output).toContain("mal_vm_create_object_shaped(vm,");
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
						`r${op.dst} = mal_ops_number_as_f64(mal_object_field_load_shaped(`,
					);
					continue;
				}
				const fallback = output.indexOf(`MalValue __boxed_load_${ip} =`);
				expect(fallback).toBeGreaterThan(-1);
				const check = output.indexOf("if (MAL_THREW())", fallback);
				const conversion = output.indexOf(
					`r${op.dst} = mal_ops_number_as_f64(__boxed_load_${ip});`,
					fallback,
				);
				expect(check).toBeGreaterThan(fallback);
				expect(conversion).toBeGreaterThan(check);
			}
		},
	);

	it.each([
		"return {numeric:input+1.5,payload:input,label:'ready'};",
		"const o={numeric:1.5,payload:input}; if(input)o.numeric=2; return o;",
	])(
		"allocates final return fields directly on the heap in every native entry: %s",
		(body) => {
			const image = compile(body);
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
			expect(native.storage!.stackRoots).toBe("conservative");
			expect(emitted.source).not.toContain("MalFrameDescriptor __gc_desc");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it.each([
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

describe("observing virtual objects", () => {
	it.each([
		`try{globalThis.before(input);}catch(error){globalThis.caught(error);}`,
		`if(input<0){try{globalThis.before(input);}catch(error){globalThis.caught(error);}return 0;}`,
	])("retains a helper result after disjoint exception control flow: %s", (prefix) => {
		const image = compile(`
			function make(value){return {x:value,y:2,label:"span"};}
			${prefix}
			const object=make(1.5);
			if(input)globalThis.observe(object,object);
			object.y=3;return object.x+object.y;
		`);
		const native = image.native.functions[1]!;
		const sites = native.specializations.flatMap((region) =>
			region.kind === "stack-object-plan" ? region.sites : [],
		);
		expect(native.body.handlers.length).toBeGreaterThan(0);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.materializations.some((entry) => entry.kind === "observe")).toBe(
			true,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
	});

	it("rejects forged exception transport of an observed allocation", () => {
		const image = compile(`
			try{globalThis.before(input);}catch(error){globalThis.caught(error);}
			const object={x:1.5,y:2};
			if(input)globalThis.observe(object);
			object.y=3;return object.x+object.y;
		`);
		const native = image.native.functions[1]!;
		const site = native.specializations.flatMap((region) =>
			region.kind === "stack-object-plan" ? region.sites : [],
		)[0]!;
		expect(site).toBeDefined();
		const observation = site.materializations.find((entry) => entry.kind === "observe")!;
		const handler = native.body.handlers[0]!;
		for (const handlers of [
			[{ ...handler, endIp: observation.ip + 1 }],
			[{ ...handler, startIp: observation.ip, endIp: observation.ip + 1 }],
			[{ ...handler, startIp: site.allocationIp, endIp: site.allocationIp + 1 }],
			[{ ...handler, handlerIp: observation.ip }],
		]) {
			expect(() =>
				validateNativeStackObject(native.body.instructions, site, handlers),
			).toThrow(/Invalid stack-object observation region/);
		}
	});

	it.each([
		`const object=make(1.5);if(input)globalThis.observe(object);const result=object.x+object.y;
		try{globalThis.after(input);}catch(error){globalThis.caught(error);}return result;`,
		`const object=make(1.5);try{if(input)globalThis.observe(object);}
		catch(error){globalThis.caught(error);}return object.x+object.y;`,
		`try{const object=make(1.5);if(input)globalThis.observe(object);return object.x+object.y;}
		catch(error){return 0;}`,
		`let prior=input;for(let i=0;i<3;i++){
		try{globalThis.before(i);}catch(error){globalThis.caught(error);}
		const object=make(i);if(i)globalThis.observe(prior);prior=object;
		}return prior.x;`,
	])(
		"declines observed lifetimes reaching handlers or recycled allocations: %s",
		(body) => {
			const image = compile(
				`function make(value){return {x:value,y:2,label:"span"};}${body}`,
			);
			expect(
				image.native.functions[1]!.specializations.some(
					(region) =>
						region.kind === "stack-object-plan" &&
						region.sites.some((site) =>
							site.materializations.some((entry) => entry.kind === "observe"),
						),
				),
			).toBe(false);
			expect(() => serializeCompilerArtifact(image)).not.toThrow();
		},
	);

	it("carries a helper's one allocation through mixed loop aliases and observations", () => {
		const image = compile(`
			function make(value){return {x:value,y:2,label:"span"};}
			try{globalThis.before(input);}catch(error){globalThis.caught(error);}
			const original=make(1.5);let object=input;let prior=input;let sum=0;
			for(let i=0;i<12;i++){
				if(i%3===0)object=original;
				if(i%3===1)object=input;
				if(i%4===0)globalThis.observe(object,prior);
				object.y=object.y+1;sum+=object.x+prior.y;prior=object;
			}
			return sum+original.y;
		`);
		const native = image.native.functions[1]!;
		const sites = native.specializations.flatMap((region) =>
			region.kind === "stack-object-plan" ? region.sites : [],
		);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.materializations.some((entry) => entry.kind === "observe")).toBe(
			true,
		);
		expect(native.storage!.stackObjects).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
	});

	it.each([
		`let object=input;let sum=0;for(let i=0;i<12;i++){
			if(i%3===0)object={x:i,y:2};if(i%4===0)globalThis.observe(object);
			sum+=object.x+object.y;
		}return sum;`,
		`let prior=input;for(let i=0;i<3;i++){
			const object={x:i,y:2};if(i)globalThis.observe(prior);prior=object;
		}return prior.x;`,
		`const original={x:1,y:2};let object=input;let sum=0;for(let i=0;i<3;i++){
			try{if(i%2)object=original;globalThis.observe(object);sum+=object.x;}
			catch(error){object=input;sum+=object.y;}
		}return sum;`,
	])(
		"declines recycled generations or handled observations on mixed backedges",
		(body) => {
			const image = compile(body);
			expect(
				image.native.functions[1]!.specializations.some(
					(region) => region.kind === "stack-object-plan",
				),
			).toBe(false);
			expect(() => serializeCompilerArtifact(image)).not.toThrow();
		},
	);

	it("retains mixed helper results inside a loop without carrying virtual values across its backedge", () => {
		const image = compile(
			`let sum=0;for(let i=0;i<12;i++){const o=i%2?{x:i,y:2}:input;if(i%3===0)globalThis.observe(o);sum+=o.x+o.y;}return sum;`,
		);
		const native = image.native.functions[1]!;
		expect(
			native.specializations.some(
				(region) =>
					region.kind === "stack-object-plan" &&
					region.sites.some((site) =>
						site.materializations.some((entry) => entry.kind === "observe"),
					),
			),
		).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it("retains the allocation identity at a mixed helper fallback join", () => {
		const image = compile(
			`const o=input?{x:1.5,y:2}:globalThis.fallback; if(input)globalThis.observe(o); return o.x+o.y;`,
		);
		const native = image.native.functions[1]!;
		expect(
			native.specializations.some(
				(region) =>
					region.kind === "stack-object-plan" &&
					region.sites.some((site) =>
						site.materializations.some((entry) => entry.kind === "observe"),
					),
			),
		).toBe(true);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("retains field storage across a conditional observer and return", () => {
		const image = compile(
			`const o={x:1.5,y:2,flag:true}; if(input)globalThis.observe(o,o); o.y=3; if(input)return o; return o.x+o.y;`,
		);
		const native = image.native.functions[1]!;
		const regions = native.specializations.filter(
			(region) => region.kind === "stack-object-plan",
		);
		const site = regions
			.flatMap((region) => region.sites)
			.find((site) => site.materializations.some((entry) => entry.kind === "observe"));
		expect(site).toBeDefined();
		expect(site!.materializations.map((entry) => entry.kind).sort()).toEqual([
			"observe",
			"return",
		]);
		expect(native.storage!.stackObjects).toHaveLength(1);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it("rejects an artifact that omits an observing call", () => {
		const image = compile(
			`const o={x:1.5,y:2}; if(input)globalThis.observe(o); return o.x+o.y;`,
		);
		const native = image.native.functions[1]!;
		const specializations = native.specializations.map((region) => {
			if (region.kind !== "stack-object-plan") return region;
			const omitted = region.sites
				.flatMap((site) => site.materializations)
				.find((entry) => entry.kind === "observe")!;
			expect(omitted).toBeDefined();
			return {
				...region,
				sites: region.sites.map((site) => ({
					...site,
					materializations: site.materializations.filter((entry) => entry !== omitted),
				})),
				claimedIps: region.claimedIps.filter((ip) => ip !== omitted.ip),
				cost: { ...region.cost, metadataOperations: region.cost.metadataOperations - 1 },
				license: { ...region.license, materialization: "none" as const },
			};
		});
		const forged = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.with(1, {
					...native,
					specializations,
					regionActions: vmRegionActions(specializations),
				}),
			},
		};
		expect(() => serializeCompilerArtifact(forged)).toThrow(/stack-object/);
	});
});
