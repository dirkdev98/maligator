import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import {
	decodeVmValueOperand,
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function compile(body: string, preamble = "") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`${preamble} globalThis.compose = function compose(value, left, right, callback) { ${body} };`,
			"/scalar-composition.js",
		),
	);
}

function boxedNumericLeaf(out: ReturnType<typeof inspectStaticValueFunction>) {
	const producer = out.native.body.instructions.find(
		(op) => op.opcode === "UNARY" && op.operator === "+",
	)!;
	if (producer.opcode !== "UNARY") throw new Error("Missing numeric leaf");
	const native = lowerNativeFunctionStorage({
		...out.native,
		gc: {
			safepoints: out.native.gc.safepoints.map((point) => ({
				...point,
				rootRegisters: [...new Set([...point.rootRegisters, producer.dst])].sort(
					(a, b) => a - b,
				),
				incomingRootRegisters: [
					...new Set([...point.incomingRootRegisters, producer.dst]),
				].sort((a, b) => a - b),
				outgoingRootRegisters: [
					...new Set([...point.outgoingRootRegisters, producer.dst]),
				].sort((a, b) => a - b),
			})),
		},
		registerRepresentations: out.native.registerRepresentations.map((rep, local) =>
			local === producer.dst ? "boxed" : rep,
		),
	});
	const c = emitCompiledFunction(native, native.functionIndex, "", false)!;
	const image = {
		...out.image,
		native: {
			...out.image.native,
			functions: out.image.native.functions.map((fn) =>
				fn.functionIndex === native.functionIndex ? native : fn,
			),
		},
	};
	return { ...out, image, native, c };
}

describe("native scalar plans around opaque and exceptional windows", () => {
	it.each(["&", "|", "^", "<<", ">>"])(
		"keeps the proven int32 result of coercive %s scalar without selecting stale fusion state",
		(operator) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const number=+right;const value=left${operator}number;gate();return value+1;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === operator,
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing coercive int32 operator");
			expect(out.native.registerRepresentations[op.left]).toBe("boxed");
			expect(out.native.registerRepresentations[op.dst]).toBe("int32");
			expect(out.native.storage!.rootRegisters).toContain(op.left);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
			expect(
				out.native.specializations.some((region) => region.kind === "numeric-fusion"),
			).toBe(false);
			expect(out.c.source).toMatch(
				/MalValue __binary_result_\d+ = [^;]*mal_vm_binary_op[^;]*;\n\s+if \([^\n]+\) goto __throw_exit;\n\s+r\d+ = mal_ops_number_to_i32\(mal_ops_number_as_f64\(__binary_result_\d+\)\);/,
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each(["-", "*", "/", "%", "**"])(
		"keeps the known Number result of coercive %s in scalar storage",
		(operator) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const number=+right;const value=left${operator}number;gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === operator,
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing coercive scalar operator");
			expect(out.native.registerRepresentations[op.left]).toBe("boxed");
			expect(out.native.registerRepresentations[op.dst]).toBe("number");
			expect(out.native.storage!.rootRegisters).toContain(op.left);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
			expect(out.c.source).toMatch(
				/MalValue __binary_result_\d+ = [^;]*mal_vm_binary_op[^;]*;\n\s+if \([^\n]+\) goto __throw_exit;\n\s+r\d+ = mal_ops_number_as_f64\(__binary_result_\d+\);/,
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each(["left+3", "left*right", "left&right"])(
		"keeps %s boxed when its normal result is not proved Number",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const value=${expression};gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find((op) => op.opcode === "BINARY")!;
			if (op.opcode !== "BINARY") throw new Error("Missing unknown operator");
			expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
			expect(out.native.storage!.rootRegisters).toContain(op.dst);
		},
	);

	it("preserves profiled coercive scalar evaluation and completion checks", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,gate){const number=+right;const value=left*number;gate();return value;}globalThis.compute=compute;",
			"compute",
			{ profile: true },
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		)!;
		if (op.opcode !== "BINARY") throw new Error("Missing profiled product");
		expect(out.native.registerRepresentations[op.dst]).toBe("number");
		expect(out.native.storage!.expressionIps).toEqual([]);
		expect(out.c.source).toContain("MAL_PROFILE_SITE_EXECUTION");
		expect(out.c.source).toContain("mal_vm_binary_op");
		expect(out.c.source).toContain(`mal_ops_number_as_f64(__binary_result_`);
	});

	it("checks a selected numeric fusion's coercive fallback before converting its result", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,gate){const intermediate=left*right;const value=intermediate*3;gate();return value;}globalThis.compute=compute;",
			"compute",
		);
		const fusion = out.native.specializations.find(
			(region) => region.kind === "numeric-fusion",
		)!;
		expect(fusion).toBeDefined();
		const op = out.native.body.instructions[fusion.claimedIps.at(-1)!]!;
		if (op.opcode !== "BINARY") throw new Error("Missing fusion finish");
		expect(out.native.registerRepresentations[op.dst]).toBe("number");
		expect(out.c.source).toMatch(
			/MalValue __binary_result_\d+ = [^;]*mal_vm_binary_op[^;]*;\n\s+if \([^\n]+\) goto __throw_exit;\n\s+r\d+ = mal_ops_number_as_f64\(__binary_result_\d+\);/,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("composes an unrelated numeric tail with a real selected fusion region", () => {
		const image = compile(`
			const fused = value.a + value.b * value.scale;
			callback(fused);
			const a = +left;
			const b = +right;
			const difference = a - b;
			return difference < a;
		`);
		const fn = image.native.functions[1]!;
		const fusion = fn.specializations.find((region) => region.kind === "numeric-fusion")!;
		expect(fusion).toBeDefined();
		const storage = fn.storage!;
		expect(storage.expressionIps.length).toBeGreaterThan(0);
		expect(storage.definitionInitializedRegisters.length).toBeGreaterThan(0);
		for (const ip of [...storage.expressionIps, ...storage.elidedTdzIps])
			expect(fusion.claimedIps).not.toContain(ip);
		const borrowed = fusion.claimedIps.flatMap((ip) => [
			...vmInstructionReadRegisters(fn.body.instructions[ip]!),
			...vmInstructionWriteRegisters(fn.body.instructions[ip]!),
		]);
		for (const register of borrowed)
			expect(storage.definitionInitializedRegisters).not.toContain(register);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(fn, fn.functionIndex, "", false)).not.toBeNull();
	});

	it("omits scalar TDZ guards outside a selected property fusion in a typed entry", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function project(value, left, right, count, callback) {
					const total = value.left + value.right * value.scale;
					callback(total);
					for (let i = 0; i < count; i++) {
						const saved = left; left = right; right = saved;
					}
					return left - right;
				}
				globalThis.project = project;
				globalThis.result = project({left: 3, right: 7, scale: 2}, 3, 7, 4, (n) => n);`,
				"/scalar-tdz-composition.js",
			),
		);
		const fn = image.native.functions[1]!;
		expect(fn.specializations.some((region) => region.kind === "numeric-fusion")).toBe(
			true,
		);
		const entry = fn.directEntries.find((candidate) =>
			candidate.parameterRepresentations.slice(1, 4).every((rep) => rep === "number"),
		)!;
		expect(entry.storage!.elidedTdzIps.length).toBeGreaterThan(0);
		const claimed = fn.specializations.flatMap((region) => region.claimedIps);
		for (const ip of entry.storage!.elidedTdzIps) {
			expect(fn.body.instructions[ip]!.opcode).toBe("THROW_IF_TDZ");
			expect(claimed).not.toContain(ip);
		}
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(fn.storage);
		expect(
			restored.native.functions[1]!.directEntries.map((candidate) => candidate.storage),
		).toEqual(fn.directEntries.map((candidate) => candidate.storage));
		expect(
			emitCompiledFunction(restored.native.functions[1]!, fn.functionIndex, "", false),
		).not.toBeNull();
	});

	it("admits an unprotected numeric tail while preserving protected producers and catch transport", () => {
		const image = compile(`
			let result;
			try {
				const protectedValue = +left;
				callback(protectedValue);
				result = protectedValue;
			} catch (error) {
				result = callback(error);
			}
			const a = +left;
			const b = +result;
			const difference = a - b;
			return difference < a;
		`);
		const fn = image.native.functions[1]!;
		expect(fn.body.handlers.length).toBeGreaterThan(0);
		const handlers = vmExceptionHandlerTargets(
			fn.body.instructions.length,
			fn.body.handlers,
		);
		const storage = fn.storage!;
		expect(storage.expressionIps.length).toBeGreaterThan(0);
		expect(storage.definitionInitializedRegisters.length).toBeGreaterThan(0);
		expect(storage.rematerializedConstantIps).toEqual([]);
		for (const ip of [...storage.expressionIps, ...storage.elidedTdzIps])
			expect(handlers[ip]).toBeUndefined();
		const protectedDefinition = fn.body.instructions.findIndex(
			(op, ip) => handlers[ip] !== undefined && op.opcode === "UNARY",
		);
		expect(protectedDefinition).toBeGreaterThanOrEqual(0);
		const protectedRegister = vmInstructionWriteRegisters(
			fn.body.instructions[protectedDefinition]!,
		)[0]!;
		expect(storage.definitionInitializedRegisters).not.toContain(protectedRegister);
		expect(() =>
			validateNativeStorage({
				...fn,
				storage: {
					...storage,
					definitionInitializedRegisters: [
						...storage.definitionInitializedRegisters,
						protectedRegister,
					],
				},
			}),
		).toThrow(/invalid or stale storage plan/);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
});

describe("existing-proof scalar expression consumers", () => {
	it.each([
		"values[(a-b)*2]=payload;",
		"return values[(a-b)*2];",
		"return String.fromCharCode((a-b)*2);",
		"callback((a-b)*2);return 0;",
	])("retains a validated boxed numeric leaf at %s", (tail) => {
		const out = boxedNumericLeaf(
			inspectStaticValueFunction(
				`function probe(values,left,right,payload,callback){const a=+left,b=+right;${tail}}globalThis.probe=probe;`,
				"probe",
			),
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).not.toContain(ip);
		expect(() => validateNativeStorage(out.native)).not.toThrow();
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
	it("preserves Boolean property-key conversion at a composed store boundary", () => {
		const out = inspectStaticValueFunction(
			"function write(values,left,right,payload){const a=+left,b=+right;values[a<b]=payload;}globalThis.write=write;",
			"write",
		);
		const compareIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "<",
		);
		const storeIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "STORE_PROPERTY",
		);
		const store = out.native.body.instructions[storeIp]!;
		if (store.opcode !== "STORE_PROPERTY") throw new Error("Missing indexed store");
		expect(out.native.storage!.expressionIps).toContain(compareIp);
		expect(out.native.registerRepresentations[store.key]).toBe("boolean");
		expect(out.c.source).toContain(`mal_value_new_boolean(__indexed_key_${storeIp})`);
	});

	it("captures a computed numeric store key once for the indexed probe and fallback", () => {
		const out = inspectStaticValueFunction(
			"function write(values,left,right,payload){const a=+left,b=+right;values[(a-b)*2]=payload;}globalThis.write=write;",
			"write",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(out.native.storage!.expressionIps).toContain(productIp);
		const storeIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "STORE_PROPERTY",
		);
		const store = out.native.body.instructions[storeIp]!;
		if (store.opcode !== "STORE_PROPERTY") throw new Error("Missing indexed store");
		expect(out.native.registerRepresentations[store.key]).toBe("number");
		const key = `__indexed_key_${storeIp}`;
		expect(out.c.source).toMatch(new RegExp(`(?:double|f64) ${key} = r${store.key};`));
		expect(out.c.source).toContain(
			`mal_vm_array_try_store(__property_receiver_${storeIp}, ${key},`,
		);
		expect(out.c.source).toContain(
			`mal_vm_indexed_fast_store_index(vm, r${store.object}, ${key},`,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		"const x=(a-b)*2; values[x]=x;",
		"const x=(a-b)*2; x[x]=payload;",
		"values[(a-b)*2]=callback();",
		"const x=(a-b)*2; callback(); values[x]=payload;",
		"try { values[(a-b)*2]=payload; } catch(error) { return error; }",
	])("retains a computed store key across aliases and effects: %s", (tail) => {
		const out = inspectStaticValueFunction(
			`let snapshot;function write(values,left,right,payload,callback){const a=+left,b=+right;${tail}}globalThis.write=write;`,
			"write",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(productIp).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).not.toContain(productIp);
		expect(out.c.source).not.toContain("__indexed_key_");
		expect(() =>
			validateNativeStorage({
				...out.native,
				storage: {
					...out.native.storage!,
					expressionIps: [...out.native.storage!.expressionIps, productIp].sort(
						(a, b) => a - b,
					),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("keeps computed store expressions materialized at profiled sites", () => {
		const out = inspectStaticValueFunction(
			"function write(values,left,right,payload){const a=+left,b=+right;values[(a-b)*2]=payload;}globalThis.write=write;",
			"write",
			{ profile: true },
		);
		expect(out.native.storage!.expressionIps).toEqual([]);
		expect(out.c.source).not.toContain("__indexed_key_");
	});

	it("captures a computed numeric key once for the indexed probe and fallback", () => {
		const out = inspectStaticValueFunction(
			"function lookup(values,left,right){const a=+left,b=+right;return values[(a-b)*2];}globalThis.lookup=lookup;",
			"lookup",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(productIp).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).toContain(productIp);
		const loadIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "LOAD_PROPERTY",
		);
		const load = out.native.body.instructions[loadIp]!;
		if (load.opcode !== "LOAD_PROPERTY") throw new Error("Missing indexed load");
		const value = `__indexed_key_${loadIp}`;
		expect(out.c.source).toMatch(new RegExp(`(?:double|f64) ${value} = r${load.key};`));
		expect(out.c.source).toContain(
			`mal_vm_array_try_get_index(__property_receiver_${loadIp}, ${value},`,
		);
		expect(out.c.source).toContain(
			`mal_vm_indexed_fast_load_index(vm, r${load.object}, ${value},`,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		"const x=(a-b)*2; return [values[x],x];",
		"const x=(a-b)*2; return x[x];",
		"const x=(a-b)*2; callback(); return values[x];",
		"try { return values[(a-b)*2]; } catch(error) { return error; }",
	])("retains an indexed key across aliases, effects and boxed leaves: %s", (tail) => {
		const out = inspectStaticValueFunction(
			`let snapshot;function lookup(values,left,right,callback){const a=+left,b=+right;${tail}}globalThis.lookup=lookup;`,
			"lookup",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(productIp).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).not.toContain(productIp);
		expect(out.c.source).not.toContain("__indexed_key_");
	});

	it("retains computed-key profile sites and forbids delayed indexed expressions", () => {
		const out = inspectStaticValueFunction(
			"function lookup(values,left,right){const a=+left,b=+right;return values[(a-b)*2];}globalThis.lookup=lookup;",
			"lookup",
			{ profile: true },
		);
		expect(out.native.storage!.expressionIps).toEqual([]);
		const loadIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "LOAD_PROPERTY",
		);
		expect(loadIp).toBeGreaterThanOrEqual(0);
		const site = out.native.body.profileSiteIds![loadIp]!;
		expect(out.c.source).toContain(`MAL_PROFILE_CURRENT_SITE(vm, ${site});`);
		expect(out.c.source).not.toContain("__indexed_key_");
	});

	it.each([
		["String.fromCharCode((a-b)*2)", "CALL_KNOWN"],
		["parseInt('111',(a-b)*2)", "CALL_KNOWN"],
		["(1234n).toString((a-b)*2)", "CALL_KNOWN"],
		["Number.isSafeInteger((a-b)*2)", "CALL_KNOWN"],
		["[1,,undefined,NaN,-0,1,'equal',5n].indexOf((a-b)*2,left)", "QUERY_STATIC_DATA"],
		["[1,,undefined,NaN,-0,1,'equal',5n].indexOf(left,(a-b)*2)", "QUERY_STATIC_DATA"],
		["'a'.localeCompare((a-b)*2)", "PREPARED_STRING_COMPARE"],
		["Math.sumPrecise([(a-b)*2,a+1.5,b/3])", "PRECISE_NUMBER_SUM"],
	] as const)("composes arithmetic into %s", (expression, opcode) => {
		const out = inspectStaticValueFunction(
			`function probe(left,right){const a=+left;const b=+right;return ${expression};}globalThis.probe=probe;`,
			"probe",
		);
		const product = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(product).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).toContain(product);
		expect(out.native.body.instructions.some((op) => op.opcode === opcode)).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("captures a composed Number predicate argument once before its repeated tests", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right){const a=+left;const b=+right;return Number.isSafeInteger((a-b)*2);}globalThis.probe=probe;",
			"probe",
		);
		const callIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number.isSafeInteger",
		);
		const call = out.native.body.instructions[callIp]!;
		if (call.opcode !== "CALL_KNOWN") throw new Error("Missing Number predicate");
		const argument = decodeVmValueOperand(call.arguments[0]!);
		if (argument.kind !== "register") throw new Error("Missing composed argument");
		const declaration = out.c.source.match(
			new RegExp(
				`(?:double|f64) (__known_argument_${callIp}_\\d+) = r${argument.register};`,
			),
		);
		expect(declaration).not.toBeNull();
		const value = declaration![1]!;
		expect(out.c.source).toContain(
			`isfinite(${value}) && trunc(${value}) == ${value} && fabs(${value})`,
		);
	});

	it("recomputes body uses when validating a mutated native image", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right){const a=+left;const b=+right;return Number.isSafeInteger((a-b)*2);}globalThis.probe=probe;",
			"probe",
		);
		const instructions = [...out.native.body.instructions];
		const native = { ...out.native, body: { ...out.native.body, instructions } };
		validateNativeStorage(native);
		const subtraction = instructions.find(
			(op, ip) =>
				op.opcode === "BINARY" &&
				op.operator === "-" &&
				native.storage!.expressionIps.includes(ip),
		)!;
		if (subtraction.opcode !== "BINARY") throw new Error("Missing expression");
		const returnIp = instructions.findIndex((op) => op.opcode === "RETURN");
		instructions[returnIp] = { opcode: "RETURN", value: subtraction.dst };
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it("materializes a known-call argument whose transitive scalar leaf remains boxed", () => {
		const out = boxedNumericLeaf(
			inspectStaticValueFunction(
				"let snapshot;function probe(left,right){const a=+left;snapshot=a;const b=+right;return String.fromCharCode((a-b)*2);}globalThis.probe=probe;",
				"probe",
			),
		);
		const product = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(product).toBeGreaterThanOrEqual(0);
		expect(out.native.storage!.expressionIps).not.toContain(product);
		expect(() =>
			validateNativeStorage({
				...out.native,
				storage: {
					...out.native.storage!,
					expressionIps: [...out.native.storage!.expressionIps, product].sort(
						(left, right) => left - right,
					),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it.each([
		"const x=(a-b)*2; return String.fromCharCode(x,x);",
		"const x=(a-b)*2; return x.toFixed(x);",
		"const x=(a-b)*2; callback(); return String.fromCharCode(x);",
		"try { return String.fromCharCode((a-b)*2); } catch(error) { return error; }",
	])(
		"keeps known helper arguments materialized across aliases and effects: %s",
		(tail) => {
			const out = inspectStaticValueFunction(
				`function probe(left,right,callback){const a=+left;const b=+right;${tail}}globalThis.probe=probe;`,
				"probe",
			);
			const product = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === "*",
			);
			expect(product).toBeGreaterThanOrEqual(0);
			expect(out.native.storage!.expressionIps).not.toContain(product);
		},
	);

	it("preserves profiled known-helper execution sites without folding its argument", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right){const a=+left;const b=+right;return Number.isSafeInteger((a-b)*2);}globalThis.probe=probe;",
			"probe",
			{ profile: true },
		);
		expect(out.native.storage!.expressionIps).toEqual([]);
		const callIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number.isSafeInteger",
		);
		expect(callIp).toBeGreaterThanOrEqual(0);
		const site = out.native.body.profileSiteIds![callIp]!;
		expect(out.c.source).toContain(`MAL_PROFILE_CURRENT_SITE(vm, ${site});`);
		expect(out.c.source).toContain(
			`MAL_PROFILE_SITE_EVENT(vm, ${site}, MAL_PROFILE_SITE_EXECUTION, 1);`,
		);
		expect(out.c.source).not.toContain("__known_argument_");
	});

	it.each([
		["call", "callback(a-b); return 0;", "CALL"],
		[
			"shaped fields",
			"callback({difference:a-b,flag:a<b}); return 0;",
			"CREATE_OBJECT_SHAPED",
		],
		["static store", "value.result=a-b; return 0;", "STORE_PROPERTY_STATIC"],
		["dynamic store", "value[value.key]=a-1.5; return 0;", "STORE_PROPERTY"],
		["array elements", "return [a-b,,a+1.5];", "DEFINE_PROPERTY"],
	] as const)(
		"composes a single-use proven scalar into a %s value boundary",
		(_name, tail, opcode) => {
			const image = compile(`const a=+left; const b=+right; ${tail}`);
			const native = image.native.functions[1]!;
			const boundary = native.body.instructions.find((op) => op.opcode === opcode)!;
			expect(boundary).toBeDefined();
			const scalarIps = native.body.instructions.flatMap((op, ip) =>
				op.opcode === "BINARY" && op.operator === "-" ? [ip] : [],
			);
			expect(scalarIps.length).toBeGreaterThan(0);
			for (const ip of scalarIps) expect(native.storage!.expressionIps).toContain(ip);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(
				emitCompiledFunction(native, native.functionIndex, "", false),
			).not.toBeNull();
		},
	);

	it("materializes a composed boundary expression whose transitive leaf remains boxed", () => {
		const native = boxedNumericLeaf(
			inspectStaticValueFunction(
				"let snapshot;function probe(left,right,callback){const a=+left;snapshot=a;const b=+right;callback((a-b)*2);return 0;}globalThis.probe=probe;",
				"probe",
			),
		).native;
		const subtractIp = native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "-",
		);
		const productIp = native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(subtractIp).toBeGreaterThanOrEqual(0);
		expect(productIp).toBeGreaterThan(subtractIp);
		const subtract = native.body.instructions[subtractIp]!;
		if (subtract.opcode !== "BINARY") throw new Error("Missing scalar subtraction");
		expect(native.registerRepresentations[subtract.left]).toBe("boxed");
		expect(native.storage!.expressionIps).toContain(subtractIp);
		expect(native.storage!.expressionIps).not.toContain(productIp);
	});

	it("retains a boxed-input unary plus as an effectful producer with throw-before-extraction", () => {
		const image = compile("const a=+left; callback(a-1.5); return 0;");
		const native = image.native.functions[1]!;
		const ip = native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		const op = native.body.instructions[ip]!;
		if (op.opcode !== "UNARY") throw new Error("Missing unary plus");
		expect(native.registerRepresentations[op.src]).toBe("boxed");
		expect(native.registerRepresentations[op.dst]).toBe("number");
		expect(native.storage!.expressionIps).not.toContain(ip);
		const output = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		const helper = output.indexOf(`MalValue unary_number_${ip} =`);
		const check = output.indexOf(
			"if (vm->completion.kind == MAL_COMPLETION_THROW)",
			helper,
		);
		const extract = output.indexOf(
			`r${op.dst} = mal_ops_number_as_f64(unary_number_${ip});`,
			helper,
		);
		expect(helper).toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(helper);
		expect(extract).toBeGreaterThan(check);
	});

	it("preserves unary-plus site accounting while suppressing expression folding at profile sites", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				"globalThis.compose=function compose(input,callback){const number=+input; callback(number-1.5);};",
				"/profiled-scalar-plus.js",
			),
			{ profile: true },
		);
		const native = image.native.functions[1]!;
		expect(native.storage!.expressionIps).toEqual([]);
		const output = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		const ip = native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		const site = native.body.profileSiteIds![ip]!;
		expect(output).toContain(`MAL_PROFILE_CURRENT_SITE(vm, ${site});`);
		expect(output).toContain(
			`MAL_PROFILE_SITE_EVENT(vm, ${site}, MAL_PROFILE_SITE_EXECUTION, 1);`,
		);
		expect(output).toContain("mal_vm_unary_op_fast(vm, MAL_UNARY_PLUS,");
	});

	it("keeps a boundary value materialized across an intervening effect", () => {
		const native = compile(
			"const a=+left; const b=+right; const difference=a-b; callback(); value.result=difference; return 0;",
		).native.functions[1]!;
		const ip = native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "-",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(native.storage!.expressionIps).not.toContain(ip);
	});

	it("preserves selected unsigned operations in composed expressions and numeric leaves", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function bounded(left) { const a=left&65535; return (a*3+1)%101; }
				globalThis.bounded=bounded; globalThis.result=bounded(3);`,
				"/unsigned-composition.js",
			),
		);
		const native = image.native.functions[1]!;
		const unsignedIps = native.instructions.flatMap((plan, ip) =>
			plan?.kind === "unsigned-arithmetic" ? [ip] : [],
		);
		expect(unsignedIps.length).toBeGreaterThan(0);
		expect(native.storage!.expressionIps.some((ip) => unsignedIps.includes(ip))).toBe(
			true,
		);
		const entry = native.directEntries.find(
			(entry) => entry.storage!.numericWorker !== undefined,
		)!;
		expect(entry).toBeDefined();
		for (const ip of unsignedIps)
			expect(entry.storage!.numericWorker!.expressionIps).toContain(ip);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored).toEqual(image);
		const emitted = emitCompiledFunction(restored.native.functions[1]!, 1, "", false)!;
		for (const source of [
			emitted.source,
			...emitted.directEntries.map((entry) => entry.source),
		]) {
			expect(source).toContain("(u32)");
			expect(source).not.toContain("mal_number_remainder(");
		}
	});

	it("consumes int32 operands directly in bitwise expression chains", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function signed(left) { const a=left|0; return (~a>>3)^a; }
				globalThis.signed=signed; globalThis.result=signed(3);`,
				"/signed-composition.js",
			),
		);
		const native = image.native.functions[1]!;
		const emitted = emitCompiledFunction(native, 1, "", false)!;
		const entry = native.directEntries.find(
			(entry) => entry.storage!.numericWorker !== undefined,
		)!;
		expect(entry).toBeDefined();
		const source = emitted.directEntries.find(
			(candidate) => candidate.id === entry.id,
		)!.source;
		const inputs = entry.storage!.numericWorker!.expressionIps.flatMap((ip) =>
			vmInstructionReadRegisters(native.body.instructions[ip]!).filter(
				(register) => entry.registerRepresentations[register] === "int32",
			),
		);
		expect(inputs.length).toBeGreaterThan(0);
		for (const input of inputs)
			expect(source).not.toContain(`mal_ops_number_to_i32((f64) r${input})`);
	});

	it.each([
		["return ((a % b) & 255) + 1;", "%"],
		["return !((a < b) === (a !== b));", "==="],
		["return Math.round(Math.min(a * b, b % 7));", "Math.min"],
	] as const)("folds a bounded scalar chain: %s", (body, operation) => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.fold = function fold(left, right) { const a=+left; const b=+right; ${body} };`,
				"/scalar-proof-chain.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const native = image.native.functions[1]!;
		const producerIp = native.body.instructions.findIndex(
			(op) =>
				(op.opcode === "BINARY" && op.operator === operation) ||
				(op.opcode === "MATH_BINARY_NUMBER" && op.operation === operation),
		);
		expect(producerIp).toBeGreaterThanOrEqual(0);
		expect(native.storage!.expressionIps).toContain(producerIp);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(native.storage);
		const source = emitCompiledFunction(
			restored.native.functions[1]!,
			1,
			"",
			false,
		)!.source;
		if (operation === "Math.min") {
			expect(source).toContain("mal_number_round(");
			expect(source).toContain("mal_number_min_max(");
			expect(source.match(/mal_number_remainder\(/g)).toHaveLength(1);
		}
	});
});

describe("native scalar expressions across phi edge copies", () => {
	const source = `function choose(condition,left,right) {
		const a=+left,b=+right;
		return condition ? (a-b)*2 : (a+b)*3;
	} globalThis.choose=choose;`;

	it("assigns each phi input directly from its single-owner fallthrough expression", () => {
		const out = inspectStaticValueFunction(source, "choose");
		const products = out.native.body.instructions.flatMap((op, ip) =>
			op.opcode === "BINARY" && op.operator === "*" ? [{ ip, op }] : [],
		);
		expect(products).toHaveLength(2);
		for (const { ip, op } of products) {
			const edge = out.native.body.instructions[ip + 1]!;
			expect(edge.opcode).toBe("JUMP");
			if (edge.opcode !== "JUMP") throw new Error("Missing phi edge");
			expect(edge.targetIp).toBe(ip + 2);
			const copy = out.native.body.instructions[edge.targetIp]!;
			expect(copy).toMatchObject({ opcode: "MOVE", src: op.dst });
			expect(out.native.storage!.expressionIps).toContain(ip);
			expect(out.c.source).toContain(`#define r${op.dst} (`);
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["poll", "second predecessor"])(
		"rejects delayed phi arithmetic after adding a %s to its edge",
		(kind) => {
			const out = inspectStaticValueFunction(source, "choose");
			const instructions = [...out.native.body.instructions];
			const productIp = instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === "*",
			);
			const jumpIp = productIp + 1;
			const edge = instructions[jumpIp]!;
			if (edge.opcode !== "JUMP") throw new Error("Missing phi edge");
			let native = { ...out.native, body: { ...out.native.body, instructions } };
			if (kind === "poll") {
				const point = out.native.gc.safepoints[0]!;
				native = {
					...native,
					gc: {
						safepoints: [
							...native.gc.safepoints,
							{ ...point, instructionIp: jumpIp, kind: "loop-backedge" },
						],
					},
				};
			} else {
				const lastIp = instructions.length - 1;
				expect(instructions[lastIp]!.opcode).toBe("JUMP");
				instructions[lastIp] = { opcode: "JUMP", targetIp: edge.targetIp };
			}
			expect(lowerNativeFunctionStorage(native).storage!.expressionIps).not.toContain(
				productIp,
			);
			expect(() => validateNativeStorage(native)).toThrow(
				/invalid or stale storage plan/,
			);
		},
	);

	it("materializes an expression before parallel copies overwrite its transitive input", () => {
		const out = inspectStaticValueFunction(
			`function rotate(left,right,count) {
				let a=+left,b=+right; const rounds=+count;
				for(let i=0;i<rounds;i=i+1){const next=(a-b)*2;a=b;b=next;}
				return a+b;
			} globalThis.rotate=rotate;`,
			"rotate",
		);
		const instructions = out.native.body.instructions;
		const productIp = instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		const product = instructions[productIp]!;
		if (product.opcode !== "BINARY") throw new Error("Missing product");
		const difference = instructions.find(
			(op) => op.opcode === "BINARY" && op.dst === product.left,
		)!;
		if (difference.opcode !== "BINARY") throw new Error("Missing difference");
		const copyIp = instructions.findIndex(
			(op) => op.opcode === "MOVE" && op.src === product.dst,
		);
		expect(copyIp).toBeGreaterThan(productIp);
		expect(
			instructions
				.slice(productIp + 1, copyIp)
				.some(
					(op) =>
						op.opcode === "MOVE" &&
						(op.dst === difference.left || op.dst === difference.right),
				),
		).toBe(true);
		expect(out.native.storage!.expressionIps).not.toContain(productIp);
	});

	it("retains profiled phi arithmetic sites", () => {
		const out = inspectStaticValueFunction(source, "choose", { profile: true });
		expect(out.native.storage!.expressionIps).toEqual([]);
	});
});

describe("native polling numeric worker plans", () => {
	const source = `function loop(value,count){for(let index=0;index<count;index++)value=value*1.25-0.5;return value;}
		globalThis.loop=loop;globalThis.result=loop(3,7);`;

	it("uses the selected scalar schedule in one completion-aware typed loop body", () => {
		const out = inspectStaticValueFunction(source, "loop");
		const entry = out.native.directEntries.find(
			(entry) => entry.storage!.numericWorker !== undefined,
		)!;
		expect(entry).toBeDefined();
		const worker = entry.storage!.numericWorker!;
		expect(worker.pollingIps).toEqual(
			entry.gc.safepoints.flatMap((point) =>
				point.kind === "loop-backedge" ? [point.instructionIp] : [],
			),
		);
		expect(worker.pollingIps.length).toBeGreaterThan(0);
		for (const ip of worker.pollingIps)
			expect(worker.fallthroughJumpIps).not.toContain(ip);
		const emitted = out.c.directEntries.find((candidate) => candidate.id === entry.id)!;
		expect(emitted.leaf).toBeUndefined();
		expect(emitted.source).not.toContain(`${emitted.symbol}_worker(`);
		expect(emitted.source).not.toContain("mal_vm_leaf_unobserved(vm)");
		expect(worker.expressionIps.length).toBeGreaterThan(0);
		for (const ip of worker.expressionIps) {
			const instruction = out.native.body.instructions[ip]!;
			if (!("dst" in instruction)) throw new Error("Missing expression destination");
			expect(emitted.source).toContain(`#define r${instruction.dst} (`);
		}
		expect(emitted.source).toContain("mal_gc_safepoint(vm);");
		expect(emitted.source).toMatch(/if \(mal_gc_poll_termination\(vm\)\) goto/);
		expect(emitted.source).not.toContain("numeric_sort_leaf_active");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("retains every profiled site in the selected typed loop body", () => {
		const out = inspectStaticValueFunction(source, "loop", { profile: true });
		const entry = out.native.directEntries.find(
			(candidate) => (candidate.storage!.numericWorker?.pollingIps.length ?? 0) > 0,
		)!;
		expect(entry).toBeDefined();
		expect(entry.storage!.numericWorker!.expressionIps).toEqual([]);
		expect(entry.storage!.numericWorker!.rematerializedConstantIps).toEqual([]);
		const emitted = out.c.directEntries.find((candidate) => candidate.id === entry.id)!;
		for (const site of out.native.body.profileSiteIds!.filter((site) => site >= 0)) {
			const event = `MAL_PROFILE_SITE_EVENT(vm, ${site}, MAL_PROFILE_SITE_EXECUTION, 1);`;
			expect(emitted.source.split(event)).toHaveLength(2);
		}
	});

	it("preserves the boxed argument ABI when selecting a scalar loop schedule", () => {
		const out = inspectStaticValueFunction(
			`function loop(metadata,value,count){for(let index=0;index<count;index++)value=value*1.25-0.5;return value;}
			globalThis.loop=loop;globalThis.result=loop({label:'payload'},3,7);`,
			"loop",
		);
		const entry = out.native.directEntries.find(
			(candidate) => (candidate.storage!.numericWorker?.pollingIps.length ?? 0) > 0,
		)!;
		expect(entry).toBeDefined();
		for (const key of [
			"propertyProjections",
			"propertyReadRegions",
			"propertyReadPairs",
			"pairedArrayLoops",
			"arrayPresence",
			"arrayPairDestructure",
		] as const)
			expect(entry.storage![key]).toEqual([]);
		expect(entry.parameterRepresentations[0]).toBe("boxed");
		const emitted = out.c.directEntries.find((candidate) => candidate.id === entry.id)!;
		expect(emitted.source).toContain("MalValue p0");
		expect(emitted.source).toContain("r0 = p0;");
	});

	it("rejects a stored polling worker that omits its edge", () => {
		const out = inspectStaticValueFunction(source, "loop");
		const native = {
			...out.native,
			directEntries: out.native.directEntries.map((entry) => ({
				...entry,
				storage: {
					...entry.storage!,
					numericWorker: { ...entry.storage!.numericWorker!, pollingIps: [] },
				},
			})),
		};
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it("rejects a body cycle after removing its underlying polling certificate", () => {
		const out = inspectStaticValueFunction(source, "loop");
		const native = {
			...out.native,
			gc: {
				safepoints: out.native.gc.safepoints.filter(
					(point) => point.kind !== "loop-backedge",
				),
			},
			directEntries: out.native.directEntries.map((entry) => ({
				...entry,
				gc: {
					safepoints: entry.gc.safepoints.filter(
						(point) => point.kind !== "loop-backedge",
					),
				},
			})),
		};
		expect(() => lowerNativeFunctionStorage(native)).toThrow(/cycle has no polling edge/);
	});

	it("declines a flattened worker body that can fall off its physical tail", () => {
		const out = inspectStaticValueFunction(source, "loop");
		const native = {
			...out.native,
			instructions: [...out.native.instructions, undefined],
			body: {
				...out.native.body,
				instructions: [
					...out.native.body.instructions,
					{ opcode: "MOVE" as const, dst: 0, src: 0 },
				],
			},
		};
		const lowered = lowerNativeFunctionStorage(native);
		for (const entry of lowered.directEntries)
			expect(entry.storage!.numericWorker).toBeUndefined();
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});
});

describe("native Number update expressions", () => {
	it.each([
		["++", "increment", "+"],
		["--", "decrement", "-"],
	])(
		"composes proven Number prefix %s into its arithmetic consumer",
		(syntax, operator, sign) => {
			const out = inspectStaticValueFunction(
				`function update(left){let value=+left;return (${syntax}value)*2;}globalThis.update=update;`,
				"update",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "UNARY" && op.operator === operator,
			);
			const update = out.native.body.instructions[ip]!;
			if (update.opcode !== "UNARY") throw new Error("Missing Number update");
			expect(out.native.registerRepresentations[update.dst]).toBe("number");
			expect(out.native.storage!.expressionIps).toContain(ip);
			expect(out.c.source).toContain(
				`#define r${update.dst} ((f64) r${update.src} ${sign} 1.0)`,
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("preserves the old postfix value while folding the updated value", () => {
		const out = inspectStaticValueFunction(
			"function update(left){let value=+left;const old=value++;return old+value;}globalThis.update=update;",
			"update",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "increment",
		);
		const update = out.native.body.instructions[ip]!;
		if (update.opcode !== "UNARY") throw new Error("Missing postfix update");
		const sum = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "+",
		)!;
		expect(sum).toMatchObject({ left: update.src, right: update.dst });
		expect(out.native.storage!.expressionIps).toContain(ip);
		expect(out.native.storage!.expressionIps).not.toContain(ip - 1);
	});

	it("folds arithmetic across an unrelated pure Number update", () => {
		const out = inspectStaticValueFunction(
			"function update(left){let value=+left;const product=value*2;++value;return product+value;}globalThis.update=update;",
			"update",
		);
		const productIp = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(out.native.storage!.expressionIps).toContain(productIp);
	});

	it("retains generic coercing updates and int32 result storage", () => {
		const generic = inspectStaticValueFunction(
			"function update(value){return ++value;}globalThis.update=update;",
			"update",
		);
		const genericIp = generic.native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "increment",
		);
		expect(genericIp).toBeGreaterThanOrEqual(0);
		expect(generic.native.storage!.expressionIps).not.toContain(genericIp);
		const out = inspectStaticValueFunction(
			"function update(left){let value=+left;return (++value)*2;}globalThis.update=update;",
			"update",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "increment",
		);
		const update = out.native.body.instructions[ip]!;
		if (update.opcode !== "UNARY") throw new Error("Missing Number update");
		const registerRepresentations = [...out.native.registerRepresentations];
		registerRepresentations[update.dst] = "int32";
		const native = { ...out.native, registerRepresentations };
		expect(lowerNativeFunctionStorage(native).storage!.expressionIps).not.toContain(ip);
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it.each(["callback();", "callback(value);"])(
		"keeps an update before an observable call: %s",
		(call) => {
			const out = inspectStaticValueFunction(
				`function update(left,callback){let value=+left;const next=++value;${call}return next*2;}globalThis.update=update;`,
				"update",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "UNARY" && op.operator === "increment",
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
		},
	);
});

describe("native scalar definition initialization across control flow", () => {
	it.each([
		"return condition ? (a-b)*2 : (a+b)*3;",
		"return condition ? a<b : a>b;",
		"return condition ? (a|0) : (b|0);",
		"let total=a;for(let i=0;i<b;i++)total=total+a;return total;",
		"let flag=false;for(let i=0;i<b;i++)flag=!flag;return flag;",
	])("omits phi defaults when all paths write before reading: %s", (tail) => {
		const out = inspectStaticValueFunction(
			`function initialized(condition,left,right){const a=+left,b=+right;${tail}}globalThis.initialized=initialized;`,
			"initialized",
		);
		const copies = new Map<number, number>();
		for (const op of out.native.body.instructions)
			if (op.opcode === "MOVE") copies.set(op.dst, (copies.get(op.dst) ?? 0) + 1);
		const phis = [...copies].filter(([, count]) => count > 1).map(([local]) => local);
		expect(phis.length).toBeGreaterThan(0);
		for (const local of phis) {
			expect(out.native.storageValues![local]).toBeGreaterThanOrEqual(0);
			expect(out.native.storage!.definitionInitializedRegisters).toContain(local);
			expect(out.c.source).not.toMatch(new RegExp(`r${local} = (?:0\\.0|0|false);`));
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["bypass", "branch bypass", "self-copy", "synthetic"])(
		"retains a phi default after a %s invalidates initialization",
		(kind) => {
			const out = inspectStaticValueFunction(
				"function initialized(condition,left,right){const a=+left,b=+right;return condition?a-b:a+b;}globalThis.initialized=initialized;",
				"initialized",
			);
			const instructions = [...out.native.body.instructions];
			const returnIp = instructions.findIndex((op) => op.opcode === "RETURN");
			const returned = instructions[returnIp]!;
			if (returned.opcode !== "RETURN") throw new Error("Missing phi return");
			const local = returned.value;
			expect(out.native.storage!.definitionInitializedRegisters).toContain(local);
			const storageValues = [...out.native.storageValues!];
			if (kind === "bypass") instructions[0] = { opcode: "JUMP", targetIp: returnIp };
			else if (kind === "self-copy" || kind === "branch bypass") {
				const copyIp = instructions.findIndex(
					(op) => op.opcode === "MOVE" && op.dst === local,
				);
				instructions[copyIp] =
					kind === "self-copy"
						? { opcode: "MOVE", dst: local, src: local }
						: { opcode: "JUMP", targetIp: returnIp };
			} else storageValues[local] = -1;
			const native = {
				...out.native,
				storageValues,
				body: { ...out.native.body, instructions },
			};
			expect(
				lowerNativeFunctionStorage(native).storage!.definitionInitializedRegisters,
			).not.toContain(local);
			expect(() => validateNativeStorage(native)).toThrow(
				/invalid or stale storage plan/,
			);
		},
	);

	it.each([
		"return condition ? a-b : a+b;",
		"let total=0;for(let i=0;i<3;i=i+1)total=total+a;return total+b;",
	])("omits default scalar zeros when every read follows its definition: %s", (tail) => {
		const out = inspectStaticValueFunction(
			`function initialized(condition,left,right){const a=+left,b=+right;${tail}}globalThis.initialized=initialized;`,
			"initialized",
		);
		const numbers = out.native.body.instructions.filter(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		expect(numbers).toHaveLength(2);
		for (const op of numbers) {
			if (op.opcode !== "UNARY") throw new Error("Missing Number definition");
			expect(out.native.storage!.definitionInitializedRegisters).toContain(op.dst);
			expect(out.c.source).not.toContain(`r${op.dst} = 0.0;`);
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("omits a boolean default when its comparison dominates both returned uses", () => {
		const out = inspectStaticValueFunction(
			"function initialized(condition,left,right){const a=+left,b=+right;const flag=a<b;if(condition)return flag;return !flag;}globalThis.initialized=initialized;",
			"initialized",
		);
		const comparison = out.native.body.instructions.find(
			(op) => op.opcode === "BINARY" && op.operator === "<",
		)!;
		if (comparison.opcode !== "BINARY") throw new Error("Missing comparison");
		expect(out.native.storage!.definitionInitializedRegisters).toContain(comparison.dst);
		expect(out.c.source).not.toContain(`r${comparison.dst} = false;`);
	});

	it("restores default initialization when a new entry bypasses the definition", () => {
		const out = inspectStaticValueFunction(
			"function initialized(condition,left,right){const a=+left,b=+right;return condition?a-b:a+b;}globalThis.initialized=initialized;",
			"initialized",
		);
		const instructions = [...out.native.body.instructions];
		const definitionIp = instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		const definition = instructions[definitionIp]!;
		if (definition.opcode !== "UNARY") throw new Error("Missing Number definition");
		instructions[0] = { opcode: "JUMP", targetIp: definitionIp + 1 };
		const native = { ...out.native, body: { ...out.native.body, instructions } };
		expect(
			lowerNativeFunctionStorage(native).storage!.definitionInitializedRegisters,
		).not.toContain(definition.dst);
		expect(() => validateNativeStorage(native)).toThrow(/invalid or stale storage plan/);
	});

	it.each([
		"function guarded(condition,left,right,callback){const a=+left,b=+right;try{callback();return condition?a-b:a+b;}catch(error){return 0;}}",
		"function* guarded(condition,left,right){const a=+left,b=+right;yield 0;return condition?a-b:a+b;}",
	])("preserves initialization across exception and resume entries: %s", (source) => {
		const out = inspectStaticValueFunction(
			`${source}globalThis.guarded=guarded;`,
			"guarded",
		);
		if (!out.native.body.isGenerator)
			expect(out.native.body.handlers.length).toBeGreaterThan(0);
		const numbers = out.native.body.instructions.filter(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		expect(numbers).toHaveLength(2);
		for (const op of numbers) {
			if (op.opcode !== "UNARY") throw new Error("Missing Number definition");
			expect(out.native.storage!.definitionInitializedRegisters).not.toContain(op.dst);
		}
	});

	it("does not rematerialize an unreachable constant with no reads", () => {
		const out = inspectStaticValueFunction(
			"function initialized(left){return +left;}globalThis.initialized=initialized;",
			"initialized",
		);
		const register = out.native.body.registerCount;
		const ip = out.native.body.instructions.length;
		const native = lowerNativeFunctionStorage({
			...out.native,
			body: {
				...out.native.body,
				registerCount: register + 1,
				instructions: [
					...out.native.body.instructions,
					{ opcode: "CREATE_F64", dst: register, value: 17 },
				],
			},
			registerRepresentations: [...out.native.registerRepresentations, "number"],
			storageValues: [...out.native.storageValues!, 99],
			instructions: [...out.native.instructions, undefined],
		});
		expect(native.storage!.rematerializedConstantIps).not.toContain(ip);
	});
});

it("evaluates a selected numeric condition through one truthiness helper", () => {
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.test=function(left,right){const a=+left,b=+right; if(Math.round(a%b)) return 1; return 2;};`,
			"/numeric-condition.js",
		),
		{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
	);
	const native = image.native.functions[1]!;
	const round = native.body.instructions.findIndex(
		(op) => op.opcode === "MATH_UNARY_NUMBER" && op.operation === "Math.round",
	);
	expect(native.storage!.expressionIps).toContain(round);
	const source = emitCompiledFunction(native, 1, "", false)!.source;
	expect(source).toMatch(/if \(mal_number_is_truthy\(r\d+\)\)/);
	expect(source.match(/mal_number_round\(/g)).toHaveLength(1);
});

describe("known builtin scalar result storage", () => {
	it.each([
		["Number(left)", "Number", "number"],
		["parseInt(left, right)", "parseInt", "number"],
		["parseFloat(left)", "parseFloat", "number"],
		["Number.parseInt(left, right)", "parseInt", "number"],
		["'text'.charCodeAt(left)", "String.prototype.charCodeAt", "number"],
		["String(left).charCodeAt(+right)", "String.prototype.charCodeAt", "number"],
		["String(left).indexOf(right)", "String.prototype.indexOf", "number"],
		["String(left).lastIndexOf(right)", "String.prototype.lastIndexOf", "number"],
		["isNaN(left)", "isNaN", "boolean"],
		["isFinite(left)", "isFinite", "boolean"],
		["Number.isFinite(left)", "Number.isFinite", "boolean"],
		["Number.isInteger(left)", "Number.isInteger", "boolean"],
		["Number.isSafeInteger(left)", "Number.isSafeInteger", "boolean"],
		["String(left).includes(right)", "String.prototype.includes", "boolean"],
		["String(left).startsWith(right)", "String.prototype.startsWith", "boolean"],
		["String(left).endsWith(right)", "String.prototype.endsWith", "boolean"],
		["String(left).isWellFormed()", "String.prototype.isWellFormed", "boolean"],
	] as const)(
		"keeps %s native across its scalar consumer",
		(call, operation, representation) => {
			const out = inspectStaticValueFunction(
				`function probe(left,right){const value=${call}; return ${representation === "number" ? "value+1.5" : "!value"};}globalThis.probe=probe;`,
				"probe",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "CALL_KNOWN") throw new Error("Missing known builtin call");
			expect(out.native.registerRepresentations[op.dst]).toBe(representation);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("checks coercive charCodeAt completion before extracting a native result", () => {
		const out = inspectStaticValueFunction(
			"function probe(left){return 'text'.charCodeAt(left)+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) =>
				op.opcode === "CALL_KNOWN" && op.operation === "String.prototype.charCodeAt",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CALL_KNOWN") throw new Error("Missing charCodeAt call");
		expect(out.native.registerRepresentations[op.dst]).toBe("number");
		const start = out.c.source.indexOf(`MalValue char_code_result_${ip} =`);
		const check = out.c.source.indexOf(
			"if (vm->completion.kind == MAL_COMPLETION_THROW)",
			start,
		);
		const extract = out.c.source.indexOf(
			`r${op.dst} = mal_ops_number_as_f64(char_code_result_${ip});`,
			start,
		);
		expect(start).toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(start);
		expect(extract).toBeGreaterThan(check);
	});

	it.each([
		"new Number(left)",
		"new Boolean(left)",
		"BigInt(left)",
		"Symbol(left)",
		"String(left).codePointAt(right)",
	])("retains boxed storage for the unadmitted result of %s", (call) => {
		const out = inspectStaticValueFunction(
			`function probe(left,right){return ${call};}globalThis.probe=probe;`,
			"probe",
		);
		const ops = out.native.body.instructions.filter((op) => op.opcode === "CALL_KNOWN");
		expect(ops.length).toBeGreaterThan(0);
		const op = ops.at(-1)!;
		if (op.opcode !== "CALL_KNOWN") throw new Error("Missing builtin call");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
	});

	it("retains dynamic identity when mutable primordials lack a known call proof", () => {
		const out = inspectStaticValueFunction(
			"function probe(left){return Number(left)+1.5;}globalThis.probe=probe;",
			"probe",
			{ locked: false },
		);
		expect(
			out.native.body.instructions.some(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number",
			),
		).toBe(false);
		expect(out.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});
});

describe("certified scalar operation results", () => {
	it("keeps canonical argument count native without specializing its value", () => {
		const out = inspectStaticValueFunction(
			"function probe(value=7,collect){const count=arguments.length;collect();return count+1.5+arguments[0];}globalThis.probe=probe;",
			"probe",
		);
		const count = out.native.body.instructions.find(
			(op) => op.opcode === "LOAD_ARGUMENT_COUNT",
		)!;
		if (count.opcode !== "LOAD_ARGUMENT_COUNT") throw new Error("Missing count snapshot");
		expect(out.native.registerRepresentations[count.dst]).toBe("number");
		expect(out.c.source).toContain(`r${count.dst} = arg_count;`);
		expect(out.native.storage!.rootRegisters).not.toContain(count.dst);
		const argument = out.native.body.instructions.find(
			(op) => op.opcode === "LOAD_ARGUMENT",
		)!;
		if (argument.opcode !== "LOAD_ARGUMENT")
			throw new Error("Missing raw argument snapshot");
		expect(out.native.registerRepresentations[argument.dst]).toBe("boxed");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("carries rest-length clamp inputs and results as native Numbers", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right,...rest){return rest.length+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const clamp = out.native.body.instructions.find(
			(op) => op.opcode === "MATH_BINARY_NUMBER",
		)!;
		if (clamp.opcode !== "MATH_BINARY_NUMBER")
			throw new Error("Missing rest-length clamp");
		expect(clamp.operation).toBe("Math.max");
		expect(out.native.registerRepresentations[clamp.dst]).toBe("number");
		expect(out.native.registerRepresentations[clamp.left]).toBe("number");
		expect(out.native.registerRepresentations[clamp.right]).toBe("int32");
		expect(out.c.source).not.toContain("mal_ops_number_as_f64(");
	});

	it("carries coerced precise-sum inputs in native scalar storage", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right){return Math.sumPrecise([+left,+right,+left])+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const sum = out.native.body.instructions.find(
			(op) => op.opcode === "PRECISE_NUMBER_SUM",
		)!;
		if (sum.opcode !== "PRECISE_NUMBER_SUM") throw new Error("Missing precise sum");
		expect(sum.arguments).toHaveLength(3);
		for (const operand of sum.arguments)
			expect(out.native.registerRepresentations[operand]).toBe("number");
		expect(out.native.registerRepresentations[sum.dst]).toBe("number");
	});

	it("keeps a certified length native through its lexical check and collecting call", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,collect){const length=String(left).length;collect();return length+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "LOAD_PROPERTY_STATIC",
		)!;
		if (op.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing length read");
		expect(out.native.registerRepresentations[op.dst]).toBe("number");
		expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
	});

	it("preserves lexical checks for a length binding read before initialization", () => {
		const out = inspectStaticValueFunction(
			"function probe(left){if(left)return length+1.5;const length=String(left).length;return length+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const checks = out.native.body.instructions.filter(
			(op) => op.opcode === "THROW_IF_TDZ",
		);
		expect(checks.length).toBeGreaterThan(0);
		for (const op of checks) {
			if (op.opcode !== "THROW_IF_TDZ") throw new Error("Missing lexical check");
			expect(out.native.registerRepresentations[op.src]).toBe("boxed");
		}
	});

	it.each([
		["String(left).localeCompare(right)+1.5", "PREPARED_STRING_COMPARE", "number"],
		["Math.sumPrecise([+left,+right,+left])+1.5", "PRECISE_NUMBER_SUM", "number"],
		[
			"[1,,undefined,NaN,-0,1,'equal',5n].indexOf(left,right)+1.5",
			"QUERY_STATIC_DATA",
			"number",
		],
		[
			"[1,,undefined,NaN,-0,1,'equal',5n].lastIndexOf(left,right)+1.5",
			"QUERY_STATIC_DATA",
			"number",
		],
		[
			"![1,,undefined,NaN,-0,1,'equal',5n].includes(left,right)",
			"QUERY_STATIC_DATA",
			"boolean",
		],
		["String(left).length+1.5", "LOAD_PROPERTY_STATIC", "number"],
	] as const)("keeps the result of %s native", (expression, opcode, representation) => {
		const out = inspectStaticValueFunction(
			`function probe(left,right){return ${expression};}globalThis.probe=probe;`,
			"probe",
		);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === opcode);
		expect(ip).toBeGreaterThanOrEqual(0);
		const op = out.native.body.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Missing scalar result");
		expect(out.native.registerRepresentations[op.dst]).toBe(representation);
		expect(out.native.storage!.expressionIps).not.toContain(ip);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("checks static-query coercion completion before extracting its result", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,right){return [1,,undefined,NaN,-0,1,'equal',5n].indexOf(left,right)+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "QUERY_STATIC_DATA",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "QUERY_STATIC_DATA") throw new Error("Missing static query");
		const start = out.c.source.indexOf(`MalValue static_query_result_${ip} =`);
		const check = out.c.source.indexOf(
			"if (vm->completion.kind == MAL_COMPLETION_THROW)",
			start,
		);
		const extract = out.c.source.indexOf(
			`r${op.dst} = mal_ops_number_as_f64(static_query_result_${ip});`,
			start,
		);
		expect(start).toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(start);
		expect(extract).toBeGreaterThan(check);
	});

	it("retains boxed storage for a length read without a primitive brand certificate", () => {
		const out = inspectStaticValueFunction(
			"function probe(left){return left.length+1.5;}globalThis.probe=probe;",
			"probe",
		);
		const op = out.native.body.instructions.find(
			(op) => op.opcode === "LOAD_PROPERTY_STATIC",
		)!;
		if (op.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing length read");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
	});
});
