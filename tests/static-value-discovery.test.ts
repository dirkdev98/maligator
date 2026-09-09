import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	CORE_STATIC_VALUE_ANALYSIS,
	CoreStaticValueAnalysis,
} from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import { scanLiteralTemplateSegment } from "../src/compiler/shared/literal-template-data.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const context: CoreCompilationContext = {
	facts: {
		...conservativeCompilerProgramFacts(),
		world: { ...conservativeCompilerProgramFacts().world, primordialPolicy: "locked" },
	},
	data: {
		entrypointPath: "static-values.js",
		moduleEvaluationOrder: [],
		sourceFiles: [],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

describe("static-value producer discovery", () => {
	it("represents explicit undefined separately from a literal hole", () => {
		const result = inspectStaticValueFunction(
			"function probe(x) { return [undefined, , 2].includes(x); } globalThis.probe = probe;",
			"probe",
		);
		expect(result.structure.pooledMaterializations).toBe(0);
		expect(scanLiteralTemplateSegment([8, 3, 11, 7, 3, 2], 0, "fixture").endOffset).toBe(
			6,
		);
	});
	it("keeps well-known, registered, and freshly allocated symbols distinct", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[105, 116, 101, 114, 97, 116, 111, 114], [102, 111, 114], [120]],
		});
		const builder = new CoreFunctionBuilder(program),
			entry = builder.createBlock();
		const [ctor] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Symbol" },
		});
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [name] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 2 },
		});
		const [wellKnown] = builder.appendInstruction(entry, "loadPropertyStatic", [ctor!], {
			attributes: { stringIndex: 0 },
		});
		const [registry] = builder.appendInstruction(entry, "loadPropertyStatic", [ctor!], {
			attributes: { stringIndex: 1 },
		});
		const [fresh] = builder.appendInstruction(entry, "call", [ctor!, receiver!, name!]);
		const [another] = builder.appendInstruction(entry, "call", [ctor!, receiver!, name!]);
		const [registered] = builder.appendInstruction(entry, "call", [
			registry!,
			ctor!,
			name!,
		]);
		const [again] = builder.appendInstruction(entry, "call", [registry!, ctor!, name!]);
		builder.setTerminator(entry, { kind: "return", value: fresh! });
		const fn = program.function(builder.finish(entry).function);
		const analysis = new CoreStaticValueAnalysis(
			program,
			fn,
			() => buildCoreControlFlow(program, fn.id),
			65536,
			context,
		);
		const values = [wellKnown!, fresh!, another!, registered!, again!].map((value) =>
			analysis.query(value),
		);
		for (const fact of values) {
			if (fact.kind !== "known") throw Error("Expected symbol fact");
			expect(fact.brand).toBe("symbol");
			analysis.verify(fact);
		}
		const identities = values.map((fact) =>
			fact.kind === "known" ? fact.identity : undefined,
		);
		expect(identities[0]).toEqual({ kind: "intrinsic", key: "%Symbol.iterator%" });
		expect(identities[1]).not.toEqual(identities[2]);
		expect(identities[3]).toEqual({ kind: "symbol-registry", key: "x" });
		expect(identities[3]).toEqual(identities[4]);
	});
});

it("discovers sparse initialization at the observation and preserves shared/cyclic SSA references", () => {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [array] = builder.appendInstruction(entry, "createArray", [], {
		attributes: { length: 1000000000 },
	});
	const [zero] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 0 },
	});
	const [one] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [undef] = builder.appendInstruction(entry, "createUndefined", []);
	builder.appendInstruction(entry, "defineProperty", [array!, zero!, undef!], {
		attributes: { enumerable: true },
	});
	builder.appendInstruction(entry, "defineProperty", [array!, one!, array!], {
		attributes: { enumerable: true },
	});
	builder.setTerminator(entry, { kind: "return", value: array! });
	const fn = program.function(builder.finish(entry).function);
	const analysis = new CoreStaticValueAnalysis(program, fn, () =>
		buildCoreControlFlow(program, fn.id),
	);
	const fact = analysis.queryAt(array!, fn.blockTerminator(entry));
	if (fact.kind !== "known") throw Error("Expected array fact");
	analysis.verify(fact, fn.blockTerminator(entry));
	expect(program.staticDescriptions.description(fact.description)).toMatchObject({
		kind: "array",
		length: 1000000000,
		ownKeysComplete: true,
		properties: [
			{ key: "0", descriptor: { kind: "data", value: { kind: "constant" } } },
			{ key: "1", descriptor: { kind: "data", value: { kind: "operand", index: 0 } } },
		],
	});
	expect(fact.operands).toEqual([array]);
	expect(analysis.statistics.visits).toBeLessThan(20);
});

it("retains descriptor kinds, duplicate-key updates, integer ordering and null prototypes", () => {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[122], [49, 48], [50]],
	});
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [object] = builder.appendInstruction(entry, "createObject", []);
	const [nil] = builder.appendInstruction(entry, "createNull", []);
	const [value] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 7 },
	});
	const [getter] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: 0 },
	});
	builder.appendInstruction(entry, "setPrototype", [object!, nil!]);
	for (let index = 0; index < 3; index++) {
		const [key] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: index },
		});
		builder.appendInstruction(entry, "defineProperty", [object!, key!, value!], {
			attributes: { enumerable: true },
		});
		if (index === 0)
			builder.appendInstruction(entry, "defineAccessor", [object!, key!, getter!], {
				attributes: { enumerable: true, kind: "get" },
			});
	}
	builder.setTerminator(entry, { kind: "return", value: object! });
	const fn = program.function(builder.finish(entry).function);
	const analysis = new CoreStaticValueAnalysis(program, fn, () =>
		buildCoreControlFlow(program, fn.id),
	);
	const fact = analysis.queryAt(object!, fn.blockTerminator(entry));
	if (fact.kind !== "known") throw Error("Expected object fact");
	analysis.verify(fact, fn.blockTerminator(entry));
	expect(program.staticDescriptions.description(fact.description)).toMatchObject({
		kind: "object",
		prototype: { kind: "null" },
		ownKeysComplete: true,
		properties: [
			{ key: "2", descriptor: { kind: "data" } },
			{ key: "10", descriptor: { kind: "data" } },
			{ key: "z", descriptor: { kind: "accessor" } },
		],
	});
});

it("invalidates escaped contents across unknown calls while retaining the allocation identity", () => {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [array] = builder.appendInstruction(entry, "createArray", [], {
		attributes: { length: 2 },
	});
	const [callback] = builder.appendInstruction(entry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	builder.appendInstruction(entry, "call", [callback!, array!]);
	builder.setTerminator(entry, { kind: "return", value: array! });
	const fn = program.function(builder.finish(entry).function);
	const analysis = new CoreStaticValueAnalysis(program, fn, () =>
		buildCoreControlFlow(program, fn.id),
	);
	const before = analysis.query(array!),
		after = analysis.queryAt(array!, fn.blockTerminator(entry));
	if (before.kind !== "known" || after.kind !== "known")
		throw Error("Expected allocation fact");
	expect(after.identity).toEqual(before.identity);
	expect(program.staticDescriptions.description(after.description)).toMatchObject({
		length: null,
		ownKeysComplete: false,
		prototype: { kind: "unknown" },
	});
});

it("folds initialized own reads and lengths without assuming inherited indexed misses", () => {
	const known = inspectStaticValueFunction(
		"function probe(x) { const a = [x, 20]; return a[1] + a.length; } globalThis.probe = probe;",
		"probe",
	);
	expect(known.structure.genericLookups).toBe(0);
	const hole = inspectStaticValueFunction(
		"function probe(x) { return [, x][0]; } globalThis.probe = probe;",
		"probe",
		{ locked: false },
	);
	expect(hole.structure.genericLookups).toBeGreaterThan(0);
	const missing = inspectStaticValueFunction(
		"function probe(x) { return [10, 20].includex(x()); } globalThis.probe = probe;",
		"probe",
	);
	expect(missing.structure.genericCalls).toBeGreaterThan(0);
});

it("retains exact constructor brands with dynamic contents and rejects mutable constructors", () => {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [ctor] = builder.appendInstruction(entry, "loadIntrinsic", [], {
		attributes: { intrinsic: "Map" },
	});
	const [entries] = builder.appendInstruction(entry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	const [map] = builder.appendInstruction(entry, "construct", [ctor!, entries!]);
	builder.setTerminator(entry, { kind: "return", value: map! });
	const fn = program.function(builder.finish(entry).function);
	const analysis = new CoreStaticValueAnalysis(
		program,
		fn,
		() => buildCoreControlFlow(program, fn.id),
		65536,
		context,
	);
	expect(analysis.queryAt(map!, fn.blockTerminator(entry))).toMatchObject({
		kind: "known",
		exactBrand: "Map",
		prototype: { kind: "intrinsic", id: "Map.prototype" },
	});
	const mutable = new CoreStaticValueAnalysis(program, fn, () =>
		buildCoreControlFlow(program, fn.id),
	);
	expect(mutable.query(map!)).toMatchObject({ kind: "unknown" });
});

it("forwards private local storage across unrelated writes", () => {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [array] = builder.appendInstruction(entry, "createArray", [], {
		attributes: { length: 8 },
	});
	builder.appendInstruction(entry, "storeLocal", [array!], { attributes: { index: 0 } });
	const [number] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 4 },
	});
	builder.appendInstruction(entry, "storeLocal", [number!], { attributes: { index: 1 } });
	const [alias] = builder.appendInstruction(entry, "loadLocal", [], {
		attributes: { index: 0 },
	});
	builder.setTerminator(entry, { kind: "return", value: alias! });
	const fn = program.function(builder.finish(entry).function);
	const analysis = new CoreStaticValueAnalysis(program, fn, () =>
		buildCoreControlFlow(program, fn.id),
	);
	const fact = analysis.queryAt(alias!, fn.blockTerminator(entry));
	expect(fact).toMatchObject({
		kind: "known",
		identity: { kind: "fresh-per-evaluation", value: array },
	});
	if (fact.kind !== "known") throw Error("Expected alias");
	expect(program.staticDescriptions.description(fact.description)).toMatchObject({
		length: 8,
	});
});

it("selects bounded dynamic own keys while retaining a coerced fallback for inherited keys", () => {
	for (const expression of ["[10,20][key]", "({a:1,b:2})[key]"]) {
		const result = inspectStaticValueFunction(
			`function probe(key) { return ${expression}; } globalThis.probe = probe;`,
			"probe",
		);
		expect(result.structure.coercions).toBeGreaterThan(0);
		expect(
			result.core.some(
				(operation) => operation.attributes.staticSelectionFallback === true,
			),
		).toBe(true);
	}
});

it("passes static contents to a non-inlined contains variant without allocating the argument", () => {
	const elements = Array.from({ length: 32 }, (_, index) => index).join(",");
	const inspected = inspectStaticValueFunction(
		`const contains = (xs,x) => xs.includes(x); function probe(x) { return contains([${elements}],x); } globalThis.probe=probe; globalThis.contains=contains;`,
		"probe",
		{ counters: true },
	);
	expect(inspected.structure.allocations).toBe(0);
	expect(inspected.core.some((operation) => operation.opcode === "call")).toBe(true);
	expect(
		inspected.image.runtime.functions.filter((fn) =>
			fn.instructions.some((instruction) => instruction.opcode === "CALL"),
		),
	).not.toHaveLength(0);
});

it("folds own-presence, descriptors, typeof and Array.isArray through shared facts", () => {
	const inspected = inspectStaticValueFunction(
		`function probe(x) { const a={a:x}; const d=Object.getOwnPropertyDescriptor(a,'a'); return Object.hasOwn(a,'a') && !Object.hasOwn(a,'b') && Reflect.has(a,'toString') && Array.isArray([x]) && typeof [x] === 'object' && d.value===x && d.writable; } globalThis.probe=probe;`,
		"probe",
	);
	expect(inspected.structure.genericCalls).toBe(0);
});

it.each(["Global", "Captured"] as const)(
	"forwards a proved private %s cell without changing its allocation token",
	(kind) => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program),
			entry = builder.createBlock();
		const [object] = builder.appendInstruction(entry, "createObject", []);
		const attributes = kind === "Global" ? { index: 0 } : { functionIndex: 0, index: 0 };
		builder.appendInstruction(entry, `store${kind}`, [object!], { attributes });
		const [alias] = builder.appendInstruction(entry, `load${kind}`, [], { attributes });
		builder.setTerminator(entry, { kind: "return", value: alias! });
		const fn = program.function(builder.finish(entry).function);
		const analysis = new CoreStaticValueAnalysis(program, fn, () =>
			buildCoreControlFlow(program, fn.id),
		);
		const fact = analysis.queryAt(alias!, fn.blockTerminator(entry));
		expect(fact).toMatchObject({
			kind: "known",
			identity: { kind: "fresh-per-evaluation", value: object },
		});
	},
);

it("reuses immutable private globals across helpers while leaving TDZ checks and the shared allocation intact", () => {
	const inspected = inspectStaticValueFunction(
		"const xs=[10,20]; const probe=()=>xs[0]+xs.length; globalThis.probe=probe;",
		"probe",
	);
	expect(inspected.structure.genericLookups).toBe(0);
	expect(inspected.core.some((operation) => operation.opcode === "throwIfTdz")).toBe(
		true,
	);
});

it("rejects cross-helper cell contents when another closure mutates or exposes the value", () => {
	for (const escape of ["xs[0]=90", "return xs"]) {
		const inspected = inspectStaticValueFunction(
			`const xs=[10,20]; const probe=()=>xs[0]; const mutate=()=>{${escape}}; globalThis.probe=probe; globalThis.mutate=mutate;`,
			"probe",
		);
		expect(inspected.structure.genericLookups).toBeGreaterThan(0);
	}
});

it("joins constant fields across distinct branch allocations", () => {
	const inspected = inspectStaticValueFunction(
		"const probe=flag=>{const xs=flag?[10,20]:[10,30];return xs[0];};globalThis.probe=probe;",
		"probe",
	);
	expect(inspected.structure.genericLookups).toBe(0);
});

it.each([
	["returned identity", "const helper = xs => xs;", "helper(xs)"],
	[
		"escaping callback",
		"const helper = (xs, x, callback) => { callback(xs); return xs.includes(x); };",
		"helper(xs, x, callback)",
	],
	[
		"recursive receiver",
		"const helper = (xs, n) => n ? helper(xs, n - 1) : xs[0];",
		"helper(xs, x)",
	],
	[
		"observable sloppy caller",
		`const helper = function(xs, callback) { ${"callback();".repeat(80)} return xs[0]; };`,
		"helper(xs, callback)",
	],
])("retains materialization for a helper with %s", (_kind, helper, call) => {
	const elements = Array.from({ length: 32 }, (_, index) => index).join(",");
	const inspected = inspectStaticValueFunction(
		`${helper} function probe(x, callback) { const xs=[${elements}]; return ${call}; } globalThis.probe=probe; globalThis.helper=helper;`,
		"probe",
		{ script: _kind === "observable sloppy caller" },
	);
	expect(inspected.structure.allocations).toBeGreaterThan(0);
});

it("invalidates a shared cell proof when a later function session exposes its value", () => {
	const program = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 1,
		stringConstants: [[108, 101, 110, 103, 116, 104]],
	});
	const writer = new CoreFunctionBuilder(program),
		writeEntry = writer.createBlock();
	const [array] = writer.appendInstruction(writeEntry, "createArray", [], {
		attributes: { length: 1 },
	});
	const [nil] = writer.appendInstruction(writeEntry, "createUndefined", []);
	writer.appendInstruction(writeEntry, "storeGlobal", [array!], {
		attributes: { index: 0 },
	});
	writer.setTerminator(writeEntry, { kind: "return", value: nil! });
	writer.finish(writeEntry);
	const reader = new CoreFunctionBuilder(program),
		readEntry = reader.createBlock();
	const [loaded] = reader.appendInstruction(readEntry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	reader.appendInstruction(readEntry, "throwIfTdz", [loaded!]);
	const [length] = reader.appendInstruction(readEntry, "loadPropertyStatic", [loaded!], {
		attributes: { stringIndex: 0 },
	});
	reader.setTerminator(readEntry, { kind: "return", value: length! });
	const readerFn = program.function(reader.finish(readEntry).function);
	const consumer = coreInstructionId(readerFn.kernel.valueDefinitionOwner(length!));
	const other = new CoreFunctionBuilder(program),
		otherEntry = other.createBlock();
	const [empty] = other.appendInstruction(otherEntry, "createUndefined", []);
	other.setTerminator(otherEntry, { kind: "return", value: empty! });
	const otherFn = other.finish(otherEntry).function;
	const privateContext = {
		...context,
		data: { ...context.data, singleAssignmentGlobalSlots: [0] },
	};
	const query = () =>
		new CoreAnalysisManager(
			program,
			privateContext,
			new CoreOptimizationReportBuilder(program, "off"),
		)
			.get(CORE_STATIC_VALUE_ANALYSIS, { scope: "function", function: readerFn.id })
			.queryAt(loaded!, consumer);
	const first = query();
	expect(first.kind).toBe("known");
	if (first.kind !== "known") throw new Error("missing private cell proof");
	expect(program.staticDescriptions.description(first.description)).toMatchObject({
		kind: "array",
		length: 1,
	});
	const editor = CoreEditor.open(program, otherFn);
	const {
		outputs: [exposed],
	} = editor.appendInstruction(otherEntry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	editor.replaceTerminator(otherEntry, { kind: "return", value: exposed! });
	editor.commit();
	expect(query().kind).toBe("unknown");
});

const primitiveCellConsumers = [
	["String.prototype.charAt", "' abcdefé '", "value.charAt(x)"],
	["String.prototype.charCodeAt", "' abcdefé '", "value.charCodeAt(x)"],
	["String.prototype.codePointAt", "' abcdefé '", "value.codePointAt(x)"],
	["String.prototype.at", "' abcdefé '", "value.at(x)"],
	["String.prototype.indexOf", "' abcdefé '", "value.indexOf(x)"],
	["String.prototype.lastIndexOf", "' abcdefé '", "value.lastIndexOf(x)"],
	["String.prototype.includes", "' abcdefé '", "value.includes(x)"],
	["String.prototype.startsWith", "' abcdefé '", "value.startsWith(x)"],
	["String.prototype.endsWith", "' abcdefé '", "value.endsWith(x)"],
	["String.prototype.slice", "' abcdefé '", "value.slice(x,4)"],
	["String.prototype.substring", "' abcdefé '", "value.substring(x,4)"],
	["String.prototype.substr", "' abcdefé '", "value.substr(x,4)"],
	["String.prototype.anchor", "' abcdefé '", "value.anchor(x)"],
	["String.prototype.big", "' abcdefé '", "value.big(x)"],
	["String.prototype.blink", "' abcdefé '", "value.blink(x)"],
	["String.prototype.bold", "' abcdefé '", "value.bold(x)"],
	["String.prototype.fixed", "' abcdefé '", "value.fixed(x)"],
	["String.prototype.fontcolor", "' abcdefé '", "value.fontcolor(x)"],
	["String.prototype.fontsize", "' abcdefé '", "value.fontsize(x)"],
	["String.prototype.italics", "' abcdefé '", "value.italics(x)"],
	["String.prototype.link", "' abcdefé '", "value.link(x)"],
	["String.prototype.small", "' abcdefé '", "value.small(x)"],
	["String.prototype.strike", "' abcdefé '", "value.strike(x)"],
	["String.prototype.sub", "' abcdefé '", "value.sub(x)"],
	["String.prototype.sup", "' abcdefé '", "value.sup(x)"],
	["String.prototype.concat", "' abcdefé '", "value.concat(x)"],
	["String.prototype.localeCompare", "' abcdefé '", "value.localeCompare(x)"],
	["String.prototype.normalize", "' abcdefé '", "value.normalize(x)"],
	["String.prototype.repeat", "' abcdefé '", "value.repeat(x)"],
	["String.prototype.trim", "' abcdefé '", "value.trim(x)"],
	["String.prototype.trimStart", "' abcdefé '", "value.trimStart(x)"],
	["String.prototype.trimEnd", "' abcdefé '", "value.trimEnd(x)"],
	["String.prototype.trimLeft", "' abcdefé '", "value.trimLeft(x)"],
	["String.prototype.trimRight", "' abcdefé '", "value.trimRight(x)"],
	["String.prototype.toUpperCase", "' abcdefé '", "value.toUpperCase(x)"],
	["String.prototype.toLowerCase", "' abcdefé '", "value.toLowerCase(x)"],
	["String.prototype.toLocaleUpperCase", "' abcdefé '", "value.toLocaleUpperCase(x)"],
	["String.prototype.toLocaleLowerCase", "' abcdefé '", "value.toLocaleLowerCase(x)"],
	["String.prototype.isWellFormed", "' abcdefé '", "value.isWellFormed(x)"],
	["String.prototype.toWellFormed", "' abcdefé '", "value.toWellFormed(x)"],
	["String.prototype.split", "' abcdefé '", "value.split(x)"],
	["String.prototype.replace", "' abcdefé '", "value.replace(x,'z')"],
	["String.prototype.replaceAll", "' abcdefé '", "value.replaceAll(x,'z')"],
	["String.prototype.padStart", "' abcdefé '", "value.padStart(8,x)"],
	["String.prototype.padEnd", "' abcdefé '", "value.padEnd(8,x)"],
	["String.prototype.toString", "' abcdefé '", "value.toString(x)"],
	["String.prototype.valueOf", "' abcdefé '", "value.valueOf(x)"],
	["Boolean.prototype.toString", "false", "value.toString(x)"],
	["Boolean.prototype.valueOf", "false", "value.valueOf(x)"],
	["Number.prototype.toString", "12.5", "value.toString(x)"],
	["Number.prototype.valueOf", "12.5", "value.valueOf(x)"],
	["Number.prototype.toFixed", "12.5", "value.toFixed(x)"],
	["Number.prototype.toExponential", "12.5", "value.toExponential(x)"],
	["Number.prototype.toPrecision", "12.5", "value.toPrecision(x)"],
	["BigInt.prototype.toString", "123n", "value.toString(x)"],
	["BigInt.prototype.valueOf", "123n", "value.valueOf(x)"],
	["Symbol.prototype.toString", "Symbol.iterator", "value.toString(x)"],
	["Symbol.prototype.valueOf", "Symbol.iterator", "value.valueOf(x)"],
] as const;

it.each(primitiveCellConsumers)(
	"resolves immutable primitive-cell consumers at %s",
	(_operation, initializer, expression) => {
		const result = inspectStaticValueFunction(
			`const value=${initializer};function probe(x){globalThis.sink(value);return ${expression};}globalThis.probe=probe;`,
			"probe",
		);
		expect(result.structure.genericLookups).toBe(1);
		expect(result.structure.genericCalls).toBe(1);
	},
);
it.each(primitiveCellConsumers)(
	"retains mutable primitive-cell method lookup at %s",
	(_operation, initializer, expression) => {
		const result = inspectStaticValueFunction(
			`const value=${initializer};function probe(x){globalThis.sink(value);return ${expression};}globalThis.probe=probe;`,
			"probe",
			{ locked: false },
		);
		expect(result.structure.genericLookups).toBe(2);
		expect(result.structure.genericCalls).toBe(2);
	},
);
it.each([
	"let value='abc';function probe(x){globalThis.sink(value);return value.includes(x);}globalThis.set=(x)=>value=x;globalThis.probe=probe;",
	"const value=new String('abc');function probe(x){globalThis.sink(value);return value.includes(x);}globalThis.probe=probe;",
	"const value={includes(x){return x;}};function probe(x){globalThis.sink(value);return value.includes(x);}globalThis.probe=probe;",
])("retains mutable binding or object contents in %s", (source) => {
	const result = inspectStaticValueFunction(source, "probe");
	expect(result.structure.genericLookups).toBe(2);
	expect(result.structure.genericCalls).toBe(2);
});

it("does not license a primitive read using its own later TDZ check", () => {
	const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
	const writer = new CoreFunctionBuilder(program),
		writeEntry = writer.createBlock();
	const [number] = writer.appendInstruction(writeEntry, "createNumber", [], {
		attributes: { value: 3 },
	});
	writer.appendInstruction(writeEntry, "storeGlobal", [number!], {
		attributes: { index: 0 },
	});
	writer.setTerminator(writeEntry, { kind: "return", value: number! });
	writer.finish(writeEntry);
	const reader = new CoreFunctionBuilder(program),
		readEntry = reader.createBlock();
	const [loaded] = reader.appendInstruction(readEntry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	reader.appendInstruction(readEntry, "throwIfTdz", [loaded!]);
	const [formatted] = reader.appendInstruction(readEntry, "unary", [loaded!], {
		attributes: { operator: "tostring" },
	});
	reader.setTerminator(readEntry, { kind: "return", value: formatted! });
	const fn = program.function(reader.finish(readEntry).function);
	const analysis = new CoreAnalysisManager(
		program,
		{ ...context, data: { ...context.data, singleAssignmentGlobalSlots: [0] } },
		new CoreOptimizationReportBuilder(program),
	).get(CORE_STATIC_VALUE_ANALYSIS, { scope: "function", function: fn.id });
	expect(analysis.query(loaded!).kind).toBe("unknown");
	expect(
		analysis.queryAt(
			loaded!,
			fn.instructionNext(coreInstructionId(fn.kernel.valueDefinitionOwner(loaded!)))!,
		).kind,
	).toBe("unknown");
	const consumer = coreInstructionId(fn.kernel.valueDefinitionOwner(formatted!));
	expect(analysis.queryAt(loaded!, consumer)).toMatchObject({
		kind: "known",
		brand: "number",
	});
	expect(analysis.query(loaded!).kind).toBe("unknown");
});

it("invalidates initialized primitive facts when another function adds a cell writer", () => {
	const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]),
		after = builder.createBlock();
	const callback = inspectCoreBlockParameters(builder, entry)[0]!.value;
	const [number] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 3 },
	});
	const [nil] = builder.appendInstruction(entry, "createUndefined", []);
	builder.appendInstruction(entry, "storeGlobal", [number!], {
		attributes: { index: 0 },
	});
	builder.appendInstruction(entry, "call", [callback, nil!, number!]);
	builder.setTerminator(entry, { kind: "jump", edge: { block: after, arguments: [] } });
	const [loaded] = builder.appendInstruction(after, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	builder.setTerminator(after, { kind: "return", value: loaded! });
	const fn = program.function(builder.finish(entry).function);
	const other = new CoreFunctionBuilder(program),
		otherEntry = other.createBlock();
	const [replacement] = other.appendInstruction(otherEntry, "createNumber", [], {
		attributes: { value: 4 },
	});
	other.setTerminator(otherEntry, { kind: "return", value: replacement! });
	const otherFn = other.finish(otherEntry).function;
	const analysis = new CoreAnalysisManager(
		program,
		{ ...context, data: { ...context.data, singleAssignmentGlobalSlots: [0] } },
		new CoreOptimizationReportBuilder(program),
	).get(CORE_STATIC_VALUE_ANALYSIS, { scope: "function", function: fn.id });
	expect(analysis.constant(loaded!)).toEqual({ kind: "number", value: 3 });
	const editor = CoreEditor.open(program, otherFn);
	editor.appendInstruction(otherEntry, "storeGlobal", [replacement!], {
		attributes: { index: 0 },
	});
	editor.commit();
	expect(analysis.query(loaded!).kind).toBe("unknown");
});
