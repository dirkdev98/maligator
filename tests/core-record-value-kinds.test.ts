import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULLISH,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function records(source: string) {
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
	const fields = (name: string, state = read()) => {
		const result = state.summary(named(name).id).returnRecord;
		return result === undefined || result === null
			? result
			: Object.fromEntries(
					result.map(({ key, mask }) => [program.stringConstantText(key), mask]),
				);
	};
	return { program, context, manager, read, named, fields };
}

describe("normal-return record field kinds", () => {
	it("keeps each initial own field independently of coercion effects", () => {
		const out = records(
			`function make(value, flag){return {n:+value, s:"text", b:true, u:flag?null:undefined};}globalThis.result=make(globalThis.input,globalThis.flag);`,
		);
		expect(out.fields("make")).toEqual({
			n: COMPILER_VALUE_KIND_NUMBER,
			s: COMPILER_VALUE_KIND_STRING,
			b: COMPILER_VALUE_KIND_BOOLEAN,
			u: COMPILER_VALUE_KIND_NULLISH,
		});
	});

	it("retains an empty own-field set without claiming prototype fields", () => {
		const out = records(`function make(){return {};}globalThis.result=make();`);
		expect(out.fields("make")).toEqual({});
	});

	it("projects actual parameter kinds into returned fields", () => {
		const out = records(
			`function make(value){return {value};}function forward(value){return make(value);}globalThis.a=forward(1);globalThis.b=forward("text");`,
		);
		for (const name of ["make", "forward"])
			expect(out.fields(name)).toEqual({
				value: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			});
	});

	it.each([
		"make(...globalThis.values)",
		"make(...arguments)",
		"make(...[1,2])",
		"new make()",
		"new make(...globalThis.values)",
		"new make(...[1,2])",
	])("preserves fresh fields across %s", (call) => {
		const out = records(
			`function make(){return {n:1};}function forward(){return ${call};}globalThis.result=forward();`,
		);
		expect(out.fields("forward")).toEqual({ n: COMPILER_VALUE_KIND_NUMBER });
	});

	it("joins common own keys without treating absent fields as undefined", () => {
		const out = records(
			`function make(flag){if(flag)return {value:1,left:true};return {right:null,value:"text"};}globalThis.result=make(globalThis.flag);`,
		);
		expect(out.fields("make")).toEqual({
			value: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		});
	});
	it.each([
		"return flag?{value:1,left:true}:{right:null,value:'text'};",
		"let result;if(flag)result={value:1,left:true};else result={right:null,value:'text'};return result;",
		"return flag?leaf(1):leaf('text');",
		"let result={value:1};while(flag-- > 0){if(flag&1)result={value:'text'};}return result;",
	])("joins fresh records through control-flow aliases (%s)", (body) => {
		const out = records(
			`function leaf(value){return {value};}function make(flag){${body}}globalThis.result=make(globalThis.flag);`,
		);
		expect(out.fields("make")).toEqual({
			value: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		});
	});
	it.each([
		"const value=flag?{n:1}:{n:2};value.n='changed';return value;",
		"const value=flag?{n:1}:{n:2};globalThis.observe(value);return value;",
		"return flag?{n:1}:globalThis.value;",
		"return flag?{n:1}:null;",
		"let result={n:1};while(flag-- > 0){result=globalThis.value;}return result;",
		"let result=flag?{n:1}:{n:2};try{globalThis.observe();}finally{globalThis.observe(result);}return result;",
	])("rejects an escaped or non-record control-flow alternative (%s)", (body) => {
		const out = records(
			`function make(flag){${body}}globalThis.result=make(globalThis.flag);`,
		);
		expect(out.fields("make")).toBeUndefined();
	});

	it("propagates changed fields through a long exact forwarding chain", () => {
		const length = 32;
		const out = records(
			`function leaf(value){return {value:+value};}${Array.from({ length }, (_, index) => `function forward${index}(value){return ${index === 0 ? "leaf" : `forward${index - 1}`}(value);}`).join("")}globalThis.result=forward${length - 1}(globalThis.input);`,
		);
		const state = out.read();
		for (let index = 0; index < length; index++)
			expect(out.fields(`forward${index}`, state)).toEqual({
				value: COMPILER_VALUE_KIND_NUMBER,
			});
		expect(state.statistics.functionsEvaluated).toBeLessThanOrEqual(
			state.statistics.functions * 3,
		);
	});

	it("converges mutually recursive records without turning bottom into unknown", () => {
		const out = records(
			`function first(n){if(n>0)return second(n-1);return {value:1};}function second(n){if(n>0)return first(n-1);return {value:"text"};}globalThis.result=first(globalThis.input);`,
		);
		for (const name of ["first", "second"])
			expect(out.fields(name)).toEqual({
				value: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			});
	});

	it.each([
		`const value={n:1};value.n="changed";return value;`,
		`const value={n:1};globalThis.observe(value);return value;`,
		`return {get n(){return 1;}};`,
		`return {[globalThis.key]:1};`,
		`return {...globalThis.input};`,
		`return globalThis.value;`,
		`const value=leaf();value.n="changed";return value;`,
		`const value=leaf();globalThis.observe(value);return value;`,
		`return globalThis.unknown();`,
	])("withdraws the fresh-record contract for %s", (body) => {
		const out = records(
			`function leaf(){return {n:1};}function make(){${body}}globalThis.result=make();`,
		);
		expect(out.fields("make")).toBeUndefined();
	});

	it("does not treat a constructor's primitive body result as returned fields", () => {
		const out = records(
			`function make(){return 1;}function forward(){return new make();}globalThis.result=forward();`,
		);
		expect(out.fields("forward")).toBeUndefined();
	});

	it("joins complete finite callee sets and rejects a non-record alternative", () => {
		const out = records(
			`function number(){return {n:1};}function string(){return {n:"text"};}function unknown(){return globalThis.value;}function finite(flag){const selected=flag?number:string;return selected();}function mixed(flag){const selected=flag?number:unknown;return selected();}globalThis.a=finite(globalThis.flag);globalThis.b=mixed(globalThis.flag);`,
		);
		expect(out.fields("finite")).toEqual({
			n: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		});
		expect(out.fields("mixed")).toBeUndefined();
	});

	it.each(["async function", "function*"])(
		"keeps the %s body result out of the call's record fields",
		(declaration) => {
			const out = records(
				`${declaration} make(){return {n:1};}globalThis.result=make();`,
			);
			expect(out.fields("make")).toBeUndefined();
		},
	);

	it("keeps unrelated arithmetic out of record-field demands", () => {
		const out = records(
			`function make(value){const unused=value*value;return {n:1};}globalThis.result=make(globalThis.input);`,
		);
		const fn = out.named("make");
		const unused = coreOperations(fn).find(
			({ opcode, attributes }) => opcode === "binary" && attributes.operator === "*",
		)!;
		expect(out.fields("make")).toEqual({ n: COMPILER_VALUE_KIND_NUMBER });
		expect(() => out.read().values(fn.id).latticeMask(unused.outputs[0]!)).toThrow(
			"Unrequested program value kind",
		);
	});

	it("invalidates field-only changes through callers and retains the prior snapshot", () => {
		const out = records(
			`function leaf(){return {n:1,tag:"changed"};}function forward(){return leaf();}function unrelated(){return {b:true};}globalThis.a=forward();globalThis.b=unrelated();`,
		);
		const before = out.read();
		expect(out.fields("forward", before)?.n).toBe(COMPILER_VALUE_KIND_NUMBER);
		const leaf = out.named("leaf");
		const literal = coreOperations(leaf).find(
			({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 1,
		)!;
		const stringIndex = out.program.stringConstants.findIndex(
			(_, index) => out.program.stringConstantText(index) === "changed",
		);
		const editor = CoreEditor.open(out.program, leaf.id);
		editor.replaceInstruction(literal.id, "createString", [], {
			attributes: { stringIndex },
		});
		editor.commit();
		const after = out.read();
		expect(out.fields("forward", after)?.n).toBe(COMPILER_VALUE_KIND_STRING);
		expect(out.fields("forward", before)?.n).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(after.statistics.functionsReused).toBeGreaterThan(0);
		const fresh = new CoreAnalysisManager(
			out.program,
			out.context,
			new CoreOptimizationReportBuilder(out.program),
		).get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
		for (const id of out.program.functionIds())
			expect(after.summary(id)).toEqual(fresh.summary(id));
	});
});
