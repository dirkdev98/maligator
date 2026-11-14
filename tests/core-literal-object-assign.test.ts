import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(
	body: string,
	options: Parameters<typeof inspectStaticValueFunction>[2] = {},
) {
	return inspectStaticValueFunction(
		`function target(value, flag) { ${body} } globalThis.target = target;`,
		"target",
		options,
	);
}
const assigns = (output: ReturnType<typeof inspect>) =>
	output.core.filter((operation) => operation.attributes.operation === "Object.assign");

describe("literal Object.assign lowering", () => {
	it("copies primitive data fields to a proven object without a builtin call", () => {
		const output = inspect(
			'const out={}; return Object.assign(out, {revision:value&31, active:true, label:"item"});',
		);
		expect(assigns(output)).toEqual([]);
	});
	it("preserves ordinary Set for a target with inherited setters", () => {
		const output = inspect(
			"const out=Object.create({set revision(v){globalThis.seen=v;}}); return Object.assign(out, {revision:value&31});",
		);
		expect(assigns(output)).toEqual([]);
	});
	it.each([
		["an unknown target", "return Object.assign(value, {revision:3});"],
		[
			"a target exposed before assignment",
			"const out={}; globalThis.saved=out; return Object.assign(out,value);",
		],
		["a primitive target", "return Object.assign(3, {revision:value&31});"],
		["multiple sources", "return Object.assign({}, {first:value&31}, {second:3});"],
		["an adapted receiver", "return Object.assign.call(value, {}, {revision:3});"],
	])("retains %s", (_name, body) => {
		expect(assigns(inspect(body)).length).toBeGreaterThan(0);
	});
	it.each([
		["an object field", "return Object.assign({}, {item:value});"],
		["a weakly held Symbol field", 'return Object.assign({}, {item:Symbol("item")});'],
		[
			"an escaped source",
			"const source={revision:value&31}; globalThis.source=source; return Object.assign({}, source);",
		],
		[
			"a source on a control edge",
			"const source={revision:value&31}; const out=Object.assign({}, source); return [out,flag?source:null];",
		],
		["an accessor source", "return Object.assign({}, {get revision(){return value;}});"],
		["a computed source", "return Object.assign({}, {[value]:3});"],
		["a dynamic source", "return Object.assign({}, value);"],
		[
			"a normal control-flow result",
			"const out=flag?Object.assign({},value):null; globalThis.seen=out; return out;",
		],
	])("copies %s into a fresh target with one allocating operation", (_name, body) => {
		const output = inspect(body);
		expect(assigns(output)).toEqual([]);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "copyDataProperties" &&
					operation.attributes.copyMode === "assign",
			),
		).toBe(true);
	});
	it("retains a source carried only into an exception handler", () => {
		const output = inspect(
			"const source={revision:value&31}; const out=Object.create({set revision(v){throw v;}}); try {Object.assign(out,source); return null;} catch {return source;}",
		);
		expect(assigns(output).length).toBeGreaterThan(0);
	});
	it("retains throwing assign semantics in a sloppy caller", () => {
		expect(
			assigns(
				inspect("const out={}; return Object.assign(out, {revision:value&31});", {
					script: true,
				}),
			).length,
		).toBeGreaterThan(0);
	});
	it("retains a mutable Object.assign lookup", () => {
		const output = inspect(
			"const out={}; return Object.assign(out, {revision:value&31});",
			{ locked: false },
		);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
	it("guards mutable literal stores and retains their loaded call", () => {
		const output = inspect(
			"const out={}; return Object.assign(out, {revision:value&31});",
			{ locked: false },
		);
		expect(
			output.core.filter(
				(operation) =>
					operation.opcode === "guardSemanticEpoch" &&
					operation.attributes.family === "primordial-bindings",
			),
		).toHaveLength(1);
		expect(
			output.core.some((operation) => operation.opcode === "storePropertyStatic"),
		).toBe(true);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
	it("guards a mutable fresh copy and retains its loaded call", () => {
		const output = inspect("return Object.assign({}, value);", { locked: false });
		expect(
			output.core.filter(
				(operation) =>
					operation.opcode === "guardSemanticEpoch" &&
					operation.attributes.family === "primordial-bindings",
			),
		).toHaveLength(1);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "copyDataProperties" &&
					operation.attributes.copyMode === "assign",
			),
		).toBe(true);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
	it("shares one namespace guard with a mutable literal copy on primitive inputs", () => {
		const output = inspect("const out={}; return Object.assign(out, {revision:3});", {
			locked: false,
		});
		expect(
			output.core.filter(
				(operation) =>
					operation.opcode === "guardSemanticEpoch" &&
					operation.attributes.family === "primordial-bindings",
			),
		).toHaveLength(1);
		expect(
			output.core.some((operation) => operation.opcode === "storePropertyStatic"),
		).toBe(true);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" &&
					operation.attributes.operation === "Object.assign",
			),
		).toBe(false);
	});
	it("keeps realm-enabled mutable copies on their original call", () => {
		const output = inspect("return Object.assign({}, value);", {
			locked: false,
			realms: true,
		});
		expect(
			output.core.some((operation) => operation.opcode === "copyDataProperties"),
		).toBe(false);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
});
