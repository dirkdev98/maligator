import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerOperatorInputKindsHaveExactNativeSemantics,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(source: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "primitive-numeric.js"),
	);
}

describe("certified primitive numeric lowering", () => {
	it.each([
		"+",
		"-",
		"*",
		"/",
		"%",
		"**",
		"&",
		"|",
		"^",
		"<<",
		">>",
		">>>",
		"<",
		"<=",
		">",
		">=",
	])(
		"lowers %s over the complete primitive numeric union without generic dispatch",
		(operator) => {
			const image = deserializeCompilerArtifact(
				serializeCompilerArtifact(
					compile(`
				function primitive(a, b, c) {
					const x = a ? 1.5 : b ? undefined : c ? null : true;
					return x ${operator} x;
				}
				globalThis.result = primitive(globalThis.a, globalThis.b, globalThis.c);
			`),
				),
			);
			const index = image.native.functions.findIndex((fn) =>
				fn.instructions.some(
					(plan) =>
						plan?.kind === "exact-operator-input-kinds" &&
						plan.inputKindMasks[0] === COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
				),
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const native = image.native.functions[index]!;
			expect(native.instructions).toContainEqual({
				kind: "exact-operator-input-kinds",
				inputKindMasks: [
					COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
					COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
				],
			});
			const emitted = emitCompiledFunction(
				image.runtime.functions[index]!,
				native,
				index,
				"",
				false,
			)!;
			expect(emitted).not.toBeNull();
			const operatorIp = native.instructions.findIndex(
				(plan) =>
					plan?.kind === "exact-operator-input-kinds" &&
					plan.inputKindMasks[0] === COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
			);
			expect(
				native.gc.safepoints.some(
					(point) => point.kind === "operation" && point.instructionIp === operatorIp,
				),
			).toBe(false);
			expect(emitted.source).not.toContain("mal_vm_binary_op");
		},
	);

	it.each(["-x", "+x", "~x", "++x", "--x"])(
		"lowers %s over a boxed union",
		(expression) => {
			const image = deserializeCompilerArtifact(
				serializeCompilerArtifact(
					compile(`
			function primitive(flag) { let x = flag ? 1.5 : undefined; return ${expression}; }
			globalThis.result = primitive(globalThis.flag);
		`),
				),
			);
			const index = image.native.functions.findIndex((fn) =>
				fn.instructions.some(
					(op) =>
						op?.kind === "exact-operator-input-kinds" && op.inputKindMasks.length === 1,
				),
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const emitted = emitCompiledFunction(
				image.runtime.functions[index]!,
				image.native.functions[index]!,
				index,
				"",
				false,
			)!;
			expect(emitted).not.toBeNull();
			expect(emitted.source).not.toContain("mal_vm_unary_op");
		},
	);

	it("transports call-specific numeric unions into native entries and rejects forged masks", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compile(`
			function contextual(n, flag) { const x = flag ? n : undefined; return -x * 2; }
			globalThis.result = contextual(1.5, globalThis.flag);
		`),
			),
		);
		const index = image.native.functions.findIndex((fn) => fn.directEntries.length > 0);
		expect(index).toBeGreaterThanOrEqual(0);
		const native = image.native.functions[index]!;
		const entry = native.directEntries[0]!;
		expect(
			entry.operatorInputs?.some(
				({ masks }) =>
					masks[0] === (COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED),
			),
		).toBe(true);
		const emitted = emitCompiledFunction(
			image.runtime.functions[index]!,
			native,
			index,
			"",
			false,
		)!;
		expect(emitted.directEntries).toHaveLength(1);
		expect(emitted.directEntries[0]!.source).not.toMatch(/mal_vm_(unary|binary)_op/);
		const badEntry = {
			...entry,
			operatorInputs: entry.operatorInputs!.map((input) => ({
				...input,
				masks: [255] as const,
			})),
		};
		expect(() =>
			emitCompiledFunction(
				image.runtime.functions[index]!,
				{ ...native, directEntries: [badEntry] },
				index,
				"",
				false,
			),
		).toThrow(/operator input/);
	});

	it("does not certify equality by numeric conversion or admit user coercion", () => {
		expect(
			compilerOperatorInputKindsHaveExactNativeSemantics("binary", "===", [15, 15]),
		).toBe(false);
		expect(
			compilerOperatorInputKindsHaveExactNativeSemantics("binary", "==", [15, 15]),
		).toBe(false);
		for (const mask of [0, 16, 32, 64, 128, 255, NaN, 1.5]) {
			expect(
				compilerOperatorInputKindsHaveExactNativeSemantics("unary", "-", [mask]),
			).toBe(false);
			expect(
				compilerOperatorInputKindsHaveExactNativeSemantics("binary", "+", [mask, 8]),
			).toBe(false);
		}
	});
});
