import { describe, expect, it } from "vitest";
import { runtimeGapBuildConfig } from "../scripts/runtime-gap-build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { CORE_RECORD_FIELD_KIND_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { coreReadOnlyRecordFields } from "../src/compiler/core/core-record-value-kinds.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function flow(source: string) {
	const { program, context } = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/entry.js", parseModule(source)),
		{ facts: programAnalysisContext().facts },
	);
	const manager = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const read = () =>
		manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
	const named = (name: string) => coreFunctionNamed(program, name)!;
	return { program, context, manager, read, named };
}

function readKind(producer: string, reader = "return value.n;", call = "make(input)") {
	const out = flow(
		`function make(input){${producer}}function read(input,observe){const value=${call};${reader}}globalThis.result=read(globalThis.input,globalThis.observe);`,
	);
	return out.read().summary(out.named("read").id).returnKind;
}

describe("fresh record field observations", () => {
	it.each([
		["+input", COMPILER_VALUE_KIND_NUMBER],
		['"text"', COMPILER_VALUE_KIND_STRING],
		["true", COMPILER_VALUE_KIND_BOOLEAN],
		["undefined", COMPILER_VALUE_KIND_UNDEFINED],
		["null", COMPILER_VALUE_KIND_NULL],
		["3n", COMPILER_VALUE_KIND_BIGINT],
	])("projects the normal field kind of %s", (value, expected) => {
		expect(readKind(`return {n:${value}};`)).toBe(expected);
	});

	it("retains own data-field kinds across unrelated opaque calls and aliases", () => {
		expect(
			readKind("return {n:+input};", "const alias=value;observe();return alias.n;"),
		).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

	it.each([
		"make(...[input])",
		"make(...arguments)",
		"new make(input)",
		"new make(...[input])",
	])("projects fields across %s", (call) => {
		expect(readKind("return {n:+input};", "return value.n;", call)).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
	});

	it.each([
		'value.n="changed";return value.n;',
		'const alias=value;alias.n="changed";return value.n;',
		"observe(value);return value.n;",
		"globalThis.escaped=value;return value.n;",
		"value.missing;return value.n;",
		"value[globalThis.key];return value.n;",
		"value.method();return value.n;",
		'eval("value.n=true");return value.n;',
	])("withdraws the read proof for %s", (reader) => {
		expect(readKind("return {n:1};", reader)).toBe(COMPILER_VALUE_KIND_TOP);
	});

	it("does not infer an absent field or bypass an accessor producer", () => {
		expect(readKind("return {other:1};")).toBe(COMPILER_VALUE_KIND_TOP);
		expect(readKind("return {get n(){return 1;}};")).toBe(COMPILER_VALUE_KIND_TOP);
	});

	it("joins field masks from complete finite targets", () => {
		const out = flow(
			`function number(){return {n:1};}function string(){return {n:"text"};}function read(flag){const make=flag?number:string;const value=make();return value.n;}globalThis.result=read(globalThis.flag);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		);
	});

	it("closes the scanner's parameter/return-field cycle without widening to unknown", () => {
		const out = flow(
			`function scan(text,start){let end=start;while(end<text.length&&text.charCodeAt(end)!==32)end++;return {start,end};}function read(text){let total=0;for(let index=0;index<text.length;){const token=scan(text,index);total+=token.end-token.start;index=token.end+1;}return total;}globalThis.result=read("a bb ccc");`,
		);
		expect(out.read().summary(out.named("scan").id).parameterKinds).toEqual([
			COMPILER_VALUE_KIND_STRING,
			COMPILER_VALUE_KIND_NUMBER,
		]);
		for (const { mask } of out.read().summary(out.named("scan").id).returnRecord!)
			expect(mask).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

	it("selects numeric scanner and caller entries through the returned-field feedback loop", () => {
		let fieldKinds: ReadonlyArray<number> = [];
		const image = compileEntrypoint(
			new URL("../bench/runtime-gap/cases/returned-records.mjs", import.meta.url)
				.pathname,
			{
				buildConfig: runtimeGapBuildConfig(),
				stripTypes: stripCompactTypes,
				afterCoreOptimization(program) {
					fieldKinds = coreOperations(coreFunctionNamed(program, "tokenWeight")!).flatMap(
						({ attributes }) => {
							const kind = attributes[CORE_RECORD_FIELD_KIND_ATTRIBUTE];
							return typeof kind === "number" ? [kind] : [];
						},
					);
				},
			},
		);
		expect(fieldKinds.length).toBeGreaterThan(0);
		expect(fieldKinds.every((kind) => kind === COMPILER_VALUE_KIND_NUMBER)).toBe(true);
		const named = (name: string) =>
			image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
		expect(
			named("nextToken").directEntries?.some(
				(entry) =>
					entry.resultFields !== undefined &&
					entry.parameterRepresentations[1] === "number",
			),
		).toBe(true);
		expect(
			named("tokenWeight").directEntries?.some(
				(entry) => entry.resultRepresentation === "number",
			),
		).toBe(true);
		expect(named("tokenWeight").recordCalls?.length).toBeGreaterThan(0);
	});

	it("invalidates readers when an own key disappears while the return stays Object", () => {
		const out = flow(
			`function make(){return {n:1};}function read(){const value=make();return value.n;}globalThis.result=read();`,
		);
		const before = out.read();
		expect(before.summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		const fn = out.named("make");
		const allocation = coreOperations(fn).find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		const editor = CoreEditor.open(out.program, fn.id);
		const stringIndex = editor.appendStringConstants([[111, 116, 104, 101, 114]]);
		editor.replaceInstruction(allocation.id, allocation.opcode, allocation.inputs, {
			attributes: { ...allocation.attributes, keyStringIndices: [stringIndex] },
		});
		editor.commit();
		const after = out.read();
		expect(after.summary(out.named("read").id).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		expect(before.summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		const fresh = new CoreAnalysisManager(
			out.program,
			out.context,
			new CoreOptimizationReportBuilder(out.program),
		).get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
		for (const id of out.program.functionIds())
			expect(after.summary(id)).toEqual(fresh.summary(id));
	});

	it("keeps consumer-only field reads out of program propagation demands", () => {
		const out = flow(
			`function make(){return {n:1};}function read(){const value=make();value.n;return 1;}globalThis.result=read();`,
		);
		const fn = out.named("read");
		const [read] = [...coreReadOnlyRecordFields(fn).keys()];
		expect(read).toBeDefined();
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(read!));
		expect(() => out.read().values(fn.id).latticeMask(value)).toThrow(
			"Unrequested program value kind",
		);
	});

	it("withdraws and restores the read proof during open and committed edits", () => {
		const out = flow(
			`function make(){return {n:1};}function read(){const value=make();return value.n;}globalThis.result=read();`,
		);
		const fn = out.named("read");
		const before = coreReadOnlyRecordFields(fn);
		expect(before.size).toBe(1);
		const read = [...before.keys()][0]!;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(read));
		const editor = CoreEditor.open(out.program, fn.id);
		const coercion = editor.insertInstruction(
			fn.instructionBlock(read),
			read,
			"unary",
			[value],
			{ attributes: { operator: "+" } },
		);
		expect(coreReadOnlyRecordFields(fn).size).toBe(0);
		editor.commit();
		expect(coreReadOnlyRecordFields(fn).size).toBe(0);
		expect(before.size).toBe(1);
		const restore = CoreEditor.open(out.program, fn.id);
		restore.removeInstruction(coercion.instruction);
		expect(coreReadOnlyRecordFields(fn).size).toBe(1);
		restore.commit();
		expect(coreReadOnlyRecordFields(fn).size).toBe(1);
	});

	it("publishes a String field kind independently of opaque effects for concatenation", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(flag,gate){for(let i=0;i<3;i++)gate(i);return {label:flag?"left":"right"};};function compute(flag,gate){const result=make(flag,gate);gate();return result.label+":";}globalThis.compute=compute;`,
			"compute",
		);
		const read = out.core.find(
			({ opcode, attributes }) =>
				opcode === "loadPropertyStatic" &&
				attributes[CORE_RECORD_FIELD_KIND_ATTRIBUTE] !== undefined,
		)!;
		expect(read.attributes[CORE_RECORD_FIELD_KIND_ATTRIBUTE]).toBe(
			COMPILER_VALUE_KIND_STRING,
		);
		expect(out.c.source).toContain("mal_vm_concat_strings_known(");
		expect(out.c.source).not.toContain("mal_ops_is_number(");
	});

	it.each(["function", "function*", "async function", "async function*"])(
		"retains the nullable String field union in the %s entry",
		(declaration) => {
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`const make=function make(flag,gate){for(let i=0;i<3;i++)gate(i);return {n:flag?null:"text"};};${declaration} compute(flag,gate){const result=make(flag,gate);${suspension}gate();return typeof result.n==="object";}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				({ opcode }) => opcode === "TYPEOF_COMPARE",
			);
			const compared = out.native.body.instructions[ip]!;
			if (compared.opcode !== "TYPEOF_COMPARE")
				throw new Error("Missing nullable observation");
			expect(instructionInputKind(out.native.facts?.[ip], compared.src)).toBe(
				COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_STRING,
			);
			expect(out.c.source).toContain(`mal_value_is_null(r${compared.src})`);
			expect(out.c.source).not.toContain("mal_vm_typeof_compare(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("does not assume a public factory binding survives arbitrary callers", () => {
		const out = inspectStaticValueFunction(
			`function make(value,gate){for(let i=0;i<3;i++)gate(i);return {n:+value};}function compute(value,gate){const result=make(value,gate);gate();return typeof result.n==="number";}globalThis.compute=compute;`,
			"compute",
		);
		expect(out.core.some(({ opcode }) => opcode === "typeofCompare")).toBe(true);
	});

	it.each([
		"undefined",
		"object",
		"boolean",
		"number",
		"string",
		"symbol",
		"bigint",
		"function",
	])("uses the partial Number/String field union for typeof %s", (expected) => {
		const out = inspectStaticValueFunction(
			`const number=function number(value,gate){for(let i=0;i<3;i++)gate(i);return {n:+value};};const string=function string(value,gate){for(let i=0;i<3;i++)gate(i);return {n:"text"};};function compute(value,flag,gate){const make=flag?number:string;const result=make(value,gate);gate();return typeof result.n===${JSON.stringify(expected)};}globalThis.compute=compute;`,
			"compute",
		);
		expect(out.core.filter(({ opcode }) => opcode === "typeofCompare")).toHaveLength(
			expected === "number" || expected === "string" ? 1 : 0,
		);
	});

	it.each(["function", "function*", "async function", "async function*"])(
		"folds the own-field observation in the %s entry without discarding coercion",
		(declaration) => {
			for (const locked of [false, true]) {
				const suspension =
					(declaration.includes("*") ? "yield 0;" : "") +
					(declaration.startsWith("async") ? "await 0;" : "");
				const out = inspectStaticValueFunction(
					`const make=function make(value,gate){for(let i=0;i<3;i++)gate(i);return {n:+value};};${declaration} compute(value,gate){const result=make(value,gate);${suspension}gate();return typeof result.n==="number";}globalThis.compute=compute;`,
					"compute",
					{ locked },
				);
				expect(out.core.filter(({ opcode }) => opcode === "typeofCompare")).toHaveLength(
					0,
				);
				expect(out.core.some(({ opcode }) => opcode === "call")).toBe(true);
				expect(
					out.native.body.instructions.some(({ opcode }) => opcode === "TYPEOF_COMPARE"),
				).toBe(false);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);
});
