import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "../src/compiler/target/runtime-image.ts";

function compile(body: string, preamble = "") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`${preamble} globalThis.compose = function compose(value, left, right, callback) { ${body} };`,
			"/scalar-composition.js",
		),
	);
}

describe("native scalar plans around opaque and exceptional windows", () => {
	it("composes an unrelated numeric tail with a real selected fusion region", () => {
		const image = compile(`
			const fused = value.a + value.b * 2;
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
					const total = value.left + value.right * 2;
					callback(total);
					for (let i = 0; i < count; i++) {
						const saved = left; left = right; right = saved;
					}
					return left - right;
				}
				globalThis.project = project;
				globalThis.result = project({left: 3, right: 7}, 3, 7, 4, (n) => n);`,
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
		["call", "callback(a-b); return 0;", "CALL"],
		[
			"shaped fields",
			"callback({difference:a-b,flag:a<b}); return 0;",
			"CREATE_OBJECT_SHAPED",
		],
		["static store", "value.result=a-b; return 0;", "STORE_PROPERTY_STATIC"],
		["dynamic store", "value[value.key]=a-1.5; return 0;", "STORE_PROPERTY"],
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
		const native = compile(
			"const a=+left; snapshot=a; const b=+right; callback((a-b)*2); return 0;",
			"let snapshot;",
		).native.functions[1]!;
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
			(entry) => entry.storage!.numericLeaf !== undefined,
		)!;
		expect(entry).toBeDefined();
		for (const ip of unsignedIps)
			expect(entry.storage!.numericLeaf!.expressionIps).toContain(ip);
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
			(entry) => entry.storage!.numericLeaf !== undefined,
		)!;
		expect(entry).toBeDefined();
		const source = emitted.directEntries.find(
			(candidate) => candidate.id === entry.id,
		)!.source;
		const inputs = entry.storage!.numericLeaf!.expressionIps.flatMap((ip) =>
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
