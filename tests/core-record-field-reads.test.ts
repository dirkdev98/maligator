import { describe, expect, it } from "vitest";
import { runtimeGapBuildConfig } from "../scripts/runtime-gap-build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { cloneCoreFunction } from "../src/compiler/core/core-function-clone.ts";
import { CORE_RECORD_FIELD_KIND_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	CORE_RECORD_OWN_DATA_EFFECT_FACT,
	coreRecordFieldReads,
	coreRecordFieldStores,
} from "../src/compiler/core/core-record-value-kinds.ts";
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
	it.each(["right.n='changed';", "if(input)right.n='first';else right.n='second';"])(
		"projects surviving initializer sources through a merged read (%s)",
		(write) => {
			const out = flow(
				`function known(){return {n:'initial'};}function unknown(n){return {n};}function read(input){const left=known();const right=unknown(input);${write}const selected=input?left:right;return selected.n;}globalThis.result=read(globalThis.input);`,
			);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(
				COMPILER_VALUE_KIND_STRING,
			);
		},
	);
	it("withdraws a projected initializer bound when the other source's writer is removed", () => {
		const out = flow(
			`function known(){return {n:1};}function unknown(n){return {n};}function read(n){const left=known();const right=unknown(n);right.n=2;return(n?left:right).n;}globalThis.result=read(globalThis.input);`,
		);
		const fn = out.named("read");
		const before = out.read();
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
		const edit = CoreEditor.open(out.program, fn.id);
		edit.removeInstruction(
			coreOperations(fn).find((op) => op.opcode === "storeProperty")!.id,
		);
		edit.commit();
		expect(out.read().summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it("keeps projected recursive producer cycles empty", () => {
		const out = flow(
			`function make(){return make();}function read(flag){const left=make();const right=make();right.n=1;return(flag?left:right).n;}globalThis.result=read(globalThis.input);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
	});
	it("withdraws a published definite-write kind when the writer is removed", () => {
		const out = flow(
			`function make(n){return {n};}function read(n){const value=make(n);value.n='changed';return value.n;}globalThis.result=read(globalThis.input);`,
		);
		const fn = out.named("read");
		const [read] = coreRecordFieldReads(fn, () =>
			buildCoreControlFlow(out.program, fn.id),
		).keys();
		if (read === undefined) throw new Error("Missing record field read");
		const store = coreOperations(fn).find((op) => op.opcode === "storeProperty")!;
		const publish = CoreEditor.open(out.program, fn.id);
		publish.setNormalResultFacts(read, { mask: COMPILER_VALUE_KIND_STRING });
		publish.commit();
		const before = out.read();
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_STRING);
		const edit = CoreEditor.open(out.program, fn.id);
		edit.removeInstruction(store.id);
		edit.commit();
		expect(out.read().summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		expect(before.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_STRING);
	});
	it.each([
		"value.n='changed';return value.n;",
		"value.n=1;value.n='changed';return value.n;",
		"if(input)value.n='left';else value.n='right';return value.n;",
		"const alias=input?value:make(input);alias.n='changed';return alias.n;",
		"let n='fallback';for(let i=0;i<3;i++){const local=make(input);local.n='changed';n=local.n;observe(local);}return n;",
	])("uses only reaching values after definite own writes (%s)", (reader) => {
		expect(readKind("return {n:input};", reader)).toBe(COMPILER_VALUE_KIND_STRING);
	});
	it("does not kill a selected record's initializer with another alias's write", () => {
		expect(
			readKind(
				"return {n:1};",
				"const other=make(input);const alias=input?value:other;value.n='changed';return alias.n;",
			),
		).toBe(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING);
	});
	it.each(["return never();", "return {n:never()};"])(
		"does not seed a definite overwrite before its producer completes (%s)",
		(producer) => {
			const out = flow(
				`function never(){return never();}function make(){${producer}}function read(){const record=make();record.n=1;return record.n;}globalThis.result=read();`,
			);
			expect(out.read().summary(out.named("read").id).returnKind).toBe(0);
		},
	);
	it("indexes write-only merged stores at their escape boundary", () => {
		const out = flow(
			`function make(input){return {n:input};}function write(input,flag,observe){const value=flag?make(input):make(input);value.n=input;observe(value);value.n=flag;return value;}globalThis.write=write;`,
		);
		const fn = out.named("write");
		const stores = coreOperations(fn).filter(({ opcode }) => opcode === "storeProperty");
		expect(stores).toHaveLength(2);
		const indexed = coreRecordFieldStores(fn, () =>
			buildCoreControlFlow(out.program, fn.id),
		);
		expect(indexed.has(stores[0]!.id)).toBe(true);
		expect(indexed.has(stores[1]!.id)).toBe(false);
		expect(
			coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).size,
		).toBe(0);
	});

	it("withdraws cached store prefixes during open edits", () => {
		const out = flow(
			`function make(){return {n:1};}function write(input){const value=make();value.n=input;return value;}globalThis.write=write;`,
		);
		const fn = out.named("write");
		const read = () =>
			coreRecordFieldStores(fn, () => buildCoreControlFlow(out.program, fn.id));
		const [store] = read().keys();
		if (store === undefined) throw new Error("Missing private record store");
		const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(store));
		const editor = CoreEditor.open(out.program, fn.id);
		const coercion = editor.insertInstruction(
			fn.instructionBlock(store),
			store,
			"unary",
			[receiver],
			{
				attributes: { operator: "+" },
			},
		);
		expect(read().size).toBe(0);
		editor.commit();
		expect(read().size).toBe(0);
		const restore = CoreEditor.open(out.program, fn.id);
		restore.removeInstruction(coercion.instruction);
		expect(read().size).toBe(1);
		restore.commit();
		expect(read().size).toBe(1);
	});

	it("drops scoped store proofs when cloning and rejects lost write effects", () => {
		const out = flow(
			`function make(){return {n:1};}function write(input){const value=make();value.n=input;return value;}globalThis.write=write;`,
		);
		const fn = out.named("write");
		const store = coreOperations(fn).find(({ opcode }) => opcode === "storeProperty")!;
		const access = coreRecordFieldStores(fn, () =>
			buildCoreControlFlow(out.program, fn.id),
		).get(store.id)!;
		const effects = { ...CORE_NO_EFFECTS, writes: ["object-property"] as const };
		const editor = CoreEditor.open(out.program, fn.id);
		editor.replaceInstruction(
			store.id,
			"storePropertyStatic",
			[store.inputs[0]!, store.inputs[2]!],
			{
				attributes: { stringIndex: access.key },
			},
		);
		const proof = editor.addFact({
			kind: CORE_RECORD_OWN_DATA_EFFECT_FACT,
			value: access.key,
			claims: [{ kind: "effect", instruction: store.id, effects }],
			validity: { kind: "summary", digest: "own-store" },
			obligations: [],
			origin: "test",
		});
		editor.setInstructionEffectRefinement(store.id, { effects, proof });
		editor.setKnownOwnDataHint(store.id, true);
		editor.commit();
		verifyCoreProgram(out.program, undefined, programAnalysisContext());
		const cloned = out.program.function(cloneCoreFunction(out.program, fn));
		const copy = coreOperations(cloned).find(
			({ opcode }) => opcode === "storePropertyStatic",
		)!;
		expect(copy.attributes.knownOwnData).toBeUndefined();
		expect(cloned.instructionEffectRefinement(copy.id)).toBeUndefined();
		verifyCoreProgram(out.program, undefined, programAnalysisContext());
		const invalid = CoreEditor.open(out.program, fn.id);
		invalid.setInstructionEffectRefinement(store.id, { effects: CORE_NO_EFFECTS, proof });
		invalid.commit();
		expect(() =>
			verifyCoreProgram(out.program, undefined, programAnalysisContext()),
		).toThrow(/Invalid known own-data access proof/);
	});

	it.each([
		"const n=alias.n;observe(alias);return n;",
		"const n=alias.n;alias.n='changed';return n;",
		"const n=alias.n;alias.missing;return n;",
		"if(input){observe(alias);return 0;}return alias.n;",
	])("keeps a merged field proof before later effects (%s)", (reader) => {
		expect(
			readKind("return {n:1};", `const alias=input?value:make(input);${reader}`),
		).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it("starts a new merged record lifetime on each loop iteration", () => {
		expect(
			readKind(
				"return {n:1};",
				"let saved=0;for(let i=0;i<3;i++){const alias=input?make(i):make(i+1);saved=alias.n;observe(alias);}return saved;",
			),
		).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it("joins a later own write only when a backedge reaches the same allocation", () => {
		expect(
			readKind(
				"return {n:1};",
				"const alias=input?value:make(input);let saved=0;for(let i=0;i<3;i++){saved=alias.n;alias.n='changed';}return saved;",
			),
		).toBe(COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING);
	});
	it.each([
		"observe(value);const second=make(input);const alias=input?value:second;return alias.n;",
		"const alias=input?value:make(input);let saved;for(let i=0;i<3;i++){saved=alias.n;observe(alias);}return saved;",
		"const alias=input?value:make(input);alias.missing;return alias.n;",
	])("retains merged barriers within the observed lifetime (%s)", (reader) => {
		expect(readKind("return {n:1};", reader)).toBe(COMPILER_VALUE_KIND_TOP);
	});
	it("keeps private records through a wide fallthrough switch", () => {
		const cases = Array.from(
			{ length: 20 },
			(_, index) => `case ${index}:alias.n=alias.n+1;`,
		).join("");
		expect(
			readKind(
				"return {n:+input};",
				`const second=make(input);let alias=value;switch(input){case -1:alias=second;${cases}default:break;}return alias.n;`,
			),
		).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it.each([
		["return alias.n;", COMPILER_VALUE_KIND_NUMBER],
		[
			"if(input)alias.n='changed';return alias.n;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
	])("joins private producer aliases and every own writer (%s)", (reader, expected) => {
		expect(
			readKind(
				"return {n:+input};",
				`const second=make(input);const alias=input?value:second;${reader}`,
			),
		).toBe(expected);
	});
	it.each([
		"const alias=input?value:input;return alias.n;",
		"const second=make(input);observe(value);const alias=input?value:second;return alias.n;",
		"const second=make(input);const alias=input?value:second;delete alias.n;return alias.n;",
	])("keeps unsafe merged sources outside the field contract (%s)", (reader) => {
		expect(readKind("return {n:1};", reader)).toBe(COMPILER_VALUE_KIND_TOP);
	});
	it("closes a recursive producer's field feedback through merged aliases", () => {
		const out = flow(
			`function make(input,depth){if(depth>0){const left=make(input,depth-1);const right=make(input,depth-2);const alias=input?left:right;alias.n=alias.n+1;return alias;}return {n:input|0,stable:input&15};}function read(input,depth){return make(input,depth).n;}globalThis.result=read(globalThis.input,globalThis.depth);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		expect(
			out
				.read()
				.summary(out.named("make").id)
				.returnRecord?.map(({ mask }) => mask),
		).toEqual([COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_NUMBER]);
	});
	it("does not seed a merged recursive contract from its writes alone", () => {
		const out = flow(
			`function make(input){const left=make(input);const right=make(input);const alias=input?left:right;alias.n=1;return alias;}globalThis.result=make(globalThis.input);`,
		);
		expect(out.read().summary(out.named("make").id).returnRecord ?? null).toBeNull();
	});
	it("withdraws a merged read when one source loses an own key", () => {
		const out = flow(
			`function left(){return {n:1};}function right(){return {n:2};}function read(flag){const a=left();const b=right();const alias=flag?a:b;return alias.n;}globalThis.result=read(globalThis.flag);`,
		);
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		const right = out.named("right");
		const allocation = coreOperations(right).find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		const editor = CoreEditor.open(out.program, right.id);
		const key = editor.appendStringConstants([[111, 116, 104, 101, 114]]);
		editor.replaceInstruction(allocation.id, allocation.opcode, allocation.inputs, {
			attributes: { ...allocation.attributes, keyStringIndices: [key] },
		});
		editor.commit();
		expect(out.read().summary(out.named("read").id).returnKind).toBe(
			COMPILER_VALUE_KIND_TOP,
		);
		const fresh = new CoreAnalysisManager(
			out.program,
			out.context,
			new CoreOptimizationReportBuilder(out.program),
		);
		expect(
			fresh
				.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
				.kinds.summary(out.named("read").id).returnKind,
		).toBe(COMPILER_VALUE_KIND_TOP);
	});

	it("keeps repeated reads of one private field independent of CFG construction", () => {
		const out = flow(
			"function make(){return {n:1};}function read(){const r=make();return r.n+r.n;}globalThis.result=read();",
		);
		let requested = false;
		const reads = coreRecordFieldReads(out.named("read"), () => {
			requested = true;
			throw new Error("Unexpected CFG demand");
		});
		expect(reads.size).toBe(2);
		expect(requested).toBe(false);
	});
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
		"const n=value.n;value.n='changed';return n;",
		"const n=value.n;observe(value);return n;",
		"const n=value.n;value.missing;return n;",
		"value.tag='changed';observe();return value.n;",
		"if(input){observe(value);return 0;}return value.n;",
		"for(let i=0;i<3;i++){value.tag=i;}return value.n;",
	])("keeps the initial field proof at a read unaffected by %s", (reader) => {
		expect(readKind("return {n:1,tag:0};", reader)).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it.each([
		"value.missing=1;return value.n;",
		"for(let i=0;i<2;i++){const n=value.n;observe(value);if(i)return n;}return 0;",
	])(
		"keeps possible setters and backedge mutations outside initial facts (%s)",
		(reader) => {
			expect(readKind("return {n:1,tag:0};", reader)).toBe(COMPILER_VALUE_KIND_TOP);
		},
	);
	it.each([
		[
			"if(input)value.n='changed';return value.n;",
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
		],
		['value.n="changed";return value.n;', COMPILER_VALUE_KIND_STRING],
		['const alias=value;alias.n="changed";return value.n;', COMPILER_VALUE_KIND_STRING],
	] as const)(
		"joins reaching own writes without inventing other kinds (%s)",
		(reader, expected) => {
			expect(readKind("return {n:1};", reader)).toBe(expected);
		},
	);

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
		const [read] = [
			...coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).keys(),
		];
		expect(read).toBeDefined();
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(read!));
		expect(() => out.read().values(fn.id).latticeMask(value)).toThrow(
			"Unrequested program value kind",
		);
	});

	it("keeps unused written fields of opaque call results out of propagation demands", () => {
		const out = flow(
			`function read(){const value=globalThis.make();value.n=2;value.n;return 1;}globalThis.result=read();`,
		);
		const fn = out.named("read");
		const [read] = coreRecordFieldReads(fn, () =>
			buildCoreControlFlow(out.program, fn.id),
		).keys();
		expect(read).toBeDefined();
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(read!));
		expect(() => out.read().values(fn.id).latticeMask(value)).toThrow(
			"Unrequested program value kind",
		);
	});

	it.each([
		"return globalThis.input;",
		"return {other:1};",
		"return {get n(){return 1;}};",
		"return {n:never()};",
	])("does not demand unused written fields without a finite contract (%s)", (body) => {
		const out = flow(
			`function never(){return never();}function make(){${body}}function read(){const value=make();value.n=2;value.n;return 1;}globalThis.result=read();`,
		);
		const fn = out.named("read");
		const [read] = coreRecordFieldReads(fn, () =>
			buildCoreControlFlow(out.program, fn.id),
		).keys();
		expect(read).toBeDefined();
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(read!));
		expect(() => out.read().values(fn.id).latticeMask(value)).toThrow(
			"Unrequested program value kind",
		);
	});

	it.each(["n", "globalThis.input"])(
		"admits definite writes over an unknown %s initializer",
		(initial) => {
			const out = flow(
				`function make(n){return {n:${initial}};}function read(n){const value=make(n);value.n="changed";value.n;return 1;}globalThis.result=read(globalThis.input);`,
			);
			const fn = out.named("read");
			const [read] = coreRecordFieldReads(fn, () =>
				buildCoreControlFlow(out.program, fn.id),
			).keys();
			expect(read).toBeDefined();
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(read!));
			expect(out.read().values(fn.id).latticeMask(value)).toBe(
				COMPILER_VALUE_KIND_STRING,
			);
		},
	);

	it("withdraws a published write-backed field bound when its own key disappears", () => {
		const out = flow(
			`function make(){return {n:1};}function read(){const value=make();value.n=2;return value.n;}globalThis.result=read();`,
		);
		const reader = out.named("read");
		const [instruction] = coreRecordFieldReads(reader, () =>
			buildCoreControlFlow(out.program, reader.id),
		).keys();
		expect(instruction).toBeDefined();
		const publish = CoreEditor.open(out.program, reader.id);
		publish.setNormalResultFacts(instruction!, { mask: COMPILER_VALUE_KIND_NUMBER });
		publish.commit();
		const before = out.read();
		expect(before.summary(reader.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
		const producer = out.named("make");
		const allocation = coreOperations(producer).find(
			({ opcode }) => opcode === "createObjectShaped",
		)!;
		const edit = CoreEditor.open(out.program, producer.id);
		const key = edit.appendStringConstants([[111, 116, 104, 101, 114]]);
		edit.replaceInstruction(allocation.id, allocation.opcode, allocation.inputs, {
			attributes: { ...allocation.attributes, keyStringIndices: [key] },
		});
		edit.commit();
		expect(out.read().summary(reader.id).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		expect(before.summary(reader.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
	});

	it.each([
		"const value=make();return value.n;",
		"const value=globalThis.flag?make():make();const n=value.n;globalThis.observe(value);return n;",
	])(
		"withdraws and restores scoped reads during open and committed edits (%s)",
		(body) => {
			const out = flow(
				`function make(){return {n:1};}function read(){${body}}globalThis.result=read();`,
			);
			const fn = out.named("read");
			const before = coreRecordFieldReads(fn, () =>
				buildCoreControlFlow(out.program, fn.id),
			);
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
			expect(
				coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).size,
			).toBe(0);
			editor.commit();
			expect(
				coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).size,
			).toBe(0);
			expect(before.size).toBe(1);
			const restore = CoreEditor.open(out.program, fn.id);
			restore.removeInstruction(coercion.instruction);
			expect(
				coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).size,
			).toBe(1);
			restore.commit();
			expect(
				coreRecordFieldReads(fn, () => buildCoreControlFlow(out.program, fn.id)).size,
			).toBe(1);
		},
	);

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

	it("keeps a String field value read before its record mutates and escapes", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(flag,gate){for(let i=0;i<3;i++)gate(i);return {label:flag?"left":"right"};};function compute(flag,gate){const result=make(flag,gate);const label=result.label;result.label=0;gate(result);return label+":";}globalThis.compute=compute;`,
			"compute",
		);
		expect(
			out.core.some(
				(op) =>
					op.opcode === "loadPropertyStatic" &&
					op.attributes[CORE_RECORD_FIELD_KIND_ATTRIBUTE] === COMPILER_VALUE_KIND_STRING,
			),
		).toBe(true);
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
