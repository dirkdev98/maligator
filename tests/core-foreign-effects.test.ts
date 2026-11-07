import { describe, expect, it } from "vitest";
import type { FfiDirectEntry } from "../src/build-config-values.ts";
import { ffiScalarSymbol } from "../src/build-config-values.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreForeignCalls } from "../src/compiler/core/core-foreign-calls.ts";
import { cloneCoreFunction } from "../src/compiler/core/core-function-clone.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { COMPILER_VALUE_KIND_BIGINT } from "../src/compiler/shared/compiler-value-kinds.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import { instructionResultKind } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { Writer } from "../src/compiler/target/program-image-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";

const binding: FfiDirectEntry = {
	symbol: "mal_ffi_direct4_math_mix",
	arity: 1,
	callsUserCode: false,
	result: { kind: "integer", minimum: 0, maximum: 4294967295 },
};
function compile(
	callsUserCode: boolean,
	source = "return mix(value);",
	result = binding.result,
	scalar?: FfiDirectEntry["scalar"],
	imports = 'import {mix} from "maligator:ffi/math";',
) {
	let core: CoreFunctionStore | undefined;
	const image = compileEntrypoint("/ffi-effects.mjs", {
		buildConfig: {
			...resolveBuildConfig({ engine: { eval: false, realms: false } }),
			ffiModules: [
				{
					id: "maligator:ffi/math",
					exports: ["mix"],
					installer: "mal_ffi_install_math",
					direct: {
						mix: {
							...binding,
							arity: Math.max(binding.arity, scalar?.parameters.length ?? 0),
							callsUserCode,
							result,
							...(scalar === undefined ? {} : { scalar }),
						},
					},
				},
			],
		},
		entrySource: `${imports} function compute(value) { ${source} } globalThis.compute=compute;`,
		afterCoreOptimization(program) {
			core = coreFunctionNamed(program, "compute");
		},
	});
	if (core === undefined) throw new Error("Missing compute function");
	const native = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "compute",
	)!;
	return { core, image, native };
}
/**
 * `math` binds a callback setter, so `mix` can reenter JavaScript unless the program
 * imports nothing that registers a callback.
 */
function compileWithCallbacks(imports: string, source: string) {
	const scalar: NonNullable<FfiDirectEntry["scalar"]> = {
		symbol: ffiScalarSymbol(binding.symbol),
		parameters: [{ kind: "integer", bits: 32, signed: true }],
		result: { kind: "integer", bits: 32, signed: false },
	};
	let core: CoreFunctionStore | undefined;
	const image = compileEntrypoint("/ffi-callback-effects.mjs", {
		buildConfig: {
			...resolveBuildConfig({ engine: { eval: false, realms: false } }),
			ffiModules: [
				{
					id: "maligator:ffi/math",
					exports: ["mix", "subscribe"],
					installer: "mal_ffi_install_math",
					direct: {
						mix: { ...binding, callsUserCode: true },
						subscribe: { ...binding, symbol: "mal_ffi_direct4_math_subscribe" },
					},
					callbacks: {
						exports: ["subscribe"],
						withoutCallbacks: {
							mix: { ...binding, callsUserCode: false, scalar },
							subscribe: { ...binding, symbol: "mal_ffi_direct4_math_subscribe" },
						},
					},
				},
			],
		},
		entrySource: `${imports} function compute(value) { ${source} } globalThis.compute=compute;`,
		afterCoreOptimization(program) {
			core = coreFunctionNamed(program, "compute");
		},
	});
	if (core === undefined) throw new Error("Missing compute function");
	const call = [...core.instructionIds()].find(
		(instruction) =>
			core!.instructionKind(instruction) === "operation" &&
			["call", "callForeign"].includes(core!.instructionOpcodeName(instruction)),
	)!;
	return {
		callsUserCode: coreInstructionEffects(core, call).callsUserCode,
		image,
		scalar,
	};
}

describe("foreign callback reach", () => {
	it("calls without reentry when no import reaches a callback registration", () => {
		const { callsUserCode, image, scalar } = compileWithCallbacks(
			'import {mix} from "maligator:ffi/math";',
			"return mix(value | 0);",
		);
		expect(callsUserCode).toBe(false);
		const native = image.native.functions.find((fn) =>
			emitCompiledFunction(fn, fn.functionIndex, "", false)?.source.includes(
				`${scalar.symbol}(`,
			),
		);
		expect(native).toBeDefined();
	});
	it.each([
		'import {mix, subscribe} from "maligator:ffi/math";',
		'import * as math from "maligator:ffi/math"; const mix = math.mix;',
	])("keeps callback reentry when %s can register one", (imports) => {
		expect(compileWithCallbacks(imports, "return mix(value | 0);").callsUserCode).toBe(
			true,
		);
	});
});

describe("static foreign call effects", () => {
	const scalar: NonNullable<FfiDirectEntry["scalar"]> = {
		symbol: ffiScalarSymbol(binding.symbol),
		parameters: [{ kind: "integer", bits: 32, signed: true }],
		result: { kind: "integer", bits: 32, signed: false },
	};
	it.each([
		"return math.mix(value | 0);",
		'return math["mix"](value | 0);',
		"return math?.mix(value | 0);",
		"return math.mix?.(value | 0);",
		"const target=math.mix; return target(value | 0);",
	])("resolves the immutable foreign namespace target in %s", (source) => {
		const { native } = compile(
			false,
			source,
			binding.result,
			scalar,
			'import * as math from "maligator:ffi/math";',
		);
		expect(
			native.instructions.some(
				(plan) => plan?.kind === "call" && plan.foreignCall?.symbol === binding.symbol,
			),
		).toBe(true);
		expect(
			emitCompiledFunction(native, native.functionIndex, "", false)!.source,
		).toContain(`${scalar.symbol}(`);
	});
	it("keeps callback effects on a resolved namespace call", () => {
		const { core, native } = compile(
			true,
			"return math.mix(value);",
			binding.result,
			undefined,
			'import * as math from "maligator:ffi/math";',
		);
		expect(
			native.instructions.some(
				(plan) => plan?.kind === "call" && plan.foreignCall?.symbol === binding.symbol,
			),
		).toBe(true);
		const call = [...core.instructionIds()].find(
			(instruction) => core.instructionOpcodeName(instruction) === "call",
		)!;
		expect(coreInstructionEffects(core, call).callsUserCode).toBe(true);
	});
	it.each([
		["return mix(value | 0);", true],
		["return mix(7);", true],
		["return mix(value);", false],
		["return mix(value >>> 0);", false],
		["return mix(2147483648);", false],
		["return mix(1.5);", false],
		["return mix();", false],
	] as const)("selects the scalar C ABI for proven inputs in %s", (source, selected) => {
		const { image, native } = compile(false, source, binding.result, scalar);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const after = restored.native.functions[native.functionIndex]!;
		const call = after.instructions.find((plan) => plan?.kind === "call");
		expect(call).toMatchObject({ foreignCall: { scalar } });
		const emitted = emitCompiledFunction(after, after.functionIndex, "", false);
		expect(emitted).not.toBeNull();
		expect(emitted!.source.includes(`${scalar.symbol}(`)).toBe(selected);
	});
	it.each([
		[{ kind: "integer", bits: 8, signed: true } as const, "127", true],
		[{ kind: "integer", bits: 8, signed: true } as const, "value & 255", false],
		[{ kind: "integer", bits: 16, signed: false } as const, "65535", true],
		[{ kind: "integer", bits: 32, signed: false } as const, "value >>> 0", true],
		[{ kind: "boolean" } as const, "Boolean(value)", true],
		[{ kind: "boolean" } as const, "1", false],
		[{ kind: "number" } as const, "Number(value)", true],
	] as const)(
		"requires the exact scalar conversion for %j from %s",
		(parameter, argument, selected) => {
			const entry = { ...scalar, parameters: [parameter] };
			const { native } = compile(
				false,
				`return mix(${argument});`,
				binding.result,
				entry,
			);
			const emitted = emitCompiledFunction(native, native.functionIndex, "", false)!;
			expect(emitted.source.includes(`${scalar.symbol}(`)).toBe(selected);
		},
	);
	describe("lent views", () => {
		const viewScalar: NonNullable<FfiDirectEntry["scalar"]> = {
			symbol: ffiScalarSymbol(binding.symbol),
			parameters: [{ kind: "view", array: "Float64Array", writable: false }],
			result: { kind: "number" },
		};
		it("lends a typed array to the scalar C ABI and converts anything else", () => {
			// Array conversion can run getters, so the binding reenters JavaScript.
			const { image, native } = compile(
				true,
				"return mix(value);",
				{ kind: "number" },
				viewScalar,
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const after = restored.native.functions[native.functionIndex]!;
			expect(after.instructions.find((plan) => plan?.kind === "call")).toMatchObject({
				foreignCall: { scalar: viewScalar },
			});
			const source = emitCompiledFunction(after, after.functionIndex, "", false)!.source;
			expect(source).toContain("mal_typed_array_lend(");
			expect(source).toContain(`${viewScalar.symbol}(`);
			expect(source).toContain(`${binding.symbol}(`);
		});
		it("admits a loop's lent views once at the loop entry", () => {
			const { image, native } = compile(
				true,
				"let total = 0; for (let i = 0; i < 64; i++) total += mix(value); return total;",
				{ kind: "number" },
				viewScalar,
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const after = restored.native.functions[native.functionIndex]!;
			const region = after.storage!.numericLoopRegions.find(
				(plan) => plan.kind === "fixed-numeric" && plan.foreignCalls !== undefined,
			);
			expect(region).toMatchObject({
				views: [{ lend: "Float64Array", lentOnly: true, writable: false }],
			});
			const source = emitCompiledFunction(after, after.functionIndex, "", false)!.source;
			expect(source).toMatch(/bool __typed_loop_\d+_typed = mal_typed_array_lend\(/);
		});
		it.each([
			["i", true],
			["i * 0.5", false],
		] as const)(
			"calls C inside the loop region with %s as an integer argument: %s",
			(argument, admitted) => {
				const { native } = compile(
					true,
					`let total = 0; for (let i = 0; i < 64; i++) total += mix(value, ${argument}); return total;`,
					{ kind: "number" },
					{
						...viewScalar,
						parameters: [
							...viewScalar.parameters,
							{ kind: "integer", bits: 32, signed: true },
						],
					},
				);
				expect(
					native.storage!.numericLoopRegions.some(
						(plan) => plan.kind === "fixed-numeric" && plan.foreignCalls !== undefined,
					),
				).toBe(admitted);
			},
		);
		it.each([
			{
				...viewScalar,
				parameters: [
					{ kind: "view", array: "Float64Array", writable: false, sameLength: 0 },
				],
			},
			{
				...viewScalar,
				parameters: [{ kind: "view", array: "Uint8ClampedArray", writable: false }],
			},
			{ ...viewScalar, parameters: [{ kind: "view", array: "Float64Array" }] },
		])("rejects an invalid view %j", (invalid) => {
			expect(() =>
				compile(
					true,
					"return mix(value);",
					{ kind: "number" },
					invalid as typeof viewScalar,
				),
			).toThrow("scalar ABI");
		});
	});
	it("rejects a scalar ABI on a callback-capable binding", () => {
		expect(() => compile(true, "return mix(value | 0);", binding.result, scalar)).toThrow(
			"scalar ABI",
		);
	});
	it.each([
		{ ...scalar, symbol: "mal_ffi_scalar0_other" },
		{ ...scalar, parameters: [] },
		{ ...scalar, parameters: [{ kind: "undefined" }] },
		{ ...scalar, parameters: [{ kind: "integer", bits: 64, signed: true }] },
		{ ...scalar, result: { kind: "integer", bits: 0, signed: true } },
	])("rejects an invalid scalar ABI %j", (invalid) => {
		expect(() =>
			compile(false, "return mix(value);", binding.result, invalid as typeof scalar),
		).toThrow("scalar ABI");
	});
	it.each([
		[0, 2],
		[1, 2],
		[2, 0],
		[3, 64],
		[4, 2],
		[5, 4],
	])("rejects corrupt scalar ABI byte %i set to %i", (offset, value) => {
		const { image } = compile(false, "return mix(value | 0);", binding.result, scalar);
		const bytes = serializeCompilerArtifact(image);
		const writer = new Writer();
		writer.i32(binding.arity);
		const arity = writer.finish();
		const symbol = Buffer.from(bytes).indexOf(
			Buffer.concat([Buffer.from(binding.symbol), arity, Uint8Array.of(1)]),
		);
		expect(symbol).toBeGreaterThanOrEqual(0);
		bytes[symbol + binding.symbol.length + arity.length + offset] = value;
		expect(() => deserializeCompilerArtifact(bytes)).toThrow("scalar FFI");
	});
	it.each([false, true])(
		"preserves BigInt normal results through artifacts with reentry %s",
		(callsUserCode) => {
			const { image, native } = compile(callsUserCode, "return Number(mix(value));", {
				kind: "bigint",
			});
			const ip = native.body.instructions.findIndex(
				(instruction) => instruction.opcode === "CALL",
			);
			const call = native.body.instructions[ip]!;
			if (call.opcode !== "CALL") throw new Error("Missing foreign call");
			expect(instructionResultKind(native.facts?.[ip], call.dst)).toBe(
				COMPILER_VALUE_KIND_BIGINT,
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(
				instructionResultKind(
					restored.native.functions[native.functionIndex]!.facts?.[ip],
					call.dst,
				),
			).toBe(COMPILER_VALUE_KIND_BIGINT);
		},
	);
	it("keeps C memory, exception, and GC effects while excluding JavaScript reentry", () => {
		const { core, image, native } = compile(false);
		const call = [...core.instructionIds()].find(
			(id) =>
				core.instructionKind(id) === "operation" &&
				core.instructionOpcodeName(id) === "callForeign",
		)!;
		expect(coreInstructionEffects(core, call)).toEqual({
			reads: ["object-property", "array-element", "host", "io"],
			writes: ["object-property", "array-element", "host", "io"],
			mayThrow: true,
			mayGc: true,
			maySuspend: false,
			callsUserCode: false,
		});
		const ip = native.body.instructions.findIndex((op) => op.opcode === "CALL");
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(decodeInstructionEffects(native.facts![ip]!.effectMask!)).toEqual(
			coreInstructionEffects(core, call),
		);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(
			decodeInstructionEffects(
				restored.native.functions[native.functionIndex]!.facts![ip]!.effectMask!,
			),
		).toEqual(coreInstructionEffects(core, call));
	});
	it("keeps a binding opaque when conversions or C can enter JavaScript", () => {
		const { core } = compile(true);
		const call = [...core.instructionIds()].find(
			(id) =>
				core.instructionKind(id) === "operation" &&
				core.instructionOpcodeName(id) === "call",
		)!;
		expect(coreInstructionEffects(core, call).callsUserCode).toBe(true);
	});
	it("keeps scalar arguments and results across the foreign boundary", () => {
		const { native } = compile(false, "return mix(value | 0);");
		const call = native.body.instructions.find(
			(instruction) => instruction.opcode === "CALL",
		)!;
		expect(call.opcode).toBe("CALL");
		if (call.opcode !== "CALL") throw new Error("Missing foreign call");
		expect(native.registerRepresentations[call.arguments[0]!]).toBe("int32");
		expect(native.registerRepresentations[call.dst]).toBe("number");
	});
	it("keeps a loop induction value scalar when C consumes it", () => {
		const { native } = compile(
			false,
			"let total=0;for(let index=0;index<16;index++)total=(total+mix(index))>>>0;return total;",
		);
		const call = native.body.instructions.find(
			(instruction) => instruction.opcode === "CALL",
		)!;
		if (call.opcode !== "CALL") throw new Error("Missing foreign call");
		expect(native.registerRepresentations[call.arguments[0]!]).toBe("int32");
	});
	it.each([
		["return mix();", 0],
		["return mix(7);", 1],
		['return mix("invalid");', 1],
		["return mix(value, value+1);", 2],
	] as const)("preserves the boxed call ABI for %s", (source, argumentsCount) => {
		const { image, native } = compile(false, source);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const after = restored.native.functions[native.functionIndex]!;
		const ip = after.body.instructions.findIndex(
			(instruction) => instruction.opcode === "CALL",
		);
		expect(after.body.instructions[ip]).toMatchObject({ argumentCount: argumentsCount });
		expect(after.instructions[ip]).toMatchObject({
			kind: "call",
			foreignCall: { symbol: binding.symbol, arity: binding.arity },
		});
		expect(restored.runtime.hostInstalls).toEqual([
			{
				installer: "mal_ffi_install_math",
				exports: [expect.objectContaining({ name: "mix" })],
			},
		]);
	});
	it.each(["rewrite", "clone"])(
		"keeps the static target after an argument %s",
		(operation) => {
			const program = analysisProgram();
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const block = builder.createBlock([{}, {}]);
			const first = builder.blockParameterValue(block, 0);
			const second = builder.blockParameterValue(block, 1);
			const [result] = builder.appendInstruction(block, "callForeign", [first], {
				attributes: { foreignSlot: 3 },
			});
			const site = builder.bodyInstructionIds(block).at(-1)!;
			builder.setTerminator(block, { kind: "return", value: result! });
			let fn = program.function(builder.finish(block).function);
			if (operation === "rewrite") {
				const editor = CoreEditor.open(program, fn.id);
				editor.replaceOperands(site, [second]);
				editor.commit();
			} else fn = program.function(cloneCoreFunction(program, fn));
			expect([...coreForeignCalls(fn, new Map([[3, binding]])).values()]).toEqual([
				binding,
			]);
		},
	);
});
