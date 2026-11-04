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
		["a primitive target", "return Object.assign(3, {revision:value&31});"],
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
		["multiple sources", "return Object.assign({}, {first:value&31}, {second:3});"],
		["an adapted receiver", "return Object.assign.call(value, {}, {revision:3});"],
	])("retains %s", (_name, body) => {
		expect(assigns(inspect(body)).length).toBeGreaterThan(0);
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
});
