import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { coreRecordReturnKindInputs } from "../src/compiler/core/core-record-value-kinds.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_TOP,
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
	it.each([
		["undefined", COMPILER_VALUE_KIND_UNDEFINED],
		["boolean", COMPILER_VALUE_KIND_BOOLEAN],
		["number", COMPILER_VALUE_KIND_NUMBER],
		["bigint", COMPILER_VALUE_KIND_BIGINT],
		["string", COMPILER_VALUE_KIND_STRING],
		["symbol", COMPILER_VALUE_KIND_SYMBOL],
		["object", COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL],
		["function", COMPILER_VALUE_KIND_OBJECT],
	] as const)(
		"bounds a caller-side %s writer independently of the initial field",
		(kind, mask) => {
			const out = records(
				`function make(){return {value:0};}function read(input){const record=make();if(typeof input==='${kind}')record.value=input;return record.value;}globalThis.result=read(globalThis.input);`,
			);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(
				COMPILER_VALUE_KIND_NUMBER | mask,
			);
		},
	);

	it.each([
		["if(typeof input==='number')record.value=input;", COMPILER_VALUE_KIND_NUMBER],
		[
			"if(typeof input==='string')record.value=input;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		[
			"if(typeof input==='number')record.value=input;record.value=input;",
			COMPILER_VALUE_KIND_TOP,
		],
	] as const)("retains caller-side writer bounds (%s)", (writes, mask) => {
		const out = records(
			`function make(){return {value:0};}function read(input){const record=make();${writes}return record.value;}globalThis.result=read(globalThis.input);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(mask);
	});

	it("combines nullable phi bounds with the caller's field writer guard", () => {
		const out = records(
			`function make(){return {value:'initial'};}function read(flag){const record=make();const input=flag?'changed':null;if(input!==null)record.value=input;return record.value;}globalThis.result=read(globalThis.flag);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_STRING,
		);
	});

	it("joins guarded loop-carried caller writes without retaining earlier non-Number alternatives", () => {
		const out = records(
			`function make(){return {value:0};}function read(flag){const record=make();let input=true;for(let step=0;step<3;step++){if(typeof input==='number')record.value=input;input=flag?2:false;}return record.value;}globalThis.result=read(globalThis.flag);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
	});

	it("does not seed a guarded caller write before its recursive producer returns", () => {
		const out = records(
			`function make(){return make();}function read(input){const record=make();if(typeof input==='number')record.value=input;return record.value;}globalThis.result=read(globalThis.input);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
	});

	it("withdraws a caller field bound after its writer predicate changes", () => {
		const out = records(
			`function make(){return {value:0};}function read(input){const record=make();if(typeof input==='number')record.value=input;return record.value;}globalThis.result=read(globalThis.input);`,
		);
		const before = out.read();
		const fn = out.named("read");
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
		const block = [...fn.blockIds()].find(
			(block) => fn.instructionKind(fn.blockTerminator(block)) === "branch",
		)!;
		const predicate = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(fn.blockTerminator(block)),
		);
		const editor = CoreEditor.open(out.program, fn.id);
		editor.replaceInstruction(
			coreInstructionId(fn.kernel.valueDefinitionOwner(predicate)),
			"createBoolean",
			[],
			{ attributes: { value: true } },
		);
		editor.commit();
		expect(out.read().summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

	it.each([
		[
			"const record={value:0};if(typeof input==='number')record.value=input;return record;",
			COMPILER_VALUE_KIND_NUMBER,
		],
		[
			"if(typeof input==='number')return {value:input};return {value:0};",
			COMPILER_VALUE_KIND_NUMBER,
		],
		[
			"const record={value:0};if(typeof input==='string')record.value=input;return record;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		[
			"const record={value:0};if(typeof input==='number')record.value=input;record.value=input;return record;",
			COMPILER_VALUE_KIND_TOP,
		],
	] as const)("uses each field writer's branch bounds (%s)", (body, mask) => {
		const out = records(
			`function make(input){${body}}function forward(input){return make(input);}function read(input){return forward(input).value;}globalThis.result=read(globalThis.input);`,
		);
		for (const name of ["make", "forward"])
			expect(out.fields(name)).toEqual({ value: mask });
		expect(out.read().summary(out.named("read").id).returnKind).toBe(mask);
	});

	it("withdraws a field writer's branch proof when its predicate changes", () => {
		const out = records(
			`function make(input){const record={value:0};if(typeof input==='number')record.value=input;return record;}function read(input){return make(input).value;}globalThis.result=read(globalThis.input);`,
		);
		const before = out.read();
		expect(out.fields("make", before)).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
		const fn = out.named("make");
		const block = [...fn.blockIds()].find(
			(block) => fn.instructionKind(fn.blockTerminator(block)) === "branch",
		)!;
		const condition = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(fn.blockTerminator(block)),
		);
		const editor = CoreEditor.open(out.program, fn.id);
		editor.replaceInstruction(
			coreInstructionId(fn.kernel.valueDefinitionOwner(condition)),
			"createBoolean",
			[],
			{ attributes: { value: true } },
		);
		editor.commit();
		expect(out.fields("make")).toEqual({ value: COMPILER_VALUE_KIND_TOP });
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_TOP,
		);
		expect(out.fields("make", before)).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
	});

	it("keeps an unsolved field input empty behind a kind guard", () => {
		const out = records(
			`function never(){return never();}function make(){const input=never();if(typeof input==='number')return {value:input};return never();}function read(){return make().value;}globalThis.result=read();`,
		);
		expect(out.fields("make")).toEqual({ value: 0 });
		expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
	});

	it("revalidates forwarded own-key requirements when the callee changes", () => {
		const out = records(
			`function leaf(){return {value:1};}function forward(){const record=leaf();record.value=2;return record;}function read(){return forward().value;}globalThis.result=read();`,
		);
		expect(out.fields("forward")).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
		const fn = out.named("leaf");
		const allocation = coreOperations(fn).find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		for (const missing of [true, false]) {
			const edit = CoreEditor.open(out.program, fn.id);
			const key = edit.appendStringConstants([[109, 105, 115, 115, 105, 110, 103]]);
			edit.replaceInstruction(allocation.id, allocation.opcode, allocation.inputs, {
				attributes: {
					...allocation.attributes,
					keyStringIndices: missing ? [key] : allocation.attributes.keyStringIndices,
				},
			});
			edit.commit();
			if (missing) expect(out.fields("forward")).toBeUndefined();
			else expect(out.fields("forward")).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
			expect(out.read().summary(out.named("read").id).returnKind).toBe(
				missing ? COMPILER_VALUE_KIND_TOP : COMPILER_VALUE_KIND_NUMBER,
			);
		}
	});

	it("does not demand fields from non-returned forwarding temporaries", () => {
		const out = records(
			`function leaf(){return {value:0};}function forward(input){const record=leaf();record.value=input;return 0;}globalThis.result=forward(globalThis.input);`,
		);
		expect(coreRecordReturnKindInputs(out.named("forward"))).toEqual([]);
	});

	it.each([
		["record.value=2;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=+input;", COMPILER_VALUE_KIND_NUMBER],
		[
			"if(flag)record.value='changed';",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		[
			"record['value']=!!input;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
		],
		["for(let step=0;step<3;step++)record.value=step&255;", COMPILER_VALUE_KIND_NUMBER],
		["const alias=record;alias.value=2;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=globalThis.input;", COMPILER_VALUE_KIND_TOP],
	] as const)(
		"retains forwarded own-field writes through exact call chains (%s)",
		(body, mask) => {
			const out = records(
				`function leaf(){return {value:1,stable:'ok'};}function forward(input,flag){const record=leaf();${body}return record;}function again(input,flag){return forward(input,flag);}function read(input,flag){return again(input,flag).value;}globalThis.result=read(globalThis.input,globalThis.flag);`,
			);
			for (const name of ["forward", "again"])
				expect(out.fields(name)).toEqual({
					value: mask,
					stable: COMPILER_VALUE_KIND_STRING,
				});
			expect(out.read().summary(out.named("read").id).returnKind).toBe(mask);
		},
	);

	it.each(["leaf(input)", "new leaf(input)", "new leaf(...[input])"])(
		"retains own writes to forwarded %s results",
		(call) => {
			const out = records(
				`function leaf(input){return {value:input&15};}function forward(input){const record=${call};record.value=input&255;return record;}globalThis.result=forward(globalThis.input);`,
			);
			expect(out.fields("forward")).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
		},
	);

	it.each([
		"record.missing=2;",
		"record[globalThis.key]=2;",
		"globalThis.observe(record);record.value=2;",
		"record.value=record;",
		"record.missing;record.value=2;",
		"Object.defineProperty(record,'value',{get(){return 2;}});",
	])("rejects forwarded record writes after an unproven access (%s)", (body) => {
		const out = records(
			`function leaf(){return {value:1};}function forward(){const record=leaf();${body}return record;}globalThis.result=forward();`,
		);
		expect(out.fields("forward")).toBeUndefined();
	});

	it("does not seed a forwarding cycle from its writes", () => {
		const out = records(
			`function first(){const record=second();record.value=1;return record;}function second(){return first();}globalThis.result=first();`,
		);
		for (const name of ["first", "second"]) {
			expect(out.read().summary(out.named(name).id).returnKind).toBe(0);
			expect(out.fields(name) ?? null).toBeNull();
		}
	});

	it("joins forwarded writes with a recursive literal base", () => {
		const out = records(
			`function first(n){const record=n>0?second(n-1):{value:1,stable:'ok'};record.value='changed';return record;}function second(n){return first(n);}globalThis.result=first(globalThis.input);`,
		);
		for (const name of ["first", "second"])
			expect(out.fields(name)).toEqual({
				value: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
				stable: COMPILER_VALUE_KIND_STRING,
			});
	});
	it.each([
		["record.value=2;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=+input;", COMPILER_VALUE_KIND_NUMBER],
		[
			"if(flag)record.value='changed';",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		[
			"record['value']=!!input;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
		],
		["for(let n=0;n<3;n++)record.value=n&255;", COMPILER_VALUE_KIND_NUMBER],
		["const alias=record;alias.value=2;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=globalThis.input;", COMPILER_VALUE_KIND_TOP],
	] as const)(
		"joins producer writes without losing untouched fields (%s)",
		(body, kind) => {
			const out = records(
				`function make(input,flag){const record={value:1,stable:'ok'};${body}return record;}function forward(input,flag){return make(input,flag);}function read(input,flag){return forward(input,flag).value;}globalThis.result=read(globalThis.input,globalThis.flag);`,
			);
			for (const name of ["make", "forward"])
				expect(out.fields(name)).toEqual({
					value: kind,
					stable: COMPILER_VALUE_KIND_STRING,
				});
			expect(out.read().summary(out.named("read").id).returnKind).toBe(kind);
		},
	);

	it.each([
		"record.missing=2;",
		"record[globalThis.key]=2;",
		"globalThis.observe(record);record.value=2;",
		"record.value=globalThis.replace(record);",
		"record.value=record;",
		"Object.defineProperty(record,'value',{get(){return 2;}});",
	])("rejects producer writes that can expose or redefine the record (%s)", (body) => {
		const out = records(
			`function make(){const record={value:1};${body}return record;}globalThis.result=make();`,
		);
		expect(out.fields("make")).toBeUndefined();
	});

	it("does not seed producer writes before the initial value can complete", () => {
		const out = records(
			`function never(){return never();}function make(){const record={value:never()};record.value=2;return record;}function read(){return make().value;}globalThis.result=read();`,
		);
		expect(out.fields("make")).toEqual({ value: 0 });
		expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
	});

	it("reuses structural producer inputs while refreshing normal writer facts", () => {
		const out = records(
			`function make(input){const record={value:1};record.value=input.n;return record;}function read(input){return make(input).value;}globalThis.result=read(globalThis.input);`,
		);
		const fn = out.named("make");
		const inputs = coreRecordReturnKindInputs(fn);
		const before = out.read();
		expect(out.fields("make", before)).toEqual({ value: COMPILER_VALUE_KIND_TOP });
		const load = coreOperations(fn).find(
			({ opcode }) => opcode === "loadPropertyStatic" || opcode === "loadProperty",
		)!;
		for (const mask of [COMPILER_VALUE_KIND_NUMBER, undefined]) {
			const edit = CoreEditor.open(out.program, fn.id);
			edit.setNormalResultFacts(load.id, mask === undefined ? undefined : { mask });
			edit.commit();
			expect(coreRecordReturnKindInputs(fn)).toBe(inputs);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(
				mask ?? COMPILER_VALUE_KIND_TOP,
			);
		}
		expect(out.fields("make", before)).toEqual({ value: COMPILER_VALUE_KIND_TOP });
	});

	it("keeps unreturned objects with own accesses out of returned-field demands", () => {
		const out = records(
			`function make(input){const local={n:input*input};local.n=input+input;globalThis.observe(local.n);return {value:1};}globalThis.result=make(globalThis.input);`,
		);
		expect(out.fields("make")).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
		const fn = out.named("make");
		for (const operation of coreOperations(fn).filter(
			({ opcode }) => opcode === "binary",
		))
			expect(() => out.read().values(fn.id).latticeMask(operation.outputs[0]!)).toThrow(
				"Unrequested program value kind",
			);
	});

	it("withdraws and restores producer input plans across active structural edits", () => {
		const out = records(
			`function make(){const record={value:1};record.value=2;return record;}globalThis.result=make();`,
		);
		const fn = out.named("make");
		const before = coreRecordReturnKindInputs(fn);
		const allocation = coreOperations(fn).find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		const edit = CoreEditor.open(out.program, fn.id);
		const key = edit.appendStringConstants([[109, 105, 115, 115, 105, 110, 103]]);
		const write = edit.insertInstruction(
			fn.instructionBlock(allocation.id),
			fn.blockTerminator(fn.instructionBlock(allocation.id)),
			"storePropertyStatic",
			[allocation.outputs[0]!, allocation.inputs[0]!],
			{ attributes: { stringIndex: key } },
		);
		expect(coreRecordReturnKindInputs(fn)).toEqual([]);
		edit.commit();
		expect(out.fields("make")).toBeUndefined();
		const restore = CoreEditor.open(out.program, fn.id);
		restore.removeInstruction(write.instruction);
		expect(coreRecordReturnKindInputs(fn)).toEqual(before);
		restore.commit();
		expect(out.fields("make")).toEqual({ value: COMPILER_VALUE_KIND_NUMBER });
		expect(before.length).toBeGreaterThan(0);
	});

	it("joins producer writes through a conditional record alias", () => {
		const out = records(
			`function make(flag){const value=flag?{n:1}:{n:2};value.n='changed';return value;}globalThis.result=make(globalThis.flag);`,
		);
		expect(out.fields("make")).toEqual({
			n: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		});
	});

	it.each(["make(input)", "new make(input)", "new make(...[input])"])(
		"projects producer writes across %s completions",
		(call) => {
			const out = records(
				`function make(input){const record={n:0};record.n=+input;return record;}function read(input){return ${call}.n;}globalThis.result=read(globalThis.input);`,
			);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(
				COMPILER_VALUE_KIND_NUMBER,
			);
		},
	);
	it.each([
		["record.value=2;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=+replacement;", COMPILER_VALUE_KIND_NUMBER],
		[
			"if(flag)record.value=2;else record.value='text';",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		[
			"record['value']=!!replacement;",
			COMPILER_VALUE_KIND_BOOLEAN,
		],
		[
			"if(flag)record['value']=!!replacement;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
		],
		["while(flag-- > 0)record.value=record.value+1;", COMPILER_VALUE_KIND_NUMBER],
		["record.value=globalThis.input;", COMPILER_VALUE_KIND_TOP],
		["record.missing=2;record.value=3;", COMPILER_VALUE_KIND_TOP],
		["globalThis.observe(record);record.value=2;", COMPILER_VALUE_KIND_TOP],
		["record.value=globalThis.replace(record);", COMPILER_VALUE_KIND_TOP],
	] as const)(
		"joins reaching field writes and retains barriers for %s",
		(body, expected) => {
			const out = records(
				`function make(){return {value:1};}function read(flag,replacement){const record=make();${body}return record.value;}globalThis.result=read(globalThis.flag,globalThis.input);`,
			);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(expected);
		},
	);

	it("does not revive a record whose initial field has no normal completion", () => {
		const out = records(
			`function never(){return never();}function make(){return {value:never()};}function read(){const record=make();record.value=2;return record.value;}globalThis.result=read();`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
	});

	it("propagates changed field writers through cached callers and retains prior snapshots", () => {
		const out = records(
			`function make(){return {value:1};}function read(flag){const record=make();if(flag)record.value=2;return record.value;}function forward(flag){return read(flag);}globalThis.result=forward(globalThis.flag);globalThis.marker="changed";`,
		);
		const before = out.read();
		const reader = out.named("read");
		const writer = coreOperations(reader).find(
			({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 2,
		)!;
		const stringIndex = out.program.stringConstants.findIndex(
			(_, index) => out.program.stringConstantText(index) === "changed",
		);
		for (const widened of [true, false]) {
			const editor = CoreEditor.open(out.program, reader.id);
			editor.replaceInstruction(
				writer.id,
				widened ? "createString" : "createNumber",
				[],
				{
					attributes: widened ? { stringIndex } : { value: 2 },
				},
			);
			editor.commit();
			const after = out.read();
			for (const name of ["read", "forward"])
				expect(after.summary(out.named(name).id).returnKind).toBe(
					widened
						? COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING
						: COMPILER_VALUE_KIND_NUMBER,
				);
		}
		expect(before.summary(reader.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

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
		`const value={n:1};globalThis.observe(value);return value;`,
		`return {get n(){return 1;}};`,
		`return {[globalThis.key]:1};`,
		`return {...globalThis.input};`,
		`return globalThis.value;`,
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
