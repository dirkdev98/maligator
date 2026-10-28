import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	coreRecordStorageWidthProofIsCurrent,
	analyzeCoreRecordStorageWidths,
} from "../src/compiler/core/core-record-storage-widths.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { parseModule, parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import {
	validateNativeDirectEntry,
	validateNativeRecordCalls,
} from "../src/compiler/target/program-image.ts";
import {
	emitCompiledFunction,
	directCompiledEntryKey,
} from "../src/compiler/target/render-native-c.ts";
import { verifyNativeExecutionProgram } from "../src/compiler/target/verify-native-execution.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";

function compile(source: string, script = false) {
	const path = script ? "/record-storage.js" : "/record-storage.mjs";
	const core = optimizeSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			path,
			script ? parseScript(source, { strict: false }) : parseModule(source),
		),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { eval: false, realms: false } }),
				),
				programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
			),
		},
		(_phase, run) => run(),
	);
	const manager = new CoreAnalysisManager(
		core.program,
		core.context,
		new CoreOptimizationReportBuilder(core.program),
	);
	const readValueKinds = () =>
		manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
	const widths = analyzeCoreRecordStorageWidths(
		core.program,
		manager,
		core.plan.directEntries,
	);
	const named = (name: string) => coreFunctionNamed(core.program, name)!;
	const result = (name: string) =>
		core.plan.directEntries.find(
			(entry) => entry.function === named(name).id && entry.resultFields !== undefined,
		)!;
	const parameter = (name: string) =>
		core.plan.directEntries.find(
			(entry) =>
				entry.function === named(name).id && entry.recordParameters !== undefined,
		)!;
	const resultWidths = (name: string) => {
		const entry = result(name);
		expect(entry).toBeDefined();
		return Object.fromEntries(
			entry.resultFields!.keys.map((key, field) => [
				core.program.stringConstantText(key),
				widths.result(entry)![field]!.representation,
			]),
		);
	};
	return { core, widths, named, result, parameter, resultWidths, readValueKinds };
}

const producer = `function make(value,flag){for(let i=0;i<3;i++)globalThis.gate(i);return {n:+value,s:"text",b:!!value};}`;
const run = (body: string) =>
	`${producer}function run(flag){let total=0;for(let i=0;i<4;i++){const record=make(i,flag);${body}}return total;}console.log(run(globalThis.flag));`;

const integerProducer = `function word(value){for(let i=0;i<3;i++)globalThis.gate(i);return {n:value|0,wide:value>>>0,small:value&255};}`;
const integerRun = (body: string) =>
	`${integerProducer}function run(value,flag){let total=0;for(let i=0;i<4;i++){const record=word(value+i);${body}}return total;}console.log(run(globalThis.input,globalThis.flag));`;

describe("record storage widths", () => {
	it.each([
		["value", "record.n=value&255;", "i32"],
		["value", "record.n=!!value;", "boolean"],
		["value", "record.n='final';", "string"],
		["'initial'", "if(flag)record.n=value&255;else record.n=value&15;", "i32"],
		["'initial'", "if(flag)record.n=value&255;", "boxed"],
		["value|0", "for(let i=0;i<3;i++)record.n=(record.n+1)|0;", "i32"],
	] as const)(
		"promotes producer fields from %s through %s into %s return storage",
		(initial, writes, representation) => {
			const out = compile(
				`function make(value,flag){for(let i=0;i<3;i++)globalThis.gate(i);const record={n:${initial}};${writes}globalThis.gate();return record;}function run(value,flag){let sum=0;for(let i=0;i<4;i++){const record=make(value+i,flag);sum+=record.n;}return sum;}console.log(run(globalThis.input,globalThis.flag));`,
			);
			expect(out.resultWidths("make")).toEqual({ n: representation });
			const fn = out.named("make");
			expect(
				[...fn.instructionIds()].some(
					(instruction) =>
						fn.instructionKind(instruction) === "operation" &&
						fn.instructionOpcodeName(instruction) === "storePropertyStatic",
				),
			).toBe(false);
		},
	);
	it("keeps simultaneously live producer records separate until their returns", () => {
		const out = compile(
			`function make(value,flag){for(let i=0;i<3;i++)globalThis.gate(i);const left={n:value&15};const right={n:value&255};left.n=left.n+1;right.n=right.n+2;globalThis.gate();if(flag)return left;return right;}function run(value,flag){let sum=0;for(let i=0;i<4;i++){const record=make(value+i,flag);sum+=record.n;}return sum;}console.log(run(globalThis.input,globalThis.flag));`,
		);
		const entry = out.result("make");
		expect(entry.resultFields!.allocations).toHaveLength(2);
		expect(out.widths.result(entry)![0]).toMatchObject({
			representation: "i32",
			integerRange: { minimum: 1, maximum: 257 },
		});
	});
	it("joins caller writes after promoting a producer's final Boolean field", () => {
		const out = compile(
			`function make(value){for(let i=0;i<3;i++)globalThis.gate(i);const record={n:value};record.n=!!value;globalThis.gate();return record;}function run(value,flag){let sum=0;for(let i=0;i<4;i++){const record=make(value);if(flag)record.n=value&255;sum+=record.n;}return sum;}console.log(run(globalThis.input,globalThis.flag));`,
		);
		expect(out.widths.result(out.result("make"))![0]).toMatchObject({
			kindMask: COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_NUMBER,
			representation: "boxed",
		});
		expect(
			out.readValueKinds().summary(out.named("make").id).returnRecord![0]!.mask,
		).toBe(COMPILER_VALUE_KIND_BOOLEAN);
	});
	it.each([
		"globalThis.observe(record);",
		"Object.defineProperty(record,'n',{get(){return value;}});",
		"try{record.n=globalThis.replacement();}catch(error){globalThis.gate(error);}",
	])(
		"keeps producer observations and protected writes outside SSA promotion (%s)",
		(observe) => {
			const out = compile(
				`function make(value){for(let i=0;i<3;i++)globalThis.gate(i);const record={n:value};record.n=1;${observe}return record;}function run(value){let sum=0;for(let i=0;i<4;i++)sum+=make(value).n;return sum;}console.log(run(globalThis.input));`,
			);
			expect(out.result("make")).toBeUndefined();
		},
	);
	it("keeps numeric, Boolean and String fields independent of producer effects", () => {
		const out = compile(run("total+=record.n+record.s.length+(record.b?1:0);"));
		expect(out.resultWidths("make")).toEqual({ n: "f64", s: "string", b: "boolean" });
	});

	it.each([
		['if(flag)record.n="changed";', "boxed"],
		["if(flag)record.n=globalThis.input;", "boxed"],
		["if(flag)record.n=+globalThis.input;", "f64"],
	])("joins every caller write in %s", (write, expected) => {
		const out = compile(run(`${write}total+=record.n+record.s.length+(record.b?1:0);`));
		expect(out.resultWidths("make")).toEqual({ n: expected, s: "string", b: "boolean" });
		const record = out.readValueKinds().summary(out.named("make").id).returnRecord!;
		expect(
			record.find((field) => out.core.program.stringConstantText(field.key) === "n")!
				.mask,
		).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

	it("preserves its proof across certified plan copies and rejects missing or forged widths", () => {
		const out = compile(run("total+=record.n;"));
		const selected = out.core.plan.recordStorageWidths!;
		expect(
			coreRecordStorageWidthProofIsCurrent(
				out.core.program,
				out.core.plan.directEntries,
				selected,
			),
		).toBe(true);
		expect(selected.result(out.result("make"))).toEqual(
			out.widths.result(out.result("make")),
		);
		expect(() =>
			verifyCoreOptimizationPlan(
				out.core.program,
				{ ...out.core.plan, recordStorageWidths: undefined },
				out.core.context,
			),
		).toThrow(/record storage widths have no current proof/);
		expect(() =>
			verifyCoreOptimizationPlan(
				out.core.program,
				{
					...out.core.plan,
					recordStorageWidths: {
						...selected,
						result: () => [
							{ kindMask: COMPILER_VALUE_KIND_NUMBER, representation: "f64" as const },
						],
					},
				},
				out.core.context,
			),
		).toThrow(/record storage widths have no current proof/);
	});

	it("retains a boxed field's complete kind union", () => {
		const out = compile(run("if(flag)record.n=true;total+=record.n;"));
		const entry = out.result("make");
		const index = entry.resultFields!.keys.findIndex(
			(key) => out.core.program.stringConstantText(key) === "n",
		);
		expect(out.widths.result(entry)![index]).toEqual({
			kindMask: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
			representation: "boxed",
		});
	});

	it("does not join unrelated producers that happen to have the same keys", () => {
		const out = compile(
			`${producer}function text(value){for(let i=0;i<3;i++)globalThis.gate(i);return {n:"text",s:"other",b:!!value};}function run(flag){let total=0;for(let i=0;i<4;i++){const left=make(i,flag);const right=text(i);total+=left.n+right.n.length;}return total;}console.log(run(globalThis.flag));`,
		);
		expect(out.resultWidths("make").n).toBe("f64");
		expect(out.resultWidths("text").n).toBe("string");
	});

	it("joins a borrowed parameter's writes into its producer's storage", () => {
		const out = compile(
			`${producer}function edit(record,flag){for(let i=0;i<3;i++)if(flag)record.n="changed";return record.n;}function run(flag){let total=0;for(let i=0;i<4;i++){const record=make(i,flag);total+=edit(record,flag);total+=record.n;}return total;}console.log(run(globalThis.flag));`,
		);
		const entry = out.parameter("edit");
		expect(entry).toBeDefined();
		const parameter = entry.recordParameters![0]!;
		expect(out.resultWidths("make")).toEqual({ n: "boxed", s: "string", b: "boolean" });
		expect(out.widths.parameter(entry, parameter.index)).toEqual(
			out.widths.result(out.result("make")),
		);
	});

	it("joins one caller-owned literal shared by multiple parameter entries", () => {
		const out = compile(
			`function edit(record,flag){for(let i=0;i<3;i++)if(flag)record.n="changed";return record.n;}function read(record){let total=0;for(let i=0;i<3;i++)total+=record.n;return total;}function run(flag){let total=0;for(let i=0;i<4;i++){const record={n:i,b:!!flag};total+=read(record);total+=edit(record,flag);}return total;}console.log(run(globalThis.flag));`,
		);
		const edited = out.parameter("edit");
		const reader = out.parameter("read");
		expect(edited).toBeDefined();
		expect(reader).toBeDefined();
		const object = edited.callSites[0]!.recordObjects![0]!;
		expect(out.widths.parameter(edited, 0)?.map((field) => field.representation)).toEqual(
			["boxed", "boolean"],
		);
		expect(out.widths.parameter(reader, 0)?.map((field) => field.representation)).toEqual(
			["boxed", "boolean"],
		);
		expect(
			out.widths
				.object(edited.callSites[0]!.caller, object.allocation)
				?.map((field) => field.representation),
		).toEqual(["boxed", "boolean"]);
	});

	it("propagates storage widening through selected record forwards", () => {
		const out = compile(
			`function leaf(value){let n=+value;while(n<3)n++;return {n};}function forward(value){let n=+value;while(n<2)n++;return leaf(n);}function direct(value){return leaf(value).n;}function run(flag){let total=0;for(let i=0;i<4;i++){const record=forward(i);if(flag)record.n="changed";total+=record.n;}return total;}console.log(run(globalThis.flag),direct(globalThis.value));`,
		);
		expect(out.result("forward").callOverrides?.length).toBeGreaterThan(0);
		expect(out.resultWidths("forward")).toEqual({ n: "boxed" });
		expect(out.resultWidths("leaf")).toEqual({ n: "boxed" });
	});

	it("reuses the return summary when a forwarded leaf has no selected record entry", () => {
		const out = compile(
			`function leaf(value){for(let i=0;i<3;i++)globalThis.gate(i);return {n:value};}function forward(value){let n=+value;while(n<3)n++;return leaf(n);}function run(value){let total=0;for(let i=0;i<4;i++){const record=forward(value);total+=record.n;}return total;}console.log(run(globalThis.input),leaf("text"));`,
		);
		const entry = out.result("forward");
		expect(entry.resultFields!.forwards).toBeDefined();
		expect(entry.callOverrides).toBeUndefined();
		expect(out.widths.result(entry)).toEqual([
			{
				kindMask: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
				representation: "boxed",
			},
		]);
		expect(
			out
				.readValueKinds()
				.summary(out.named("leaf").id)
				.returnRecord!.find(
					(field) => out.core.program.stringConstantText(field.key) === "n",
				)!.mask,
		).toBe(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING);
	});

	it.each([false, true])(
		"preserves receiver normalization for a forwarded literal in script mode %s",
		(script) => {
			const out = compile(
				`const leaf=function leaf(value){for(let i=0;i<3;i++)globalThis.gate(i);return {n:this};};const forward=function forward(value){let n=+value;while(n<3)n++;return leaf(n);};function run(value){let total=0;for(let i=0;i<4;i++){const record=forward(value);total+=record.n;}return total;}console.log(run(globalThis.input));`,
				script,
			);
			const entry = out.result("forward");
			expect(entry.resultFields!.forwards).toBeDefined();
			expect(out.widths.result(entry)).toEqual([
				{
					kindMask: script ? COMPILER_VALUE_KIND_OBJECT : COMPILER_VALUE_KIND_UNDEFINED,
					representation: "boxed",
				},
			]);
		},
	);

	it("keeps absent union fields boxed while selecting a common numeric tag", () => {
		const out = compile(
			`function decode(value,flag){let n=+value;while(n<3)n++;if(flag)return {tag:0,a:n};return {tag:1,b:!!value};}function run(flag){let total=0;for(let i=0;i<4;i++){const record=decode(i,flag);total+=record.tag+(record.a===undefined?1:record.a);}return total;}console.log(run(globalThis.flag));`,
		);
		expect(out.result("decode").resultFields!.shapes).toBeDefined();
		expect(out.resultWidths("decode")).toEqual({ tag: "i32", a: "boxed", b: "boxed" });
	});

	it("retains signed, unsigned and masked bounds independently of producer effects", () => {
		const out = compile(integerRun("total+=record.n+record.wide+record.small;"));
		const entry = out.result("word");
		expect(out.widths.result(entry)).toEqual([
			{
				kindMask: COMPILER_VALUE_KIND_NUMBER,
				representation: "i32",
				integerRange: COMPILER_INT32_RANGE,
			},
			{
				kindMask: COMPILER_VALUE_KIND_NUMBER,
				representation: "f64",
				integerRange: COMPILER_UINT32_RANGE,
			},
			{
				kindMask: COMPILER_VALUE_KIND_NUMBER,
				representation: "i32",
				integerRange: {
					minimum: 0,
					maximum: 255,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				},
			},
		]);
	});

	it.each(["-0", "0/0", "1/0", "1.5", "+globalThis.replacement"])(
		"keeps Number storage wide after a %s write",
		(value) => {
			const out = compile(
				integerRun(`if(flag)record.n=${value};total+=record.n+record.small;`),
			);
			expect(out.widths.result(out.result("word"))![0]).toEqual({
				kindMask: COMPILER_VALUE_KIND_NUMBER,
				representation: "f64",
			});
		},
	);

	it("retains a wide integer union while widening its physical storage", () => {
		const out = compile(integerRun("if(flag)record.n=2147483648;total+=record.n;"));
		expect(out.widths.result(out.result("word"))![0]).toEqual({
			kindMask: COMPILER_VALUE_KIND_NUMBER,
			representation: "f64",
			integerRange: { ...COMPILER_INT32_RANGE, maximum: 2147483648 },
		});
	});

	it("shares every borrowed writer's integer range with its producer", () => {
		const out = compile(
			`${integerProducer}function edit(record,value){for(let i=0;i<3;i++)record.n=value|0;return record.n+record.small;}function run(value){let total=0;for(let i=0;i<4;i++){const record=word(i);total+=edit(record,value);total+=record.n;}return total;}console.log(run(globalThis.input));`,
		);
		const producer = out.widths.result(out.result("word"))!;
		const entry = out.parameter("edit");
		expect(entry).toBeDefined();
		expect(out.widths.parameter(entry, 0)).toEqual(producer);
		expect(producer[0]!.representation).toBe("i32");
	});

	it("propagates integer ranges through an ordinary literal forward", () => {
		const out = compile(
			`function leaf(value){for(let i=0;i<3;i++)globalThis.gate(i);return {n:value&255};}function forward(value){let n=+value;while(n<3)n++;return leaf(n);}function run(value){let total=0;for(let i=0;i<4;i++){const record=forward(value);total+=record.n;}return total;}console.log(run(globalThis.input),leaf("text"));`,
		);
		const entry = out.result("forward");
		expect(entry.resultFields!.forwards).toBeDefined();
		expect(out.widths.result(entry)![0]).toMatchObject({
			representation: "i32",
			integerRange: { minimum: 0, maximum: 255 },
		});
	});

	it("keeps a non-record fallback separate from the fresh record's storage", () => {
		const out = compile(
			`function optional(value,flag){let n=+value;while(n<3)n++;if(flag)return globalThis.other;return {n};}function run(flag){let total=0;for(let i=0;i<4;i++){const record=optional(i,flag);total+=record.n;}return total;}console.log(run(globalThis.flag));`,
		);
		expect(out.result("optional").resultFields!.escapes).toBe(true);
		expect(out.resultWidths("optional")).toEqual({ n: "f64" });
	});
});

function nativeImage(source: string) {
	const { core } = compile(source);
	const image = lowerNativeStorage(
		lowerExecutionToProgramImage(
			lowerCoreCompilationToExecution(core, { reuseRegisters: true }),
			lowerCoreCompilationToNativeProgram(core),
			false,
		),
		"precise",
	);
	const named = (name: string) =>
		image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === name,
		)!;
	return { image, named };
}

describe("record storage C ABI", () => {
	it.each([
		[
			"initializer",
			"const record={n:held,extra:hook()};record.n=1;",
			"incomingRootRegisters",
		],
		[
			"RHS",
			"const record={n:0};record.n=(hook(),held);record.n=1;",
			"incomingRootRegisters",
		],
		[
			"old occupant",
			"const record={n:0};record.n=held;record.n=(hook(held),1);",
			"outgoingRootRegisters",
		],
	] as const)(
		"retains the %s lifetime at a removed aggregate use",
		(_name, body, roots) => {
			const { named } = nativeImage(
				`function make(held,hook){${body}return record;}globalThis.make=make;console.log(make(globalThis.held,globalThis.hook).n);`,
			);
			const fn = named("make");
			const callIp = fn.body.instructions.findIndex((op) => op.opcode === "CALL");
			expect(callIp).toBeGreaterThanOrEqual(0);
			expect(
				fn.body.instructions.some((op) => op.opcode === "STORE_PROPERTY_STATIC"),
			).toBe(false);
			expect(
				fn.gc.safepoints.find((point) => point.instructionIp === callIp)![roots],
			).toContain(0);
		},
	);
	const borrowed = `${producer}function edit(record,flag){for(let i=0;i<3;i++)if(flag)record.n=+globalThis.input;return record.n+record.s.length+(record.b?1:0);}function run(flag){let total=0;for(let i=0;i<4;i++){const record=make(i,flag);total+=edit(record,flag);total+=record.n;}return total;}console.log(run(globalThis.flag));`;

	it("uses matching typed pointers for results, borrows and scalar field reads", () => {
		const { image, named } = nativeImage(borrowed);
		const result = named("make").directEntries.find(
			(entry) => entry.resultFields,
		)!.resultFields!;
		const parameter = named("edit").directEntries.find((entry) => entry.recordParameters)!
			.recordParameters![0]!;
		expect(result.storage.map((field) => field.representation)).toEqual([
			"number",
			"string",
			"boolean",
		]);
		expect(parameter.storage).toEqual(result.storage);
		const source = emitProgramImage(image, { compiled: true });
		for (const declaration of [
			"double *rf0",
			"MalValue *rf1",
			"bool *rf2",
			"double *rp0_0",
			"MalValue *rp0_1",
			"bool *rp0_2",
		])
			expect(source).toContain(declaration);
		expect(source).toMatch(/double __record_call_\d+_0 = 0.0;/);
		expect(source).toMatch(/bool __record_call_\d+_2 = false;/);
		expect(source).not.toMatch(/mal_ops_number_as_f64\(__record_call_/);
		expect(source).not.toMatch(/mal_value_to_boolean\(__record_call_/);
		expect(source).toContain("MalValue *rp0_3");
		expect(source).not.toContain("MalValue *rp0_4");
		const split = emitProgramTranslationUnits(image, { compiled: true });
		expect(split.map((unit) => unit.source).join("\n")).toContain("double *rp0_0");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image)).native).toEqual(
			image.native,
		);
	});

	it("keeps producer storage for observing parameters in the native integration fixture", () => {
		const image = lowerNativeStorage(
			compileEntrypoint(
				new URL("./local/record-result-entries.mjs", import.meta.url).pathname,
				{
					buildConfig: resolveBuildConfig({ engine: { realms: true } }),
					stripTypes: stripCompactTypes,
				},
			),
			"precise",
		);
		const entries = new Map(
			image.native.functions.flatMap((fn) =>
				fn.directEntries.map(
					(entry) => [directCompiledEntryKey(fn.functionIndex, entry.id), entry] as const,
				),
			),
		);
		for (const [name, observed, pointers] of [
			["hold", true, 5],
			["stretch", false, 4],
			["updateBundle", false, 4],
			["decodedWeight", false, 5],
		] as const) {
			const fn = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === name,
			)!;
			const entry = fn.directEntries.find((entry) => entry.recordParameters)!;
			const parameter = entry.recordParameters![0]!;
			expect(parameter.observerIps.length > 0).toBe(observed);
			const emitted = emitCompiledFunction(
				fn,
				fn.functionIndex,
				"",
				false,
				"static",
				new Set(),
				[],
				entries,
				false,
				new Set(),
				image.runtime.stringConstants,
			)!;
			const abi = emitted.directEntries.find((candidate) => candidate.id === entry.id)!
				.recordParameters![0]!;
			expect(abi.representations).toHaveLength(pointers);
			if (name === "hold") {
				const shaped = {
					...entry,
					recordParameters: [{ ...parameter, shapes: [[0, 1, 2]] }],
				};
				const shapedFunction = {
					...fn,
					directEntries: fn.directEntries.map((candidate) =>
						candidate === entry ? shaped : candidate,
					),
				};
				const shapedC = emitCompiledFunction(
					shapedFunction,
					fn.functionIndex,
					"",
					false,
					"static",
					new Set(),
					[],
					entries,
					false,
					new Set(),
					image.runtime.stringConstants,
				)!.directEntries.find((candidate) => candidate.id === entry.id)!;
				expect(shapedC.recordParameters![0]!.representations).toHaveLength(6);
				expect(shapedC.source).toContain("i32 * rp0_3");
				expect(shapedC.source).not.toContain("if ((*rp0_3)");
				expect(shapedC.source).not.toContain("mal_value_to_i32((*rp0_3))");
				expect(shapedC.source).toContain("mal_vm_materialize_record(vm, (*rp0_5)");
			}
		}
		const decoded = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "decode",
		)!;
		const result = decoded.directEntries.find((entry) => entry.resultFields)!;
		const output = emitCompiledFunction(
			decoded,
			decoded.functionIndex,
			"",
			false,
			"static",
			new Set(),
			[],
			entries,
			false,
			new Set(),
			image.runtime.stringConstants,
		)!.directEntries.find((entry) => entry.id === result.id)!;
		expect(output.resultFieldRepresentations!.at(-1)).toBe("int32");
		expect(output.source).toContain(`i32 * rf${result.resultFields!.keys.length}`);
		expect(output.source).not.toContain(
			`*rf${result.resultFields!.keys.length} = mal_value_from_i32(`,
		);
	});

	it("materializes before a borrowed call whose native entry was not emitted", () => {
		const { image, named } = nativeImage(borrowed);
		const entries = new Map(
			image.native.functions.flatMap((fn) =>
				fn.directEntries.map(
					(entry) => [directCompiledEntryKey(fn.functionIndex, entry.id), entry] as const,
				),
			),
		);
		const run = named("run");
		const emit = () =>
			emitCompiledFunction(
				run,
				run.functionIndex,
				"",
				false,
				"static",
				new Set(image.native.functions.map((fn) => fn.functionIndex)),
				[],
				entries,
				false,
				new Set(),
				image.runtime.stringConstants,
			)!;
		const before = emit();
		expect(before.source).not.toContain("mal_vm_materialize_record(");
		for (const entry of named("edit").directEntries)
			entries.delete(directCompiledEntryKey(named("edit").functionIndex, entry.id));
		expect(emit().source).toContain("mal_vm_materialize_record(");
	});

	it("uses proven int32 pointers and raw stores while retaining unsigned Number fields", () => {
		const { image, named } = nativeImage(
			integerRun("total+=record.n+record.wide+record.small;"),
		);
		const fields = named("word").directEntries.find((entry) => entry.resultFields)!
			.resultFields!.storage;
		expect(fields.map((field) => field.representation)).toEqual([
			"int32",
			"number",
			"int32",
		]);
		const source = emitProgramImage(image, { compiled: true });
		expect(source).toContain("i32 *rf0");
		expect(source).toContain("double *rf1");
		expect(source).toContain("i32 *rf2");
		expect(source).toMatch(/i32 __record_call_\d+_0 = 0;/);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image)).native).toEqual(
			image.native,
		);
		const entry = named("word").directEntries.find((entry) => entry.resultFields)!;
		for (const field of [
			{ ...fields[0]!, integerRange: undefined },
			{ ...fields[0]!, integerRange: COMPILER_UINT32_RANGE },
			{ ...fields[0]!, integerRange: { ...COMPILER_INT32_RANGE, minimum: -0 } },
		])
			expect(() =>
				validateNativeDirectEntry(named("word").body, {
					...entry,
					resultFields: { ...entry.resultFields!, storage: [field, ...fields.slice(1)] },
				}),
			).toThrow(/Invalid native record storage/);
	});

	it("retains boxed scalar unions outside GC roots while heap fields remain rooted", () => {
		const { image, named } = nativeImage(
			run("if(flag)record.n=true;total+=record.n+record.s.length;"),
		);
		const result = named("make").directEntries.find(
			(entry) => entry.resultFields,
		)!.resultFields!;
		expect(result.storage[0]).toEqual({
			kindMask: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
			representation: "boxed",
		});
		const source = emitProgramImage(image, { compiled: true });
		expect(source).toMatch(/MalValue __record_call_\d+_0 = MAL_VALUE_UNDEFINED;/);
		expect(source).not.toMatch(/__record_call_\d+_1/);
	});

	it("rejects invalid field widths and a borrow with incompatible storage", () => {
		const { image, named } = nativeImage(borrowed);
		const make = named("make");
		const entry = make.directEntries.find((entry) => entry.resultFields)!;
		for (const storage of [
			[],
			[
				{ kindMask: COMPILER_VALUE_KIND_STRING, representation: "number" as const },
				...entry.resultFields!.storage.slice(1),
			],
		])
			expect(() =>
				validateNativeDirectEntry(make.body, {
					...entry,
					resultFields: { ...entry.resultFields!, storage },
				}),
			).toThrow(/Invalid native record storage/);
		const edit = named("edit");
		const editEntry = edit.directEntries.find((entry) => entry.recordParameters)!;
		const changed = {
			...edit,
			directEntries: edit.directEntries.map((candidate) =>
				candidate !== editEntry
					? candidate
					: {
							...candidate,
							recordParameters: candidate.recordParameters!.map((parameter) => ({
								...parameter,
								storage: parameter.storage.map((field, index) =>
									index === 0
										? {
												kindMask: COMPILER_VALUE_KIND_BOOLEAN,
												representation: "boolean" as const,
											}
										: field,
								),
							})),
						},
			),
		};
		const functions = image.native.functions.map((fn) => (fn === edit ? changed : fn));
		expect(() =>
			validateNativeRecordCalls(named("run").body, named("run"), functions),
		).toThrow(/Invalid native record call/);
	});

	it("rejects malformed field widths before native image construction", () => {
		const { core } = compile(borrowed);
		const program = lowerCoreCompilationToNativeProgram(core);
		const functions = program.functions.map((fn) => ({
			...fn,
			directEntries: fn.directEntries.map((entry) =>
				entry.resultFields === undefined
					? entry
					: { ...entry, resultFields: { ...entry.resultFields, storage: [] } },
			),
		}));
		expect(() => verifyNativeExecutionProgram({ ...program, functions })).toThrow(
			/native record entry has invalid storage/,
		);
	});

	it("clones field storage when rebasing merged artifacts", () => {
		const { image } = nativeImage(integerRun("total+=record.n+record.small;"));
		const merged = mergeProgramImages([image, image]).image;
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(merged)).native).toEqual(
			merged.native,
		);
		const original = image.native.functions.flatMap((fn) =>
			fn.directEntries.flatMap((entry) => entry.resultFields?.storage ?? []),
		);
		const copied = merged.native.functions
			.slice(image.native.functions.length)
			.flatMap((fn) =>
				fn.directEntries.flatMap((entry) => entry.resultFields?.storage ?? []),
			);
		expect(copied).toEqual(original);
		for (const [index, field] of copied.entries())
			expect(field).not.toBe(original[index]);
	});
});
