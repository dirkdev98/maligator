import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_BUILTIN_RESULT_PROJECTIONS_ANALYSIS,
	coreBuiltinResultProjection,
} from "../src/compiler/core/core-builtin-result-projections.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunctions } from "./helpers/static-values.ts";

function projectedCall(
	operation: string,
	count = 2,
	attributes: { readonly argumentMode?: string; readonly construct?: boolean } = {},
) {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
	const entry = builder.createBlock([{}, {}, {}]);
	const operands = [0, 1, 2]
		.slice(0, count)
		.map((index) => builder.blockParameterValue(entry, index));
	const [result] = builder.appendInstruction(entry, "callKnown", operands, {
		attributes: { operation, ...attributes },
	});
	builder.setTerminator(entry, { kind: "return", value: result! });
	const fn = program.function(builder.finish(entry).function);
	const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(result!));
	const manager = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	return { program, fn, instruction, result: result!, operands, manager };
}

describe("builtin normal-result projections", () => {
	it.each(["array-like", "nullable-array-like", "array", "iterable"])(
		"preserves a positional prefix before %s arguments, but never projects from the list",
		(argumentMode) => {
			const prefix = projectedCall("Object.freeze", 3, { argumentMode });
			expect(coreBuiltinResultProjection(prefix.fn, prefix.instruction)?.input).toBe(
				prefix.operands[1],
			);
			const list = projectedCall("Object.freeze", 2, { argumentMode });
			expect(coreBuiltinResultProjection(list.fn, list.instruction)).toBeUndefined();
			const kinds = analyzeCoreValueKinds(
				list.program,
				list.fn,
				buildCoreControlFlow(list.program, list.fn.id),
			);
			expect(kinds.kindMask(list.result)).toBe(COMPILER_VALUE_KIND_TOP);
		},
	);

	it("distinguishes an omitted undefined argument from an unknown argument list", () => {
		const out = projectedCall("Object.freeze", 1);
		expect(coreBuiltinResultProjection(out.fn, out.instruction)).toEqual({
			input: undefined,
			identityKinds: undefined,
		});
		const kinds = analyzeCoreValueKinds(
			out.program,
			out.fn,
			buildCoreControlFlow(out.program, out.fn.id),
		);
		expect(kinds.kindMask(out.result)).toBe(COMPILER_VALUE_KIND_UNDEFINED);
	});

	it("invalidates projected inputs when a call changes to construction", () => {
		const out = projectedCall("Object.freeze");
		const request = { scope: "function", function: out.fn.id } as const;
		const before = out.manager.get(CORE_BUILTIN_RESULT_PROJECTIONS_ANALYSIS, request);
		expect(before.get(out.instruction)?.input).toBe(out.operands[1]);
		const edit = CoreEditor.open(out.program, out.fn.id);
		edit.replaceInstruction(out.instruction, "callKnown", out.operands, {
			attributes: { operation: "Object.freeze", construct: true },
		});
		edit.commit();
		expect(out.manager.get(CORE_BUILTIN_RESULT_PROJECTIONS_ANALYSIS, request).size).toBe(
			0,
		);
	});

	it.each([
		["Object.freeze", 1],
		["Map.prototype.set", 0],
	] as const)(
		"publishes %s input provenance while keeping invocation effects",
		(operation, index) => {
			const out = projectedCall(operation);
			const summary = out.manager
				.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
				.summary(out.fn.id)!;
			expect(summary.returnProvenance).toEqual({ kind: "parameter", index });
			expect(summary.effects.mayThrow).toBe(true);
			expect(summary.effects.mayGc).toBe(true);
		},
	);
});

it.each([
	["Object.assign", 1, COMPILER_VALUE_KIND_OBJECT],
	["Number.prototype.valueOf", 0, COMPILER_VALUE_KIND_NUMBER],
] as const)(
	"publishes the input condition for %s without dropping escapes or effects",
	(operation, index, identityKinds) => {
		const out = projectedCall(operation);
		const summary = out.manager
			.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
			.summary(out.fn.id)!;
		expect(summary.returnProvenance).toEqual({ kind: "parameter", index, identityKinds });
		expect(summary.parameterEscape[index]).toBe("retained");
		expect(summary.effects.mayThrow).toBe(true);
		expect(summary.effects.mayGc).toBe(true);
		const edit = CoreEditor.open(out.program, out.fn.id);
		edit.replaceInstruction(out.instruction, "callKnown", out.operands, {
			attributes: { operation: "Object.freeze" },
		});
		edit.commit();
		expect(
			out.manager
				.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" })
				.summary(out.fn.id)!.returnProvenance,
		).toEqual({ kind: "parameter", index: 1 });
	},
);

const bodies = {
	freeze: "const result=Object.freeze(value);observe();return Object.is(result,value);",
	prefix:
		"const result=Object.freeze(value,...other);observe();return Object.is(result,value);",
	list: "const result=Object.freeze.apply(null,other);observe();return Object.is(result,value);",
	map: "const result=Map.prototype.set.call(value,key,other);observe();return Object.is(result,value);",
	mapBound:
		"const result=Map.prototype.set.call(value,key,other);observe();return result;",
	mapChainBound:
		"const mapped=Map.prototype.set.call(value,key,other);const result=Object.freeze(mapped);observe();return result;",
	assign:
		"const target=value?{}:[];const result=Object.assign(target,other);observe();return Object.is(result,target);",
	boxed:
		"const number=value|0;const result=Object.assign(number,other);observe();return Object.is(result,number);",
	number:
		"const number=value|0;const result=Object.freeze(number);observe();return result+1;",
	unbox:
		"const number=value|0;const result=Number.prototype.valueOf.call(number);observe();return Object.is(result,number);",
	joined:
		"let result=Object.freeze(value);for(let i=0;i<3;i++)result=key?result:value;observe();return Object.is(result,value);",
	helper: "const result=forward(value,observe);observe();return Object.is(result,value);",
};

describe.each(["precise", "conservative"] as const)(
	"projected builtin results with %s roots",
	(stackRoots) => {
		it.each([false, true])(
			"retains effects and normal-result bounds with locked=%s",
			(locked) => {
				const source = `const forward=function forward(value,observe){const result=Object.freeze(value);for(let i=0;i<3;i++)observe();return result;};${Object.entries(
					bodies,
				)
					.map(
						([name, body]) =>
							`function ${name}(value,key,other,observe){${body}}globalThis.${name}=${name};`,
					)
					.join("\n")}`;
				const results = inspectStaticValueFunctions(source, Object.keys(bodies), {
					locked,
					stackRoots,
				});
				for (const name of [
					"freeze",
					"prefix",
					"map",
					"assign",
					"unbox",
					"joined",
					"helper",
				]) {
					const out = results.get(name)!;
					expect(
						out.core.some((op) => op.opcode === "call" || op.opcode === "callKnown"),
					).toBe(true);
					if (locked)
						expect(
							out.core.some((op) => op.attributes.operation === "Object.is"),
							name,
						).toBe(false);
				}
				const list = results.get("list")!;
				expect(
					list.core.some(
						(op) =>
							op.attributes.operation === "Object.is" ||
							(op.attributes.knownBuiltinCall as { operation?: string } | undefined)
								?.operation === "Object.is",
					),
				).toBe(true);
				if (!locked) return;
				const bounded = results.get("mapBound")!;
				const index = bounded.native.body.instructions.findIndex(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.set",
				);
				expect(bounded.native.facts![index]!.resultKindMasks).toEqual([
					COMPILER_VALUE_KIND_OBJECT,
				]);
				const call = bounded.native.body.instructions[index]!;
				if (call.opcode !== "CALL_KNOWN") throw new Error("Missing known Map call");
				expect(
					bounded.native.body.instructions.some(
						(op) => op.opcode === "RETURN" && op.value === call.dst,
					),
				).toBe(true);
				const chained = results.get("mapChainBound")!;
				const chainIndex = chained.native.body.instructions.findIndex(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "Object.freeze",
				);
				expect(chained.native.facts![chainIndex]!.resultKindMasks).toEqual([
					COMPILER_VALUE_KIND_OBJECT,
				]);
				const freeze = chained.native.body.instructions[chainIndex]!;
				if (freeze.opcode !== "CALL_KNOWN") throw new Error("Missing known freeze call");
				expect(
					chained.native.body.instructions.some(
						(op) => op.opcode === "RETURN" && op.value === freeze.dst,
					),
				).toBe(true);
				const number = results.get("number")!;
				const numberIndex = number.native.body.instructions.findIndex(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === "Object.freeze",
				);
				expect(number.native.facts![numberIndex]!.resultKindMasks).toEqual([
					COMPILER_VALUE_KIND_NUMBER,
				]);
				expect(number.native.facts![numberIndex]!.resultIntegerRanges?.[0]).toMatchObject(
					{ minimum: -2147483648, maximum: 2147483647 },
				);
				const artifact = deserializeCompilerArtifact(
					serializeCompilerArtifact(number.image),
				);
				expect(
					artifact.native.functions[number.image.native.functions.indexOf(number.native)]!
						.facts,
				).toEqual(number.native.facts);
			},
		);
	},
);
