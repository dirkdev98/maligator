import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreValueKindObservation } from "../src/compiler/core/core-ir-value-kinds.ts";
import type { CoreInstructionAttributes } from "../src/compiler/core/core-ir.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function observation(attributes: CoreInstructionAttributes = {}, omitted = false) {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	const [input] = builder.appendInstruction(entry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	const [result] = builder.appendInstruction(
		entry,
		"callKnown",
		omitted ? [receiver!] : [receiver!, input!],
		{ attributes: { operation: "Array.isArray", ...attributes } },
	);
	const instruction = builder.bodyInstructionIds(entry).at(-1)!;
	builder.setTerminator(entry, { kind: "return", value: result! });
	const fn = program.function(builder.finish(entry).function);
	return (mask: number) => coreValueKindObservation(program, fn, instruction, () => mask);
}

describe("Array.isArray kind observations", () => {
	it("folds every nonempty primitive union and retains every Object-containing union", () => {
		const observe = observation();
		for (let mask = 1; mask <= COMPILER_VALUE_KIND_TOP; mask++)
			expect(observe(mask), `kind mask ${mask}`).toBe(
				mask & COMPILER_VALUE_KIND_OBJECT ? undefined : false,
			);
		for (const mask of [0, -1, COMPILER_VALUE_KIND_TOP + 1])
			expect(observe(mask)).toBeUndefined();
	});

	it("treats an omitted argument as undefined", () => {
		expect(observation({}, true)(COMPILER_VALUE_KIND_TOP)).toBe(false);
	});

	it.each([{ construct: true }, { argumentMode: "iterable" }] as const)(
		"retains call protocol obligations for %j",
		(attributes) => {
			expect(observation(attributes)(1)).toBeUndefined();
		},
	);

	it.each([
		"flag ? +input : undefined",
		"flag ? String(input) : null",
		"flag ? Symbol(input) : false",
		"flag ? BigInt(input) : undefined",
	])(
		"removes %s observations from both backends and restored profiled plans",
		(value) => {
			for (const profile of [false, true]) {
				const out = inspectStaticValueFunction(
					`function probe(input,flag){return Array.isArray(${value});}globalThis.probe=probe;`,
					"probe",
					{ profile },
				);
				expect(
					out.core.filter(
						(op) =>
							op.opcode === "callKnown" && op.attributes.operation === "Array.isArray",
					),
				).toEqual([]);
				for (const fn of [out.native.body, out.fn])
					expect(
						fn.instructions.filter(
							(op) => op.opcode === "CALL_KNOWN" && op.operation === "Array.isArray",
						),
					).toEqual([]);
				const restored = deserializeCompilerArtifact(
					serializeCompilerArtifact(out.image),
				);
				expect(emitProgramImage(restored, { compiled: true, debugInfo: false })).toBe(
					emitProgramImage(out.image, { compiled: true, debugInfo: false }),
				);
			}
		},
	);

	it("retains unknown inputs and mutable builtin dispatch", () => {
		for (const expression of ["input", "flag ? input : +input"])
			expect(
				inspectStaticValueFunction(
					`function probe(input,flag){return Array.isArray(${expression});}globalThis.probe=probe;`,
					"probe",
				).native.body.instructions.some(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "Array.isArray",
				),
			).toBe(true);
		const mutable = inspectStaticValueFunction(
			"function probe(input,flag){return Array.isArray(flag?+input:undefined);}globalThis.probe=probe;",
			"probe",
			{ locked: false },
		);
		expect(mutable.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(
			true,
		);
	});

	it("consumes interprocedural parameter facts through a recursive call edge", () => {
		const file = "/array-kind-observations.mjs";
		const source = `function observe(value,depth){
			if(depth>0)return observe(value,depth-1);
			return Array.isArray(value);
		}globalThis.result=observe(String(globalThis.input),globalThis.depth);`;
		const facts = withProgramClosure(
			compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { eval: false, primordials: "locked" } }),
			),
			programClosureCertificate(
				{ kind: "whole-program", entry: file },
				[{ kind: "entry-module", module: file }],
				[],
			),
		);
		let folds = 0;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, file, parseModule(source)),
			{
				facts,
				coreInstrumentation: "counters",
				afterCoreOptimization(program, _context, report) {
					const operations = coreOperations(coreFunctionNamed(program, "observe")!);
					expect(
						operations.some(
							(op) =>
								op.opcode === "callKnown" && op.attributes.operation === "Array.isArray",
						),
					).toBe(false);
					folds = report.transforms.valueKindFolds;
				},
			},
		);
		expect(folds).toBeGreaterThan(0);
	});
});
