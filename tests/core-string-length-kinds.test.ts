import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	analyzeCoreValueKinds,
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
} from "../src/compiler/core/core-ir-value-kinds.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_NULL as NULL,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
	COMPILER_VALUE_KIND_NULLISH as NULLISH,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_TOP as TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	instructionResultKind,
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";
import {
	inspectStaticValueFunction,
	inspectStaticValueFunctions,
} from "./helpers/static-values.ts";

function lengthProgram() {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const block = builder.createBlock([{}]);
	const key = builder.editor.appendStringConstants([
		[..."length"].map((x) => x.charCodeAt(0)),
	]);
	const [result] = builder.appendInstruction(
		block,
		"loadPropertyStatic",
		[builder.blockParameterValue(block, 0)],
		{ attributes: { stringIndex: key } },
	);
	builder.setTerminator(block, { kind: "return", value: result! });
	const fn = program.function(builder.finish(block).function);
	return {
		program,
		fn,
		result: result!,
		load: builder.bodyInstructionIds(block)[0]!,
	};
}

describe("primitive String length normal results", () => {
	it.each([
		[STRING, NUMBER],
		[STRING | NULL, NUMBER],
		[STRING | UNDEFINED, NUMBER],
		[STRING | NULLISH, NUMBER],
		[NULL, 0],
		[UNDEFINED, 0],
		[NULLISH, 0],
		[0, 0],
		[OBJECT, TOP],
		[NUMBER, TOP],
		[BOOLEAN, TOP],
		[BIGINT, TOP],
		[SYMBOL, TOP],
		[STRING | OBJECT, TOP],
		[STRING | NUMBER, TOP],
		[TOP, TOP],
	])("infers normal length results for receiver mask %i", (receiver, expected) => {
		const { program, fn, result, load } = lengthProgram();
		const kinds = analyzeCoreValueKinds(
			program,
			fn,
			buildCoreControlFlow(program, fn.id),
			{ parameterMasks: [receiver] },
		);
		expect(kinds.latticeMask(result)).toBe(expected);
		expect(kinds.exactScalar(result)).toBe(expected === NUMBER ? "number" : undefined);
		const effects = coreInstructionEffects(fn, load);
		expect([effects.mayThrow, effects.mayGc, effects.callsUserCode]).toEqual([
			true,
			true,
			true,
		]);
	});

	it.each([NUMBER, SYMBOL, NUMBER | STRING])(
		"preserves independent object field bounds %i",
		(field) => {
			const { program, fn, result } = lengthProgram();
			const kinds = analyzeCoreValueKinds(
				program,
				fn,
				buildCoreControlFlow(program, fn.id),
				{ parameterMasks: [OBJECT], operationResultMask: () => field },
			);
			expect(kinds.kindMask(result)).toBe(field);
		},
	);

	it("invalidates a renamed length read without changing the prior snapshot", () => {
		const { program, fn, result, load } = lengthProgram();
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const specialize = CoreEditor.open(program, fn.id);
		specialize.setValueRepresentation(fn.kernel.functionParameter(0), "string");
		specialize.commit();
		const request = { scope: "function" as const, function: fn.id };
		const before = manager.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
		const edit = CoreEditor.open(program, fn.id);
		const custom = edit.appendStringConstants([
			[..."custom"].map((x) => x.charCodeAt(0)),
		]);
		edit.replaceInstruction(
			load,
			"loadPropertyStatic",
			[fn.kernel.functionParameter(0)],
			{ attributes: { stringIndex: custom } },
		);
		edit.commit();
		expect(manager.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request).kindMask(result)).toBe(
			TOP,
		);
		expect(before.kindMask(result)).toBe(NUMBER);
	});

	it.each(
		["function", "function*", "async function", "async function*"].flatMap(
			(declaration) => [false, true].map((locked) => ({ declaration, locked })),
		),
	)(
		"publishes number results across effects in $declaration with locked=$locked",
		({ declaration, locked }) => {
			const suspension = declaration.includes("*")
				? "yield observe(text);"
				: declaration.startsWith("async")
					? "await observe(text);"
					: "observe(text);";
			const out = inspectStaticValueFunction(
				`globalThis.compute=${declaration} compute(value,observe){const text=value===null?null:value+':';${suspension}return text.length*2;};`,
				"compute",
				{ locked },
			);
			for (const image of [
				out.image,
				deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
			]) {
				const fn = image.native.functions[out.native.functionIndex]!;
				const ip = fn.body.instructions.findIndex(
					(op) => op.opcode === "LOAD_PROPERTY_STATIC",
				);
				const op = fn.body.instructions[ip]!;
				if (op.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing length read");
				expect(instructionResultKind(fn.facts?.[ip], op.dst)).toBe(NUMBER);
				const effects =
					INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
				expect((fn.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
			}
		},
	);

	it("carries length bounds through normal returns and caller arithmetic", () => {
		const all = inspectStaticValueFunctions(
			`const leaf=function leaf(value,observe){observe(new.target);const text=value===null?null:value+':';observe(text);return text.length;};const forward=function forward(value,observe){observe(new.target);return leaf(value,observe);};const compute=function compute(value,observe){return forward(value,observe)*2;};globalThis.keep=[leaf,forward,compute];`,
			["leaf", "forward", "compute"],
			{ locked: false },
		);
		for (const name of ["forward", "compute"]) {
			const fn = all.get(name)!.native;
			const target = all.get(name === "forward" ? "leaf" : "forward")!.native
				.functionIndex;
			const ip = fn.body.instructions.findIndex(
				(op) => op.opcode === "CALL" && op.exactFunctionIndex === target,
			);
			const op = fn.body.instructions[ip]!;
			if (op.opcode !== "CALL") throw new Error("Missing forwarded call");
			expect(instructionResultKind(fn.facts?.[ip], op.dst)).toBe(NUMBER);
		}
	});
});
