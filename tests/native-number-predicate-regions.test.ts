import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeNumericBuiltinInstruction } from "../src/compiler/target/lower-native-fast-paths.ts";
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import {
	decodeVmValueOperand,
	encodeVmValueOperand,
} from "../src/compiler/target/runtime-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

const predicates = ["isNaN", "isFinite", "isInteger", "isSafeInteger"] as const;
function compile(body: string, primordials: "mutable" | "locked" = "locked") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(record,left,output,count,input){${body}}`,
			"/number-predicate-regions.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
function typed(expression: string) {
	return `for(let i=0;i<count;i++){const value=left[i];output[i]=${expression}?value+1:value-1;}return output;`;
}

describe("Number predicate results in retained numeric regions", () => {
	it.each(predicates)(
		"carries %s Boolean branches through records and typed storage",
		(method) => {
			for (const body of [
				`record.y=Number.${method}(record.x)?record.y+1:record.y-1;return record.x+record.y;`,
				typed(`Number.${method}(value)`),
			]) {
				const image = compile(body),
					fn = image.native.functions[1]!;
				expect(
					fn.storage!.numberRecordRegions.length + fn.storage!.numericLoopRegions.length,
				).toBe(1);
				if (method !== "isNaN")
					expect(
						fn.body.instructions.some(
							(op) => op.opcode === "CALL_KNOWN" && op.operation === `Number.${method}`,
						),
					).toBe(true);
				expect(
					serializeCompilerArtifact(
						deserializeCompilerArtifact(serializeCompilerArtifact(image)),
					),
				).toEqual(serializeCompilerArtifact(image));
				expect(emitCompiledFunction(fn, 1, "", false)).not.toBeNull();
			}
		},
	);
	it.each(["", "undefined", "null", "true", "'1'"])(
		"preserves false for non-number input %s",
		(input) => {
			for (const method of predicates) {
				const image = compile(typed(`Number.${method}(${input})`));
				expect(image.native.functions[1]!.storage!.numericLoopRegions[0]?.kind).toBe(
					"fixed-numeric",
				);
				expect(
					emitCompiledFunction(image.native.functions[1]!, 1, "", false),
				).not.toBeNull();
			}
		},
	);
	it("guards a dynamic predicate argument before any storage writes", () => {
		const image = compile(typed("Number.isFinite(input)")),
			fn = image.native.functions[1]!;
		const call = fn.body.instructions.find(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number.isFinite",
		);
		if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing predicate");
		const input = decodeVmValueOperand(call.arguments[0]!);
		if (input.kind !== "register") throw new Error("Missing dynamic argument");
		expect(fn.storage!.numericLoopRegions[0]!.inputs).toContain(input.register);
	});
	it.each([
		"for(let i=0;i<count;i++)output[i]=Number.isFinite(left[i]);",
		"for(let i=0;i<count;i++)output[i]=Number.isFinite(left[i])+1;",
		typed("Number.isFinite(value,input())"),
		typed("new Number.isFinite(value)"),
		typed("Number.isFinite(...left)"),
	])("declines Boolean numeric stores and observable call boundaries: %s", (body) => {
		expect(compile(body).native.functions[1]!.storage!.numericLoopRegions).toEqual([]);
	});
	it("retains mutable lookup authority", () => {
		expect(
			compile(typed("Number.isFinite(value)"), "mutable").native.functions[1]!.storage!
				.numericLoopRegions,
		).toEqual([]);
	});
	it("independently rejects a forged Boolean value stored as Number", () => {
		const image = compile(typed("Number.isFinite(value)")),
			fn = image.native.functions[1]!;
		const call = fn.body.instructions.find(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Number.isFinite",
		);
		const store = fn.body.instructions.find((op) => op.opcode === "STORE_PROPERTY");
		if (call?.opcode !== "CALL_KNOWN" || store?.opcode !== "STORE_PROPERTY")
			throw new Error("Missing predicate store");
		Object.assign(store, { value: call.dst });
		expect(() =>
			validateNativeProgramStorage({ ...image.native }, image.runtime.stringConstants),
		).toThrow();
	});
	it("classifies non-number immediates without Math coercion", () => {
		const base: Extract<BytecodeInstruction, { opcode: "CALL_KNOWN" }> = {
			opcode: "CALL_KNOWN",
			dst: 1,
			thisValue: 0,
			argumentCount: 1,
			arguments: [],
			operation: "Number.isFinite",
		};
		for (const immediate of [
			{ kind: "undefined" },
			{ kind: "null" },
			{ kind: "boolean", value: true },
		] as const) {
			const op = { ...base, arguments: [encodeVmValueOperand(0, immediate)] };
			expect(nativeNumericBuiltinInstruction(op)).toEqual({
				operation: "Number.isFinite",
				resultKind: "boolean",
				arguments: [],
			});
		}
		expect(
			nativeNumericBuiltinInstruction({ ...base, specialized: "Number.isInteger" }),
		).toBeUndefined();
		expect(
			nativeNumericBuiltinInstruction({ ...base, operation: "parseFloat" }),
		).toBeUndefined();
	});
});
