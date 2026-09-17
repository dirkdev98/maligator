import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
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
	it("hoists exact Array.from lengths without certifying unknown element kinds", () => {
		const facts = compilerProgramFactsFromConfig(
			resolveBuildConfig({
				engine: { primordials: "locked", realms: false },
			}),
		);
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`function denseArrayTraversal(scale) {
							const values = Array.from({ length: 64 }, (_, index) => ({ value: index }));
							let checksum = 0;
							for (let round = 0; round < scale; round++) {
								for (let index = 0; index < values.length; index++) checksum += values[index].value;
							}
							return checksum;
						}
						globalThis.result = denseArrayTraversal(2);`,
						"dense-array.js",
					),
					{ facts, coreVerification: "per-pass" },
				),
			),
		);
		const functionIndex = image.runtime.functions.findIndex((fn) => {
			const units = image.runtime.stringConstants[fn.nameStringIndex];
			return (
				units !== undefined && String.fromCodePoint(...units) === "denseArrayTraversal"
			);
		});
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const runtime = image.runtime.functions[functionIndex]!;
		const native = image.native.functions[functionIndex]!;
		const indexedLoop = native.specializations.find(
			(region) => region.kind === "indexed-length-loop",
		);
		expect(indexedLoop?.kind).toBe("indexed-length-loop");
		if (indexedLoop?.kind !== "indexed-length-loop") {
			throw new Error("expected indexed length loop");
		}
		expect(indexedLoop.sites[0]!.comparisonIp).toBeGreaterThan(
			indexedLoop.sites[0]!.loadIp + 1,
		);
		const elementLoads = runtime.instructions.flatMap((instruction, index) =>
			instruction.opcode === "LOAD_PROPERTY" ? [{ instruction, index }] : [],
		);
		expect(elementLoads.length).toBeGreaterThan(0);
		for (const { instruction, index } of elementLoads) {
			expect(native.instructions[index]?.kind).not.toBe("exact-contained-array-element");
			expect(native.registerRepresentations[instruction.dst]).toBe("boxed");
		}
	});

	it("certifies the holey-array checksum addition from private numeric stores", () => {
		const facts = compilerProgramFactsFromConfig(
			resolveBuildConfig({
				engine: { primordials: "locked", realms: false },
			}),
		);
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`function holeyArrayTraversal(scale) {
					const values = [];
					for (let index = 0; index < 16_384; index += 2) values[index] = index & 255;
					let checksum = 0;
					const rounds = 120 * scale;
					for (let round = 0; round < rounds; round++) {
						for (let index = 0; index < values.length; index++) {
							checksum += values[index] ?? 0;
						}
					}
					return checksum;
				}
				globalThis.result = holeyArrayTraversal(1);`,
						"holey-array.js",
					),
					{ facts, coreVerification: "per-pass" },
				),
			),
		);
		const functionIndex = image.runtime.functions.findIndex((fn) => {
			const units = image.runtime.stringConstants[fn.nameStringIndex];
			return (
				units !== undefined && String.fromCodePoint(...units) === "holeyArrayTraversal"
			);
		});
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const runtime = image.runtime.functions[functionIndex]!;
		const native = image.native.functions[functionIndex]!;
		const addition = runtime.instructions.findIndex(
			(instruction, index) =>
				instruction.opcode === "BINARY" &&
				instruction.operator === "+" &&
				native.instructions[index]?.kind === "exact-operator-input-kinds" &&
				native.instructions[index].inputKindMasks[0] === COMPILER_VALUE_KIND_NUMBER &&
				native.instructions[index].inputKindMasks[1] === COMPILER_VALUE_KIND_NUMBER,
		);
		expect(addition).toBeGreaterThanOrEqual(0);
		const normalized = runtime.instructions.findIndex(
			(instruction, index) =>
				instruction.opcode === "UNARY" &&
				instruction.operator === "+" &&
				native.instructions[index]?.kind === "exact-operator-input-kinds" &&
				native.instructions[index].inputKindMasks[0] ===
					(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED),
		);
		expect(normalized).toBeGreaterThanOrEqual(0);
		if (runtime.instructions[normalized]?.opcode !== "UNARY") {
			throw new Error("expected numeric nullish normalization");
		}
		expect(native.registerRepresentations[runtime.instructions[normalized].src]).toBe(
			"boxed",
		);
		expect(native.registerRepresentations[runtime.instructions[normalized].dst]).toBe(
			"number",
		);
		const privateLoad = runtime.instructions.findIndex(
			(instruction, index) =>
				instruction.opcode === "LOAD_PROPERTY" &&
				native.instructions[index]?.kind === "exact-contained-array-element",
		);
		expect(privateLoad).toBeGreaterThanOrEqual(0);
		if (runtime.instructions[privateLoad]?.opcode !== "LOAD_PROPERTY") {
			throw new Error("expected private array element load");
		}
		expect(native.registerRepresentations[runtime.instructions[privateLoad].dst]).toBe(
			"boxed",
		);
		const indexedLoop = native.specializations.find(
			(region) => region.kind === "indexed-length-loop",
		);
		expect(indexedLoop?.kind).toBe("indexed-length-loop");
		if (indexedLoop?.kind !== "indexed-length-loop") {
			throw new Error("expected indexed length loop");
		}
		expect(indexedLoop.sites[0]!.comparisonIp).toBeGreaterThan(
			indexedLoop.sites[0]!.loadIp + 1,
		);
		const emitted = emitCompiledFunction(runtime, native, functionIndex, "", false)!;
		expect(emitted).not.toBeNull();
		expect(emitted.source).toContain("mal_vm_private_array_try_get_proven_index");
		expect(emitted.source).toContain("mal_vm_indexed_fast_load_index");
		expect(emitted.source).not.toContain("mal_array_object_contained_dense_get");
	});

	it.each([
		[
			"unknown values",
			`function coalesce(value) { return (value ?? 0) + 1; }
			globalThis.result = coalesce(globalThis.value);`,
		],
		[
			"strings",
			`function coalesce(flag) { const value = flag ? "x" : undefined; return value ?? ""; }
			globalThis.result = coalesce(globalThis.flag);`,
		],
		[
			"bigints",
			`function coalesce(flag) { const value = flag ? 1n : undefined; return value ?? 0n; }
			globalThis.result = coalesce(globalThis.flag);`,
		],
	])("does not normalize nullish joins over %s", (_name, source) => {
		const image = compile(source);
		expect(
			image.runtime.functions.some((fn, functionIndex) =>
				fn.instructions.some((instruction, instructionIndex) => {
					const plan =
						image.native.functions[functionIndex]?.instructions[instructionIndex];
					return (
						instruction.opcode === "UNARY" &&
						instruction.operator === "+" &&
						plan?.kind === "exact-operator-input-kinds" &&
						plan.inputKindMasks[0] ===
							(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED)
					);
				}),
			),
		).toBe(false);
	});

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
