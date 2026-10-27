import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_CONDITIONAL_VALUE_KIND_ANALYSIS,
	analyzeCoreConditionalValueKinds,
} from "../src/compiler/core/core-conditional-value-kinds.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-ir-value-kinds.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	instructionInputKind,
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
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function propertyInput(source: string, name: string, expected: number) {
	const out = inspectStaticValueFunction(source, "compute", { locked: false });
	for (const image of [
		out.image,
		deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
	]) {
		const fn = image.native.functions[out.native.functionIndex]!;
		const ip = fn.body.instructions.findIndex(
			(op) =>
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				String.fromCharCode(...(image.runtime.stringConstants[op.stringIndex] ?? [])) ===
					name,
		);
		expect(ip, name).toBeGreaterThanOrEqual(0);
		const op = fn.body.instructions[ip]!;
		if (op.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing property read");
		expect(instructionInputKind(fn.facts?.[ip], op.object), name).toBe(expected);
		const effects =
			INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
		expect((fn.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
	}
	return out;
}

describe("conditional Core value kinds", () => {
	it.each([
		[
			"undefined",
			COMPILER_VALUE_KIND_UNDEFINED,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_UNDEFINED,
		],
		[
			"boolean",
			COMPILER_VALUE_KIND_BOOLEAN,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_BOOLEAN,
		],
		[
			"number",
			COMPILER_VALUE_KIND_NUMBER,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NUMBER,
		],
		[
			"bigint",
			COMPILER_VALUE_KIND_BIGINT,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_BIGINT,
		],
		[
			"string",
			COMPILER_VALUE_KIND_STRING,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_STRING,
		],
		[
			"symbol",
			COMPILER_VALUE_KIND_SYMBOL,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_SYMBOL,
		],
		[
			"object",
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NULL,
		],
		["function", COMPILER_VALUE_KIND_OBJECT, COMPILER_VALUE_KIND_TOP],
	] as const)("retains both %s edge bounds", (type, yes, no) => {
		const source = `globalThis.compute=function compute(value){if(typeof value==='${type}')return value.left;return value.right;};`;
		propertyInput(source, "left", yes);
		propertyInput(source, "right", no);
	});

	it.each([
		["function", "observe(value);"],
		["function*", "yield observe(value);"],
		["async function", "await observe(value);"],
		["async function*", "yield observe(value);await 0;"],
	])("retains immutable operand kinds across effects in %s", (declaration, observe) => {
		propertyInput(
			`globalThis.compute=${declaration} compute(value,observe){if(typeof value==='string'){${observe}return value.length;}return -1;};`,
			"length",
			COMPILER_VALUE_KIND_STRING,
		);
	});

	it("joins phi inputs at their own incoming edges", () => {
		propertyInput(
			`globalThis.compute=function compute(value,observe){let text;if(typeof value==='string')text=value;else text='fallback';observe(text);return text.length;};`,
			"length",
			COMPILER_VALUE_KIND_STRING,
		);
	});

	it("combines object and non-null bounds", () => {
		propertyInput(
			`globalThis.compute=function compute(value,observe){if(typeof value==='object' && value!==null){observe(value);return value.left;}return 0;};`,
			"left",
			COMPILER_VALUE_KIND_OBJECT,
		);
	});

	it("does not send a later guard through an earlier exceptional edge", () => {
		const source = `globalThis.compute=function compute(value,observe){try{observe();if(typeof value==='string'){observe();return value.left;}}catch(error){return value.right;}return 0;};`;
		propertyInput(source, "left", COMPILER_VALUE_KIND_STRING);
		propertyInput(source, "right", COMPILER_VALUE_KIND_TOP);
	});

	it("rechecks a loop value after arbitrary replacement", () => {
		const source = `globalThis.compute=function compute(value,observe){let out;for(let i=0;i<3;i++){if(typeof value==='string'){observe(value);out=value.left;}value=observe(i);}return out;};`;
		propertyInput(source, "left", COMPILER_VALUE_KIND_STRING);
	});
});

it("invalidates branch bounds without mutating earlier snapshots or global representations", () => {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const yes = builder.createBlock();
	const no = builder.createBlock();
	const value = builder.blockParameterValue(entry, 0);
	const [condition] = builder.appendInstruction(entry, "typeofCompare", [value], {
		attributes: { expected: "string", negated: false },
	});
	const predicate = builder.bodyInstructionIds(entry)[0]!;
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: yes, arguments: [] },
		alternate: { block: no, arguments: [] },
	});
	builder.setTerminator(yes, { kind: "return", value });
	builder.setTerminator(no, { kind: "return", value });
	const id = builder.finish(entry).function;
	const manager = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	const request = { scope: "function" as const, function: id };
	const before = manager.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, request);
	expect(manager.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request).kindMask(value)).toBe(
		COMPILER_VALUE_KIND_TOP,
	);
	const edit = CoreEditor.open(program, id);
	edit.replaceInstruction(predicate, "typeofCompare", [value], {
		attributes: { expected: "number", negated: false },
	});
	edit.commit();
	const after = manager.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, request);
	expect(after).not.toBe(before);
	expect(before.kindMask(value, yes)).toBe(COMPILER_VALUE_KIND_STRING);
	expect(after.kindMask(value, yes)).toBe(COMPILER_VALUE_KIND_NUMBER);
	const bypass = CoreEditor.open(program, id);
	bypass.replaceTerminator(entry, { kind: "jump", edge: { block: yes, arguments: [] } });
	bypass.commit();
	expect(
		manager.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, request).kindMask(value, yes),
	).toBe(COMPILER_VALUE_KIND_TOP);
	expect(after.kindMask(value, yes)).toBe(COMPILER_VALUE_KIND_NUMBER);
	expect(program.function(id).valueRepresentation(value)).toBe("boxed");
});

it.each([
	[
		"value != null",
		COMPILER_VALUE_KIND_TOP & ~(COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED),
	],
	[
		"value",
		COMPILER_VALUE_KIND_TOP & ~(COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED),
	],
	[
		"!value",
		COMPILER_VALUE_KIND_TOP & ~(COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_SYMBOL),
	],
	["value === 'known'", COMPILER_VALUE_KIND_STRING],
	["!(typeof value !== 'string')", COMPILER_VALUE_KIND_STRING],
] as const)("bounds %s at a property access", (condition, expected) => {
	propertyInput(
		`globalThis.compute=function compute(value,observe){if(${condition}){observe(value);return value.left;}return 0;};`,
		"left",
		expected,
	);
});

it("solves a loop-carried phi from guarded string inputs", () => {
	propertyInput(
		`globalThis.compute=function compute(value,observe){let text='';while(observe()){if(typeof value==='string')text=value;value=observe(text);}return text.length;};`,
		"length",
		COMPILER_VALUE_KIND_STRING,
	);
});

it("does not narrow a join that also accepts an arbitrary loop replacement", () => {
	propertyInput(
		`globalThis.compute=function compute(value,observe){let text='';while(observe()){if(typeof value==='string')text=value;else text=observe();value=observe(text);}return text.length;};`,
		"length",
		COMPILER_VALUE_KIND_TOP,
	);
});

it.each(["===", "==", "!==", "!="])(
	"reads raw typeof %s predicates before canonicalization",
	(operator) => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const yes = builder.createBlock();
		const no = builder.createBlock();
		const value = builder.blockParameterValue(entry, 0);
		const index = builder.editor.appendStringConstants([
			[..."string"].map((x) => x.charCodeAt(0)),
		]);
		const [type] = builder.appendInstruction(entry, "unary", [value], {
			attributes: { operator: "typeof" },
		});
		const [text] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: index },
		});
		const [condition] = builder.appendInstruction(entry, "binary", [text!, type!], {
			attributes: { operator },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: yes, arguments: [] },
			alternate: { block: no, arguments: [] },
		});
		builder.setTerminator(yes, { kind: "return", value });
		builder.setTerminator(no, { kind: "return", value });
		const id = builder.finish(entry).function;
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const kinds = manager.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: id,
		});
		const negated = operator === "!==" || operator === "!=";
		expect(kinds.kindMask(value, negated ? no : yes)).toBe(COMPILER_VALUE_KIND_STRING);
		expect(kinds.kindMask(value, negated ? yes : no)).toBe(
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_STRING,
		);
	},
);

it.each(["move", "!"])(
	"reads truthiness through %s without narrowing the original snapshot",
	(operator) => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]),
			yes = builder.createBlock(),
			no = builder.createBlock();
		const value = builder.blockParameterValue(entry, 0);
		const [condition] = builder.appendInstruction(
			entry,
			operator === "move" ? "move" : "unary",
			[value],
			{ attributes: operator === "move" ? {} : { operator } },
		);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: yes, arguments: [] },
			alternate: { block: no, arguments: [] },
		});
		builder.setTerminator(yes, { kind: "return", value });
		builder.setTerminator(no, { kind: "return", value });
		const id = builder.finish(entry).function;
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const kinds = manager.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: id,
		});
		expect(kinds.kindMask(value, operator === "move" ? yes : no)).toBe(
			COMPILER_VALUE_KIND_TOP &
				~(COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL),
		);
		expect(kinds.kindMask(value, operator === "move" ? no : yes)).toBe(
			COMPILER_VALUE_KIND_TOP &
				~(COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_SYMBOL),
		);
		expect(kinds.kindMask(value, entry)).toBe(COMPILER_VALUE_KIND_TOP);
	},
);

it("retains independent base bounds when a conditional intersection is unreachable", () => {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{}]),
		yes = builder.createBlock(),
		no = builder.createBlock();
	const value = builder.blockParameterValue(entry, 0);
	const [condition] = builder.appendInstruction(entry, "typeofCompare", [value], {
		attributes: { expected: "string", negated: false },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: yes, arguments: [] },
		alternate: { block: no, arguments: [] },
	});
	builder.setTerminator(yes, { kind: "return", value });
	builder.setTerminator(no, { kind: "return", value });
	const id = builder.finish(entry).function;
	const mask = COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_SYMBOL;
	const kinds = analyzeCoreConditionalValueKinds(
		program,
		program.function(id),
		buildCoreControlFlow(program, id, { exceptions: true }),
		(input) => (input === value ? mask : COMPILER_VALUE_KIND_BOOLEAN),
	);
	expect(kinds.kindMask(value, yes)).toBe(mask);
	expect(kinds.kindMask(value, no)).toBe(mask);
});
