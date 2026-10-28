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
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import type { CompilerIntegerRange } from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const predicates = ["isNaN", "isFinite", "isInteger", "isSafeInteger"] as const;

function observation(
	method: string,
	attributes: CoreInstructionAttributes = {},
	omitted = false,
) {
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
		{ attributes: { operation: `Number.${method}`, ...attributes } },
	);
	const instruction = builder.bodyInstructionIds(entry).at(-1)!;
	builder.setTerminator(entry, { kind: "return", value: result! });
	const fn = program.function(builder.finish(entry).function);
	return (mask: number, range?: CompilerIntegerRange) =>
		coreValueKindObservation(
			program,
			fn,
			instruction,
			() => mask,
			() => range,
		);
}

describe("Number predicate observations in Core", () => {
	it.each(predicates)("folds all non-Number unions for %s", (method) => {
		const observe = observation(method);
		for (let mask = 1; mask <= COMPILER_VALUE_KIND_TOP; mask++)
			expect(observe(mask), `${method}: kind ${mask}`).toBe(
				mask & COMPILER_VALUE_KIND_NUMBER ? undefined : false,
			);
		for (const mask of [0, -1, COMPILER_VALUE_KIND_TOP + 1])
			expect(observe(mask)).toBeUndefined();
		expect(observation(method, {}, true)(COMPILER_VALUE_KIND_TOP)).toBe(false);
		for (const attributes of [{ construct: true }, { argumentMode: "iterable" }])
			expect(observation(method, attributes)(1)).toBeUndefined();
	});

	it.each(predicates)(
		"uses safe integer ranges independently of joined kind masks for %s",
		(method) => {
			const observe = observation(method);
			for (const range of [
				COMPILER_INT32_RANGE,
				COMPILER_UINT32_RANGE,
				{
					minimum: -Number.MAX_SAFE_INTEGER,
					maximum: Number.MAX_SAFE_INTEGER,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				} as const,
			])
				for (const mask of [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_TOP])
					expect(observe(mask, range)).toBe(method !== "isNaN");
		},
	);

	it.each([
		["isFinite", "flag?String(input):null"],
		["isInteger", "flag?Symbol(input):false"],
		["isSafeInteger", "flag?BigInt(input):undefined"],
		["isNaN", "flag?String(input):null"],
	] as const)(
		"removes the impossible %s branch before either backend",
		(method, value) => {
			for (const profile of [false, true]) {
				const out = inspectStaticValueFunction(
					`function probe(input,flag){const value=${value};if(Number.${method}(value))return input+1;return 0;}globalThis.probe=probe;`,
					"probe",
					{ profile },
				);
				expect(
					out.core.some((op) => op.opcode === "binary" && op.attributes.operator === "+"),
				).toBe(false);
				for (const fn of [out.native.body, out.fn]) {
					expect(
						fn.instructions.some(
							(op) => op.opcode === "CALL_KNOWN" && op.operation === `Number.${method}`,
						),
					).toBe(false);
					expect(
						fn.instructions.some((op) => op.opcode === "BINARY" && op.operator === "+"),
					).toBe(false);
				}
				const restored = deserializeCompilerArtifact(
					serializeCompilerArtifact(out.image),
				);
				expect(emitProgramImage(restored, { compiled: true, debugInfo: false })).toBe(
					emitProgramImage(out.image, { compiled: true, debugInfo: false }),
				);
			}
		},
	);

	it.each(predicates)(
		"prunes %s from integer expressions and bounded loops",
		(method) => {
			for (const value of ["input|0", "input>>>0"])
				for (const profile of [false, true]) {
					const condition = method === "isNaN" ? `!Number.${method}` : `Number.${method}`;
					const out = inspectStaticValueFunction(
						`function probe(input){const value=${value};if(${condition}(value))return 1;return input+1;}globalThis.probe=probe;`,
						"probe",
						{ profile },
					);
					expect(
						out.native.body.instructions.some(
							(op) => op.opcode === "CALL_KNOWN" && op.operation === `Number.${method}`,
						),
					).toBe(false);
					expect(
						out.native.body.instructions.some(
							(op) => op.opcode === "BINARY" && op.operator === "+",
						),
					).toBe(false);
				}
			const condition = method === "isNaN" ? `!Number.${method}` : `Number.${method}`;
			const loop = inspectStaticValueFunction(
				`function probe(input){let sum=0;for(let i=0;i<100;i++){if(${condition}(i))sum+=i;else sum+=input();}return sum;}globalThis.probe=probe;`,
				"probe",
			);
			expect(loop.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(
				false,
			);
		},
	);

	it.each(predicates)("keeps unknown numeric values and mutable %s lookup", (method) => {
		const source = `function probe(input){return Number.${method}(+input);}globalThis.probe=probe;`;
		const out = inspectStaticValueFunction(source, "probe");
		expect(
			out.native.body.instructions.some((op) =>
				method === "isNaN"
					? op.opcode === "BINARY" && op.operator === "!=="
					: op.opcode === "CALL_KNOWN" && op.operation === `Number.${method}`,
			),
		).toBe(true);
		expect(
			inspectStaticValueFunction(source, "probe", {
				locked: false,
			}).native.body.instructions.some((op) => op.opcode === "CALL"),
		).toBe(true);
	});

	it.each(predicates)(
		"folds interprocedural recursive parameter facts for %s",
		(method) => {
			const file = "/number-predicate-observations.mjs";
			const source = `function observe(value,depth){if(depth>0)return observe(value,depth-1);return Number.${method}(value);}globalThis.result=observe(String(globalThis.input),globalThis.depth);`;
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
						expect(
							coreOperations(coreFunctionNamed(program, "observe")!).some(
								(op) =>
									op.opcode === "callKnown" &&
									op.attributes.operation === `Number.${method}`,
							),
						).toBe(false);
						folds = report.transforms.valueKindFolds;
					},
				},
			);
			expect(folds).toBeGreaterThan(0);
		},
	);
});
