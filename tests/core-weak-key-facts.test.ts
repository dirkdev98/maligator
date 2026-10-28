import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-ir-value-kinds.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import type { CoreOperationInspection } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function resultKinds(
	operation: string,
	key: "number" | "object" | "unknown" | "omitted" | "list" | "prefix",
) {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
	const entry = builder.createBlock([{}, {}]);
	const receiver = builder.blockParameterValue(entry, 0);
	const input =
		key === "number" || key === "prefix"
			? builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value: 1 },
				})[0]!
			: key === "object"
				? builder.appendInstruction(entry, "createObject", [])[0]!
				: builder.blockParameterValue(entry, 1);
	const [value] = builder.appendInstruction(
		entry,
		"callKnown",
		key === "omitted"
			? [receiver]
			: key === "prefix"
				? [receiver, input, builder.blockParameterValue(entry, 1)]
				: [receiver, input],
		{
			attributes: {
				operation,
				...(key === "list" || key === "prefix" ? { argumentMode: "iterable" } : {}),
			},
		},
	);
	builder.setTerminator(entry, { kind: "return", value: value! });
	const fn = program.function(builder.finish(entry).function);
	const manager = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	return {
		local: manager
			.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: fn.id })
			.latticeMask(value!),
		program: manager
			.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
			.kinds.summary(fn.id).returnKind,
	};
}

const predicates = [
	"WeakMap.prototype.has",
	"WeakMap.prototype.delete",
	"WeakSet.prototype.has",
	"WeakSet.prototype.delete",
];

describe("weak key normal completions", () => {
	it.each(["number", "omitted", "prefix"] as const)(
		"propagates %s keys through local and program return lattices",
		(key) => {
			expect(resultKinds("WeakMap.prototype.get", key)).toEqual({
				local: COMPILER_VALUE_KIND_UNDEFINED,
				program: COMPILER_VALUE_KIND_UNDEFINED,
			});
			for (const operation of predicates)
				expect(resultKinds(operation, key)).toEqual({
					local: COMPILER_VALUE_KIND_BOOLEAN,
					program: COMPILER_VALUE_KIND_BOOLEAN,
				});
			for (const operation of ["WeakMap.prototype.set", "WeakSet.prototype.add"])
				expect(resultKinds(operation, key)).toEqual({ local: 0, program: 0 });
		},
	);

	it.each(["object", "unknown", "list"] as const)(
		"retains possible normal values for %s keys",
		(key) => {
			expect(resultKinds("WeakMap.prototype.get", key)).toEqual({
				local: COMPILER_VALUE_KIND_TOP,
				program: COMPILER_VALUE_KIND_TOP,
			});
			for (const operation of ["WeakMap.prototype.set", "WeakSet.prototype.add"])
				expect(resultKinds(operation, key)).toEqual({
					local: COMPILER_VALUE_KIND_OBJECT,
					program: COMPILER_VALUE_KIND_OBJECT,
				});
		},
	);

	it.each(
		predicates.flatMap((operation) =>
			["+input", "String(input)", "false", "null", "undefined", "1n"].map(
				(key) => [operation, key] as const,
			),
		),
	)(
		"uses %s normal false from %s while retaining receiver failures",
		(operation, key) => {
			const out = inspectStaticValueFunction(
				`function compute(receiver,input){return ${operation}.call(receiver,${key})?11:17;}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
				mayThrow: true,
				mayGc: true,
			});
			expect(
				out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
			).toBe(false);
			expect(
				out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 17),
			).toBe(true);
		},
	);

	it.each(["function", "function*", "async function", "async function*"])(
		"retains call effects across a %s result replacement",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield key;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`${declaration} compute(receiver,input,visit){const key=+input;${suspend}const value=WeakMap.prototype.get.call(receiver,key,visit());return typeof value==='undefined';}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			expect(
				out.fn.instructions.some(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "WeakMap.prototype.get",
				),
			).toBe(true);
			expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
			expect(out.core.some((op) => op.opcode === "typeofCompare")).toBe(false);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(
				restored.runtime.functions[
					out.image.native.functions.indexOf(out.native)
				]!.instructions.some(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "WeakMap.prototype.get",
				),
			).toBe(true);
		},
	);

	it.each(
		[
			"WeakMap.prototype.get",
			"WeakMap.prototype.has",
			"WeakSet.prototype.delete",
		].flatMap((operation) => [false, true].map((closed) => [operation, closed] as const)),
	)(
		"requires complete caller bounds for a non-inlined %s key (closed=%s)",
		(operation, closed) => {
			const expression = `${operation}.call(receiver,key)${operation.endsWith("get") ? "===undefined?17:11" : "?11:17"}`;
			const source = `function lookup(visit,receiver,key){for(let i=0;i<3;i++)visit();return ${expression};}function compute(visit,receiver,input){return lookup(visit,receiver,+input);}globalThis.compute=compute;`;
			const sourcePath = "weak-key-caller.mjs";
			const facts = compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: { eval: false, primordials: "locked", realms: false },
				}),
			);
			let operations: ReadonlyArray<CoreOperationInspection> = [];
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
				{
					facts: closed
						? withProgramClosure(
								facts,
								programClosureCertificate(
									{ kind: "whole-program", entry: sourcePath },
									[],
									[],
								),
							)
						: facts,
					afterCoreOptimization(program) {
						operations = coreOperations(coreFunctionNamed(program, "lookup")!);
					},
				},
			);
			expect(
				operations.some(
					(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
				),
			).toBe(true);
			expect(
				operations.some(
					(op) => op.opcode === "createNumber" && op.attributes.value === 11,
				),
			).toBe(!closed);
		},
	);

	it.each(["Symbol(input)", "input"])("keeps possible weak-key hits for %s", (key) => {
		const out = inspectStaticValueFunction(
			`function compute(receiver,input){return WeakSet.prototype.has.call(receiver,${key})?11:17;}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(
			out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
		).toBe(true);
	});

	it("uses a fixed primitive key before an effectful iterable tail", () => {
		const out = inspectStaticValueFunction(
			"function compute(receiver,input,tail){return WeakMap.prototype.get.call(receiver,+input,...tail)===undefined?17:11;}globalThis.compute=compute;",
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "WeakMap.prototype.get",
		);
		expect(out.native.body.instructions[ip]).toMatchObject({ argumentMode: "iterable" });
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
			callsUserCode: true,
			mayThrow: true,
			mayGc: true,
		});
		expect(
			out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
		).toBe(false);
	});

	it("keeps possible hits when the first key comes from an iterable", () => {
		const out = inspectStaticValueFunction(
			"function compute(receiver,tail){return WeakMap.prototype.get.call(receiver,...tail)===undefined?17:11;}globalThis.compute=compute;",
			"compute",
			{ realms: false },
		);
		expect(
			out.fn.instructions.find(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "WeakMap.prototype.get",
			),
		).toMatchObject({ argumentMode: "iterable" });
		expect(
			out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
		).toBe(true);
	});

	it("retains mutable callee results", () => {
		const out = inspectStaticValueFunction(
			"function compute(receiver){return WeakSet.prototype.has.call(receiver,1)?11:17;}globalThis.compute=compute;",
			"compute",
			{ realms: false, locked: false },
		);
		expect(
			out.core.some((op) => op.opcode === "createNumber" && op.attributes.value === 11),
		).toBe(true);
	});
});
