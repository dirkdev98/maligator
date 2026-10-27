import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import {
	analyzeCoreLoopInductions,
	CORE_LOOP_INDUCTION_ANALYSIS,
} from "../src/compiler/core/core-ir-loops.ts";
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
	instructionResultIntegerRange,
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	COMPILER_STRING_LENGTH_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
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

function lengthProgram(attributes: Readonly<Record<string, unknown>> = {}) {
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
		{ attributes: { stringIndex: key, ...attributes } },
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
		const cfg = buildCoreControlFlow(program, fn.id);
		const ranges = analyzeCoreLoopInductions(
			program,
			fn,
			cfg,
			coreCanonicalValueRoots(fn, cfg),
			(value) => kinds.exactScalar(value),
			(value) => kinds.kindMask(value),
		);
		const expectedRange = expected === NUMBER ? COMPILER_STRING_LENGTH_RANGE : undefined;
		expect(ranges.range(result)).toEqual(expectedRange);
		expect(ranges.rangeQuery(() => undefined)(result) ?? undefined).toEqual(
			expectedRange,
		);
		const effects = coreInstructionEffects(fn, load);
		expect([effects.mayThrow, effects.mayGc, effects.callsUserCode]).toEqual([
			true,
			true,
			true,
		]);
	});

	it("bounds a proven genuine Array length without narrowing it to int32", () => {
		const { program, fn, result } = lengthProgram({ exactArrayLength: true });
		const cfg = buildCoreControlFlow(program, fn.id);
		const kinds = analyzeCoreValueKinds(program, fn, cfg);
		const ranges = analyzeCoreLoopInductions(
			program,
			fn,
			cfg,
			coreCanonicalValueRoots(fn, cfg),
			(value) => kinds.exactScalar(value),
			(value) => kinds.kindMask(value),
		);
		expect(ranges.hasNumericRanges).toBe(true);
		expect(ranges.range(result)).toEqual(COMPILER_UINT32_RANGE);
		expect(kinds.exactScalar(result)).toBe("number");
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
		const beforeRanges = manager.get(CORE_LOOP_INDUCTION_ANALYSIS, request);
		expect(beforeRanges.range(result)).toEqual(COMPILER_STRING_LENGTH_RANGE);
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
		expect(
			manager.get(CORE_LOOP_INDUCTION_ANALYSIS, request).range(result),
		).toBeUndefined();
		expect(beforeRanges.range(result)).toEqual(COMPILER_STRING_LENGTH_RANGE);
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
				expect(instructionResultIntegerRange(fn.facts?.[ip], op.dst)).toEqual(
					COMPILER_STRING_LENGTH_RANGE,
				);
				const effects =
					INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
				expect((fn.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
			}
		},
	);

	it("folds the normal typeof result while retaining the nullable read's effects", () => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(value,observe){const text=value===null?null:value+':';observe(text);return typeof text.length==='number';};`,
			"compute",
			{ locked: false },
		);
		expect(out.core.some((op) => op.opcode === "typeofCompare")).toBe(false);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "LOAD_PROPERTY_STATIC",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		const effects =
			INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
		expect((out.native.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
	});

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
			expect(instructionResultIntegerRange(fn.facts?.[ip], op.dst)).toEqual(
				COMPILER_STRING_LENGTH_RANGE,
			);
		}
	});
});

describe("intrinsic length range consumers", () => {
	it.each([
		"Number.isNaN",
		"Number.isFinite",
		"Number.isInteger",
		"Number.isSafeInteger",
	])("folds %s while retaining a nullable read", (operation) => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(value,observe){const text=value===null?null:value+':';observe(text);return ${operation}(text.length);};`,
			"compute",
			{ locked: true },
		);
		expect(
			out.core.some(
				(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
			),
		).toBe(false);
		expect(out.core.some((op) => op.opcode === "loadPropertyStatic")).toBe(true);
	});
	it("joins lengths with integers through a phi before folding a predicate", () => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(value,flag,observe){const text=value+':';observe(text);const n=flag?text.length:0;return Number.isSafeInteger(n);};`,
			"compute",
			{ locked: true },
		);
		expect(
			out.core.some(
				(op) =>
					op.opcode === "callKnown" && op.attributes.operation === "Number.isSafeInteger",
			),
		).toBe(false);
	});
	it("uses a genuine Array length proof after indexed writes", () => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(value,observe){const values=[];let ok=true;for(let i=0;i<(value|0);i++){values[i]=i;observe(i);ok=ok&&Number.isSafeInteger(values.length);}return ok;};`,
			"compute",
			{ locked: true },
		);
		expect(
			out.core.some(
				(op) =>
					op.opcode === "loadPropertyStatic" && op.attributes.exactArrayLength === true,
			),
		).toBe(true);
		expect(
			out.core.some(
				(op) =>
					op.opcode === "callKnown" && op.attributes.operation === "Number.isSafeInteger",
			),
		).toBe(false);
	});
	it("does not retain an escaped record field range", () => {
		const all = inspectStaticValueFunctions(
			`const leaf=function leaf(value,observe){observe(new.target);const text=value===null?null:value+':';observe(text);return {size:text.length};};const compute=function compute(value,observe){const record=leaf(value,observe);observe(record);return Number.isSafeInteger(record.size);};globalThis.keep=[leaf,compute];`,
			["leaf", "compute"],
			{ locked: true },
		);
		expect(
			all
				.get("compute")!
				.core.some(
					(op) =>
						op.opcode === "callKnown" &&
						op.attributes.operation === "Number.isSafeInteger",
				),
		).toBe(true);
	});
	it("publishes length ranges through private record returns", () => {
		const all = inspectStaticValueFunctions(
			`const leaf=function leaf(value,observe){observe(new.target);const text=value===null?null:value+':';observe(text);return {size:text.length};};const compute=function compute(value,observe){const record=leaf(value,observe);observe(value);return Number.isSafeInteger(record.size);};globalThis.keep=[leaf,compute];`,
			["leaf", "compute"],
			{ locked: true },
		);
		const fn = all.get("compute")!.native;
		const read = fn.body.instructions.findIndex(
			(op) => op.opcode === "LOAD_PROPERTY_STATIC",
		);
		const op = fn.body.instructions[read]!;
		if (op.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing record read");
		expect(instructionResultIntegerRange(fn.facts?.[read], op.dst)).toEqual(
			COMPILER_STRING_LENGTH_RANGE,
		);
	});
});
