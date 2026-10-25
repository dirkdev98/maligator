import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("native numeric switch certificate", () => {
	it("carries selector ranges and comparison effects through generated dispatch", () => {
		const out = inspectStaticValueFunction(
			"function dispatch(input){switch(input|0){case 0:return 'zero';case 1:return 'one';case 2:return 'two';case 3:return 'three';default:return 'other';}}globalThis.dispatch=dispatch;",
			"dispatch",
		);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		const native = restored.native.functions[out.native.functionIndex]!;
		const comparisons = native.body.instructions.flatMap((op, ip) =>
			op.opcode === "BINARY" && op.operator === "===" ? [{ op, ip }] : [],
		);
		expect(comparisons.length).toBeGreaterThan(0);
		expect(native.literalSwitches?.some((site) => site.kind === "number")).toBe(true);
		for (const { ip } of comparisons) {
			const facts = native.facts![ip]!;
			expect(facts).toMatchObject({
				inputKindMasks: [COMPILER_VALUE_KIND_NUMBER, expect.any(Number)],
				resultKindMasks: [COMPILER_VALUE_KIND_BOOLEAN],
				effectMask: 0,
			});
			expect(facts.inputIntegerRanges?.[0]).toEqual(COMPILER_INT32_RANGE);
			expect(facts.inputIntegerRanges?.[1]?.minimum).toBe(
				facts.inputIntegerRanges?.[1]?.maximum,
			);
			expect(facts.inputIntegerRanges?.[1]?.minimum).toBeGreaterThanOrEqual(0);
			expect(facts.inputIntegerRanges?.[1]?.maximum).toBeLessThanOrEqual(3);
		}
	});

	it("canonicalizes dispatch certificates independently of scheduled block order", () => {
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				readFileSync("tests/local/numeric-switch-dispatch.js", "utf8"),
				"scheduled-switch-contract.js",
			),
			{},
			(_phase, run) => run(),
		);
		const target = lowerCoreCompilationToNativeProgram(core);
		const image = lowerExecutionToProgramImage(
			lowerCoreCompilationToExecutionProgram(core),
			{
				...target,
				functions: target.functions.map((fn) => ({
					...fn,
					literalSwitches: fn.literalSwitches?.toReversed(),
				})),
			},
		);
		const native = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "reorderedDispatch",
		)!;
		const sites = native.literalSwitches!;
		expect(sites.length).toBeGreaterThan(1);
		expect(sites.some((site) => site.kind === "number")).toBe(true);
		expect(sites.some((site) => site.kind === "string")).toBe(true);
		for (let index = 1; index < sites.length; index++)
			expect(sites[index]!.instructionIp).toBeGreaterThan(sites[index - 1]!.endIp);
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(decoded.native.functions[native.functionIndex]!.literalSwitches).toEqual(
			sites,
		);
		expect(emitCompiledFunction(native, native.functionIndex, "", false)).not.toBeNull();
		expect(() =>
			emitCompiledFunction(
				{ ...native, literalSwitches: [...sites].reverse() },
				native.functionIndex,
				"",
				false,
			),
		).toThrow(/switch certificate/);
	});

	it("survives artifact encoding and validates the original strict dispatch edges", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				readFileSync("tests/local/numeric-switch-dispatch.js", "utf8"),
				"switch-contract.js",
			),
		);
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const native = decoded.native.functions.find(
			(fn) => (fn.literalSwitches?.length ?? 0) > 0,
		)!;
		expect(native.literalSwitches).toEqual(
			image.native.functions[native.functionIndex]!.literalSwitches,
		);
		expect(native.storage!.rematerializedConstantIps.length).toBeGreaterThan(0);
		const emitted = emitCompiledFunction(native, native.functionIndex, "", false)!;
		expect(emitted.source).toContain("switch ((i32)");
		const malformed = {
			...native,
			literalSwitches: native.literalSwitches!.map((site) =>
				site.kind === "string"
					? site
					: {
							...site,
							cases: site.cases.map((label, i) =>
								i === 0 ? { ...label, targetIp: site.endIp } : label,
							),
						},
			),
		};
		expect(() =>
			emitCompiledFunction(malformed, native.functionIndex, "", false),
		).toThrow(/switch certificate/);
		expect(() =>
			serializeCompilerArtifact({
				...decoded,
				native: {
					...decoded.native,
					functions: decoded.native.functions.map((row) =>
						row === native ? malformed : row,
					),
				},
			}),
		).toThrow(/switch certificate/);
	});
});
