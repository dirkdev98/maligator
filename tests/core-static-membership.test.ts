import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction, staticValueCases } from "./helpers/static-values.ts";

const present = [
	[
		"own field with an unknown value",
		"const record={present:value};return 'present' in record;",
	],
	[
		"own accessor",
		"const record={get present(){throw value}};return 'present' in record;",
	],
	["Number key", "const record={1:value};return 1 in record;"],
	["negative zero key", "const record={0:value};return -0 in record;"],
	["BigInt key", "const record={1:value};return 1n in record;"],
	["Boolean key", "const record={true:value};return true in record;"],
	["null key", "const record={null:value};return null in record;"],
	["undefined key", "const record={undefined:value};return undefined in record;"],
	["Array element after a hole", "const record=[,value];return 1 in record;"],
	["Array length", "const record=[value];return 'length' in record;"],
	[
		"Array length after escape",
		"const record=[value];observe(record);return 'length' in record;",
	],
	[
		"own field after a private write",
		"const record={present:0};record.present=value;return 'present' in record;",
	],
] as const;

const retained = [
	["unknown key", "const record={present:value};return key in record;"],
	[
		"Proxy receiver",
		"const record=new Proxy({present:value},{has(){throw value}});return 'present' in record;",
	],
	[
		"escaped own property",
		"const record={present:value};observe(record);return 'present' in record;",
	],
	[
		"Object key that can delete the property",
		"const record={present:value};const coercingKey={toString(){delete record.present;return 'present'}};return coercingKey in record;",
	],
	["primitive receiver", "return key in 1;"],
	[
		"loop-carried deletion",
		"const record={present:value};let result=false;for(let i=0;i<key;i++){result='present' in record;delete record.present;}return result;",
	],
] as const;

describe.each([false, true])("static membership with locked primordials %s", (locked) => {
	it.each(
		staticValueCases(
			present,
			([, body], name) =>
				`function ${name}(value,observe){${body}}globalThis.${name}=${name};`,
			{ locked },
		),
	)("folds %s independently of the field value", (_label, _entry, inspect) => {
		const result = inspect();
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(false);
		expect(
			result.fn.instructions.some(
				(instruction) => instruction.opcode === "CREATE_BOOLEAN" && instruction.value,
			),
		).toBe(true);
	});

	it.each(
		staticValueCases(
			retained,
			([, body], name) =>
				`function ${name}(value,key,observe){${body}}globalThis.${name}=${name};`,
			{ locked },
		),
	)("retains %s semantics", (_label, _entry, inspect) => {
		expect(
			inspect().core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(true);
	});

	it.each(["function*", "async function", "async function*"])(
		"folds a private property across suspension in %s",
		(prefix) => {
			const suspension = prefix === "async function" ? "await 1" : "yield 1";
			const result = inspectStaticValueFunction(
				`${prefix} probe(value){const record={present:value};${suspension};return 'present' in record;}globalThis.probe=probe;`,
				"probe",
				{ locked },
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "in",
				),
			).toBe(false);
		},
	);

	it("keeps operand evaluation when folding presence", () => {
		const result = inspectStaticValueFunction(
			"function probe(value,effect){return (effect(), 'present') in {present:value};}globalThis.probe=probe;",
			"probe",
			{ locked },
		);
		expect(result.core.some((operation) => operation.opcode === "call")).toBe(true);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(false);
	});

	it("uses world proofs independently for inherited presence and absence", () => {
		for (const key of ["missing", "toString"]) {
			const result = inspectStaticValueFunction(
				`function probe(value){return '${key}' in {present:value};}globalThis.probe=probe;`,
				"probe",
				{ locked },
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "in",
				),
			).toBe(!locked);
		}
	});
});

describe("joined own-key bounds", () => {
	it.each([
		"return Object.hasOwn(record, 'missing');",
		"return Object.getOwnPropertyDescriptor(record, 'missing');",
		"return record.missing;",
		"return delete record.missing;",
	])(
		"preserves callback and coercion effects after the joined observation folds: %s",
		(observation) => {
			for (const primitive of [false, true]) {
				const result = inspectStaticValueFunction(
					`function probe(flag, callback) {
				const record = flag ? {left: ${primitive ? "+" : ""}callback('left')} : {right: ${primitive ? "+" : ""}callback('right')};
				${observation}
			} globalThis.probe = probe;`,
					"probe",
				);
				expect(result.structure.allocations).toBe(0);
				expect(result.core.filter((op) => op.opcode === "call")).toHaveLength(2);
			}
		},
	);

	const folded = [
		[
			"unrelated String",
			"const record=flag?{left:value}:{right:value};return Object.hasOwn(record,'missing');",
		],
		[
			"unlisted Symbol",
			"const record=flag?{left:value}:{right:value};return Object.hasOwn(record,Symbol.iterator);",
		],
		["read", "const record=flag?{left:value}:{right:value};return record.missing;"],
		[
			"delete",
			"const record=flag?{left:value}:{right:value};return delete record.missing;",
		],
		[
			"descriptor",
			"const record=flag?{left:value}:{right:value};return Object.getOwnPropertyDescriptor(record,'missing');",
		],
		[
			"sparse Array",
			"const record=flag?[value]:[,value];return Object.hasOwn(record,Symbol.iterator);",
		],
		[
			"unlisted String despite Symbol fields",
			"const record=flag?{[Symbol.iterator]:value}:{[Symbol.toStringTag]:value};return Object.hasOwn(record,'missing');",
		],
		[
			"nested join",
			"const record=flag?{left:value}:other?{center:value}:{right:value};return Object.hasOwn(record,'missing');",
		],
		[
			"constructor domains",
			"const record=flag?new RegExp(value):new String(value);return Object.hasOwn(record,Symbol.iterator);",
		],
	] as const;
	it.each(
		staticValueCases(
			folded,
			([, body], name) =>
				`function ${name}(value,flag,other){${body}}globalThis.${name}=${name};`,
		),
	)("folds %s", (_label, _entry, inspect) => {
		expect(
			inspect().core.some(
				(op) =>
					op.opcode === "loadPropertyStatic" ||
					op.opcode === "deleteProperty" ||
					(op.opcode === "callKnown" &&
						["Object.hasOwn", "Object.getOwnPropertyDescriptor"].includes(
							op.attributes.operation as string,
						)),
			),
		).toBe(false);
	});
	it.each([
		[
			"possible String",
			"const record=flag?{left:value}:{right:value};return Object.hasOwn(record,'left');",
		],
		[
			"possible Symbol",
			"const record=flag?{[Symbol.iterator]:value}:{[Symbol.toStringTag]:value};return Object.hasOwn(record,Symbol.iterator);",
		],
		[
			"escape",
			"const record=flag?{left:value}:{right:value};observe(record);return Object.hasOwn(record,'missing');",
		],
		[
			"unknown input",
			"const record=flag?value:{right:value};return Object.hasOwn(record,Symbol.iterator);",
		],
		[
			"getter barrier",
			"const record=flag?{left:value}:{right:value};const reader={get effect(){observe(record)}};reader.effect;return Object.getOwnPropertyDescriptor(record,'missing');",
		],
	] as const)("retains %s uncertainty", (_label, body) => {
		const result = inspectStaticValueFunction(
			`function probe(value,flag,observe){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			result.core.some(
				(op) =>
					op.opcode === "callKnown" &&
					["Object.hasOwn", "Object.getOwnPropertyDescriptor"].includes(
						op.attributes.operation as string,
					),
			),
		).toBe(true);
	});
});

describe("own-key absence", () => {
	const absent = [
		[
			"Symbol on a String-keyed record",
			"return Object.hasOwn({known:value},Symbol(value));",
		],
		[
			"absent Symbol descriptor",
			"return Object.getOwnPropertyDescriptor({known:value},Symbol(value));",
		],
		[
			"null-prototype Symbol read",
			"const key=Symbol(value);return ({__proto__:null,known:value})[key];",
		],
		[
			"null-prototype Symbol membership",
			"const key=Symbol(value);return key in {__proto__:null,known:value};",
		],
		["inherited Symbol absence", "return Symbol.iterator in {known:value};"],
		["inherited Symbol presence", "return Symbol.iterator in [value];"],
		["String wrapper Symbol", "return Object.hasOwn(new String(value),Symbol.iterator);"],
		["RegExp unrelated name", "return Object.hasOwn(new RegExp(value),'missing');"],
		[
			"unknown Array indexes and a Symbol",
			"return Object.hasOwn(Array(value),Symbol.iterator);",
		],
		[
			"unknown Array indexes and an unrelated name",
			"return Object.hasOwn(Array(value),'missing');",
		],
		["Symbol delete", "return delete ({known:value})[Symbol(value)];"],
		["Array named delete", "return delete Array(value).missing;"],
		["Reflect delete", "return Reflect.deleteProperty(Array(value),'missing');"],
	] as const;
	it.each(
		staticValueCases(
			absent,
			([, body], name) => `function ${name}(value){${body}}globalThis.${name}=${name};`,
		),
	)("folds %s through the shared own-property query", (_label, _entry, inspect) => {
		const result = inspect();
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "loadProperty" ||
					operation.opcode === "queryStaticData" ||
					operation.opcode === "deleteProperty" ||
					(operation.opcode === "binary" && operation.attributes.operator === "in") ||
					(operation.opcode === "callKnown" &&
						[
							"Object.hasOwn",
							"Reflect.has",
							"Reflect.deleteProperty",
							"Object.getOwnPropertyDescriptor",
						].includes(operation.attributes.operation as string)),
			),
		).toBe(false);
	});
	it.each(["function*", "async function", "async function*"])(
		"keeps private absence across suspension in %s",
		(prefix) => {
			const suspension = prefix === "async function" ? "await observe()" : "yield 1";
			const result = inspectStaticValueFunction(
				`${prefix} probe(value,observe){const key=Symbol(value),record={known:value};${suspension};return Object.getOwnPropertyDescriptor(record,key);}globalThis.probe=probe;`,
				"probe",
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "callKnown" &&
						operation.attributes.operation === "Object.getOwnPropertyDescriptor",
				),
			).toBe(false);
		},
	);
	it.each([
		["possible own numeric index", "return Object.hasOwn(Array(value),'0');"],
		[
			"Array length descriptor",
			"return Object.getOwnPropertyDescriptor(Array(value),'length');",
		],
		["RegExp lastIndex", "return Object.hasOwn(new RegExp(value),'lastIndex');"],
		[
			"escaped Symbol write",
			"const record={known:value};observe(record);return Object.hasOwn(record,Symbol.iterator);",
		],
		[
			"uncertain Symbol alias",
			"const key=Symbol.for(value),other=Symbol.for(value);return Object.hasOwn({[key]:value},other);",
		],
	] as const)("retains %s", (_label, body) => {
		const result = inspectStaticValueFunction(
			`function probe(value,observe){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "callKnown" &&
					["Object.hasOwn", "Object.getOwnPropertyDescriptor"].includes(
						operation.attributes.operation as string,
					),
			),
		).toBe(true);
	});
});

describe("Symbol property identity", () => {
	it.each([false, true])(
		"uses initialized Symbol cell keys with locked primordials %s",
		(locked) => {
			const cases = [
				["read", "return record[key];"],
				["presence", "return key in record;"],
				["hasOwn", "return Object.hasOwn(record,key);"],
				["reflectHas", "return Reflect.has(record,key);"],
				["descriptor", "return Object.getOwnPropertyDescriptor(record,key).value;"],
			] as const;
			for (const [, body] of cases) {
				const result = inspectStaticValueFunction(
					`const key=globalThis.chooseKey?Symbol('one'):Symbol('two');function probe(value,observe){const record={[key]:value};observe();${body}}globalThis.probe=probe;`,
					"probe",
					{ locked },
				);
				expect(result.core.some((operation) => operation.opcode === "call")).toBe(true);
				expect(
					result.core.some(
						(operation) =>
							operation.opcode === "loadGlobal" || operation.opcode === "throwIfTdz",
					),
				).toBe(true);
				expect(
					result.core.some(
						(operation) =>
							operation.opcode === "createObject" ||
							operation.opcode === "loadProperty" ||
							operation.opcode === "callKnown" ||
							(operation.opcode === "binary" && operation.attributes.operator === "in"),
					),
				).toBe(!locked);
			}
		},
	);
	it.each([
		["module registry cell", "const key=Symbol.for(globalThis.dynamicKey);", ""],
		[
			"captured registry cell",
			"function factory(description){const key=Symbol.for(description);",
			"return probe;}globalThis.factory=factory;",
		],
		[
			"captured joined cell",
			"function factory(condition){const key=condition?Symbol('one'):Symbol('two');",
			"return probe;}globalThis.factory=factory;",
		],
	] as const)("forwards private fields keyed by a %s", (_label, prefix, suffix) => {
		const result = inspectStaticValueFunction(
			`${prefix}function probe(value,observe){const record={[key]:value};observe();return record[key];}globalThis.probe=probe;${suffix}`,
			"probe",
		);
		expect(result.core.some((operation) => operation.opcode === "loadProperty")).toBe(
			false,
		);
		expect(result.core.some((operation) => operation.opcode === "call")).toBe(true);
	});
	it.each([
		[
			"different cells that may alias",
			"const key=Symbol.for(globalThis.first),other=Symbol.for(globalThis.second);",
			"observe();return record[other];",
		],
		[
			"mutable cell",
			"let key=Symbol('one');globalThis.replace=()=>{key=Symbol('two')};",
			"observe();return record[key];",
		],
		[
			"escaped field",
			"const key=Symbol.for(globalThis.first);",
			"observe(record,key);return record[key];",
		],
		[
			"coercing Object cell",
			"const key={toString(){return globalThis.nextKey()}};",
			"observe();return record[key];",
		],
	] as const)("retains the property fallback for %s", (_label, prefix, tail) => {
		const result = inspectStaticValueFunction(
			`${prefix}function probe(value,observe){const record={[key]:value};${tail}}globalThis.probe=probe;`,
			"probe",
		);
		expect(result.core.some((operation) => operation.opcode === "loadProperty")).toBe(
			true,
		);
	});
	const fields = [
		[
			"fresh Symbol read",
			"const key=Symbol('key');const record={[key]:value};return record[key];",
		],
		[
			"effectful Symbol description",
			"const key=Symbol(value);const record={[key]:value};return record[key];",
		],
		[
			"unknown registry key",
			"const key=Symbol.for(value);const record={[key]:value};return record[key];",
		],
		[
			"joined Symbol key",
			"const key=value?Symbol.iterator:Symbol.toStringTag;const record={[key]:value};return record[key];",
		],
		[
			"stable registry identity",
			"const record={[Symbol.for('key')]:value};return record[Symbol.for('key')];",
		],
		[
			"private Symbol write",
			"const key=Symbol('key');const record={[key]:0};record[key]=value;return record[key];",
		],
		[
			"Symbol descriptor",
			"const key=Symbol('key');const record={[key]:value};return Object.getOwnPropertyDescriptor(record,key).value;",
		],
	] as const;
	it.each(
		staticValueCases(
			fields,
			([, body], name) => `function ${name}(value){${body}}globalThis.${name}=${name};`,
		),
	)("forwards %s through the shared static property query", (_label, _entry, inspect) => {
		expect(inspect().core.some((operation) => operation.opcode === "loadProperty")).toBe(
			false,
		);
	});
	it.each(["key in record", "Object.hasOwn(record,key)", "Reflect.has(record,key)"])(
		"folds own Symbol presence in %s",
		(expression) => {
			const result = inspectStaticValueFunction(
				`function probe(value){const key=Symbol(value);const record={[key]:value};return ${expression};}globalThis.probe=probe;`,
				"probe",
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "in",
				),
			).toBe(false);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "callKnown" &&
						(operation.attributes.operation === "Object.hasOwn" ||
							operation.attributes.operation === "Reflect.has"),
				),
			).toBe(false);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "callKnown" &&
						operation.attributes.operation === "Symbol",
				),
			).toBe(true);
		},
	);
	it.each([
		[
			"distinct Symbols with the same description",
			"const key=Symbol('key'),other=Symbol('key');const record={[key]:value};return record[other];",
		],
		[
			"uncertain registry aliases",
			"const key=Symbol.for(value),other=Symbol.for(value);const record={[key]:value};return record[other];",
		],
		[
			"Symbol accessor read",
			"const key=Symbol('key');const record={get [key](){throw value}};return record[key];",
		],
		[
			"escaped Symbol property",
			"const key=Symbol('key');const record={[key]:value};observe(record,key);return record[key];",
		],
		[
			"deleted Symbol property",
			"const key=Symbol('key');const record={[key]:value};delete record[key];return record[key];",
		],
	] as const)("retains %s", (_label, body) => {
		const result = inspectStaticValueFunction(
			`function probe(value,observe){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(result.core.some((operation) => operation.opcode === "loadProperty")).toBe(
			true,
		);
	});
	it.each(["function*", "async function", "async function*"])(
		"forwards a private Symbol field across suspension in %s",
		(prefix) => {
			const suspension = prefix === "async function" ? "await 1" : "yield 1";
			const result = inspectStaticValueFunction(
				`${prefix} probe(value){const key=Symbol('key');const record={[key]:value};${suspension};return record[key];}globalThis.probe=probe;`,
				"probe",
			);
			expect(result.core.some((operation) => operation.opcode === "loadProperty")).toBe(
				false,
			);
		},
	);
	it.each(["string", "symbol", "number"] as const)(
		"keeps %s conversion facts independent of base exceptions and compact index storage",
		(kind) => {
			const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[107]] });
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 }),
				entry = builder.createBlock([{}, {}]);
			const [text] = builder.appendInstruction(entry, "createString", [], {
				attributes: { stringIndex: 0 },
			});
			const [nil] = builder.appendInstruction(entry, "createUndefined", []);
			const [key] =
				kind === "string"
					? [text!]
					: kind === "number"
						? builder.appendInstruction(entry, "createNumber", [], {
								attributes: { value: 1 },
							})
						: builder.appendInstruction(entry, "callKnown", [nil!, text!], {
								attributes: { operation: "Symbol" },
							});
			const [converted] = builder.appendInstruction(entry, "toPropertyKey", [
				builder.blockParameterValue(entry, 0),
				key!,
			]);
			const conversion = builder.bodyInstructionIds(entry).at(-1)!;
			const [record] = builder.appendInstruction(entry, "createObject", []);
			const payload = builder.blockParameterValue(entry, 1);
			builder.appendInstruction(entry, "defineProperty", [record!, converted!, payload], {
				attributes: { enumerable: true },
			});
			const [result] = builder.appendInstruction(entry, "loadProperty", [record!, key!]);
			const read = builder.bodyInstructionIds(entry).at(-1)!;
			builder.setTerminator(entry, { kind: "return", value: result! });
			const fn = program.function(builder.finish(entry).function),
				context = programAnalysisContext();
			const analysis = new CoreStaticValueAnalysis(
				program,
				fn,
				() => buildCoreControlFlow(program, fn.id),
				65536,
				{
					...context,
					facts: {
						...context.facts,
						world: { ...context.facts.world, primordialPolicy: "locked" },
					},
				},
			);
			const fact = analysis.query(converted!);
			if (kind === "number") expect(fact.kind).toBe("unknown");
			else {
				expect(fact).toMatchObject({ kind: "known", brand: kind });
				const property = analysis.queryPropertyAt(
					record!,
					kind === "symbol" ? key! : "k",
					read,
				)!;
				expect(property.operands).toEqual([payload]);
				analysis.verifyProperty(property, read);
			}
			expect(fn.instructionEffectRefinement(conversion)).toBeUndefined();
			expect(fn.registry.byId(fn.instructionOpcode(conversion)).effects.mayThrow).toBe(
				true,
			);
		},
	);
});
