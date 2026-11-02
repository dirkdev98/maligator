import { describe, expect, it } from "vitest";
import type { FfiDirectEntry } from "../src/build-config-values.ts";
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
					direct: { mix: { ...binding, callsUserCode, result } },
				},
			],
		},
		entrySource: `import {mix} from "maligator:ffi/math"; function compute(value) { ${source} } globalThis.compute=compute;`,
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
describe("static foreign call effects", () => {
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
