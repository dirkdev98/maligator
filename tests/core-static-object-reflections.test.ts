import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction, staticValueCases } from "./helpers/static-values.ts";

const enumerability = [
	["own data", "return {present:value}.propertyIsEnumerable('present');"],
	["absence", "return {present:value}.propertyIsEnumerable('missing');"],
	["inherited method", "return {present:value}.propertyIsEnumerable('toString');"],
	["accessor", "return {get present(){throw value}}.propertyIsEnumerable('present');"],
	["Array length", "return [value].propertyIsEnumerable('length');"],
	["Array element", "return [value].propertyIsEnumerable('0');"],
	["Array hole", "return [,value].propertyIsEnumerable('0');"],
	["dynamic key", "return {present:value}.propertyIsEnumerable(key);"],
	["primordial descriptor", "return Math.propertyIsEnumerable('abs');"],
	["primordial absence", "return Math.propertyIsEnumerable('missing');"],
	["primordial inherited", "return Math.propertyIsEnumerable('toString');"],
	["omitted key", "return {undefined:value}.propertyIsEnumerable();"],
	[
		"called method",
		"return Object.prototype.propertyIsEnumerable.call({present:value},'present');",
	],
	[
		"joined field",
		"const record=key?{present:value,left:1}:{present:value,right:2};return record.propertyIsEnumerable('present');",
	],
	[
		"joined absence",
		"const record=key?{left:value}:{right:value};return record.propertyIsEnumerable('missing');",
	],
] as const;

describe.each(["precise", "conservative"] as const)(
	"own descriptor facts with %s roots",
	(stackRoots) => {
		it.each(
			staticValueCases(
				enumerability,
				([, body], name) =>
					`function ${name}(value,key){${body}}globalThis.${name}=${name};`,
				{ stackRoots },
			),
		)("eliminates the builtin invocation for %s", (_label, _entry, inspect) => {
			const out = inspect();
			expect(
				out.core.some((op) => op.opcode === "call" || op.opcode === "callKnown"),
			).toBe(false);
			expect(out.core.some((op) => op.opcode === "defineAccessor")).toBe(false);
		});
	},
);

it.each([
	"const record={present:value};observe(record);return record.propertyIsEnumerable('present');",
	"const record=new Proxy({present:value},{getOwnPropertyDescriptor(){throw value}});return Object.prototype.propertyIsEnumerable.call(record,'present');",
	"return {propertyIsEnumerable(){return value}}.propertyIsEnumerable('present');",
])("retains uncertain invocation behavior: %s", (body) => {
	const out = inspectStaticValueFunction(
		`function probe(value,observe){${body}}globalThis.probe=probe;`,
		"probe",
	);
	const invocation = out.core.some(
		(op) => op.opcode === "call" || op.opcode === "callKnown",
	);
	expect(invocation).toBe(true);
	expect(out.core.some((op) => op.opcode === "queryStaticData")).toBe(false);
});

it("keeps unresolved method identity when multiple realms are enabled", () => {
	const out = inspectStaticValueFunction(
		"function probe(value,flag){const record=flag?{present:value,left:1}:{present:value,right:2};return record.propertyIsEnumerable('present');}globalThis.probe=probe;",
		"probe",
		{ realms: true },
	);
	expect(out.core.some((op) => op.opcode === "call")).toBe(true);
});

describe("normal-result facts of Object prototype methods", () => {
	it.each([
		["hasOwnProperty", COMPILER_VALUE_KIND_BOOLEAN, false],
		["propertyIsEnumerable", COMPILER_VALUE_KIND_BOOLEAN, false],
		["isPrototypeOf", COMPILER_VALUE_KIND_BOOLEAN, false],
		["toString", COMPILER_VALUE_KIND_STRING, true],
	] as const)(
		"preserves %s effects while selecting result storage",
		(method, mask, rooted) => {
			const operation = `Object.prototype.${method}`;
			const out = inspectStaticValueFunction(
				`function probe(value,key,observe){const result=${operation}.call(value,key);observe();return result;}globalThis.probe=probe;`,
				"probe",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			const call = out.native.body.instructions[ip]!;
			if (call.opcode !== "CALL_KNOWN")
				throw new Error("Expected exact builtin invocation");
			expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([mask]);
			expect(out.native.storage!.rootRegisters.includes(call.dst)).toBe(rooted);
			expect(out.structure.genericCalls).toBe(1);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([false, true])("retains loaded-callee authority with locked=%s", (locked) => {
		const out = inspectStaticValueFunction(
			"function probe(value,key){const result=Object.prototype.propertyIsEnumerable.call(value,key);return typeof result;}globalThis.probe=probe;",
			"probe",
			{ locked },
		);
		expect(
			out.core.some((op) => op.opcode === "unary" && op.attributes.operator === "typeof"),
		).toBe(!locked);
	});
});

const objectPredicates = [
	["Object.isFrozen", "value"],
	["Reflect.defineProperty", "value,key,other"],
	["Reflect.set", "value,key,other"],
] as const;

describe.each(["precise", "conservative"] as const)(
	"Object/Reflect results with %s roots",
	(stackRoots) => {
		it.each(
			staticValueCases(
				objectPredicates,
				([operation, args], name) =>
					`function ${name}(value,key,other,observe){const result=${operation}(${args});observe();return result;}globalThis.${name}=${name};`,
				{ stackRoots },
			),
		)(
			"stores %s as Boolean without weakening its invocation",
			(_label, [operation], inspect) => {
				const out = inspect();
				const ip = out.native.body.instructions.findIndex(
					(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				const call = out.native.body.instructions[ip]!;
				if (call.opcode !== "CALL_KNOWN")
					throw new Error("Expected exact builtin invocation");
				expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([
					COMPILER_VALUE_KIND_BOOLEAN,
				]);
				expect(out.native.registerRepresentations[call.dst]).toBe("boolean");
				if (stackRoots === "precise")
					expect(out.native.storage!.rootRegisters).not.toContain(call.dst);
				expect(out.structure.genericCalls).toBe(1);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			},
		);
	},
);

it.each(objectPredicates)("retains arbitrary mutable %s results", (operation, args) => {
	const out = inspectStaticValueFunction(
		`function probe(value,key,other,observe){const result=${operation}(${args});observe();return result;}globalThis.probe=probe;`,
		"probe",
		{ locked: false },
	);
	expect(
		out.native.body.instructions.some(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
		),
	).toBe(false);
	expect(
		out.native.body.instructions.some(
			(op) => op.opcode === "CALL" && out.native.storage!.rootRegisters.includes(op.dst),
		),
	).toBe(true);
});

it.each([
	"Reflect.has.call(null,value,key)",
	"Reflect.has.apply(null,other)",
	"Reflect.apply(Reflect.has,null,other)",
	"Reflect.has(...other)",
])("carries Boolean bounds through %s argument effects", (expression) => {
	const out = inspectStaticValueFunction(
		`function probe(value,key,other,observe){const result=${expression};observe();return result;}globalThis.probe=probe;`,
		"probe",
	);
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode === "CALL_KNOWN" && op.operation === "Reflect.has",
	);
	expect(ip).toBeGreaterThanOrEqual(0);
	expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([COMPILER_VALUE_KIND_BOOLEAN]);
});

const objectResultBounds = [
	["Object.keys", "Object.keys(value)", COMPILER_VALUE_KIND_OBJECT, true],
	[
		"Object.getOwnPropertyDescriptor",
		"Object.getOwnPropertyDescriptor(value,key)",
		COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNDEFINED,
		true,
	],
	[
		"Object.getPrototypeOf",
		"Object.getPrototypeOf(value)",
		COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL,
		true,
	],
	[
		"WeakRef.prototype.deref",
		"WeakRef.prototype.deref.call(value)",
		COMPILER_VALUE_KIND_OBJECT |
			COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL |
			COMPILER_VALUE_KIND_UNDEFINED,
		true,
	],
	[
		"Map.prototype.clear",
		"Map.prototype.clear.call(value)",
		COMPILER_VALUE_KIND_UNDEFINED,
		false,
	],
] as const;

it.each(objectResultBounds)(
	"uses %s bounds without losing invocation or live heap results",
	(operation, expression, mask, rooted) => {
		for (const compare of [false, true]) {
			const out = inspectStaticValueFunction(
				`function probe(value,key,observe){const result=${expression};observe();return result${compare ? "===false" : ""};}globalThis.probe=probe;`,
				"probe",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			const call = out.native.body.instructions[ip]!;
			if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing exact builtin call");
			expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([mask]);
			expect(out.native.storage!.rootRegisters.includes(call.dst)).toBe(
				rooted && !compare,
			);
			expect(out.structure.genericCalls).toBe(1);
			if (compare) expect(out.core.some((op) => op.opcode === "binary")).toBe(false);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		}
	},
);

it.each([
	["String.prototype.split", "String.prototype.split.call(value,key)"],
	["Array.prototype.toString", "Array.prototype.toString.call(value)"],
	["Promise.prototype.catch", "Promise.prototype.catch.call(value,key)"],
])("keeps arbitrary protocol results of %s", (operation, expression) => {
	const out = inspectStaticValueFunction(
		`function probe(value,key,observe){const result=${expression};observe();return result===false;}globalThis.probe=probe;`,
		"probe",
	);
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
	);
	expect(ip).toBeGreaterThanOrEqual(0);
	expect(out.native.facts?.[ip]?.resultKindMasks).toEqual([COMPILER_VALUE_KIND_TOP]);
	expect(out.core.some((op) => op.opcode === "binary")).toBe(true);
});
