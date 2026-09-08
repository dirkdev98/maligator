import { describe, expect, it } from "vitest";
import {
	knownOperations,
	primordialBindings,
} from "../src/compiler/shared/known-operations.ts";
import {
	primordialNode,
	resolvePrimordialProperty,
} from "../src/compiler/shared/primordial-catalog.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("known-operation dispatch", () => {
	it("has a relocation-safe descriptor route for every admitted callable", () => {
		const bindings = primordialBindings();
		for (const operation of knownOperations()) {
			const seen = new Set<number>();
			let node = operation.node;
			while (node >= 0) {
				expect(seen.has(node), operation.id).toBe(false);
				seen.add(node);
				const binding = bindings[node];
				expect(binding, operation.id).toBeDefined();
				node = binding!.parent;
			}
		}
	});
	it.each([
		["new Date(input).getTime()", "Date.prototype.getTime"],
		["new Map(input).has(input)", "Map.prototype.has"],
		["new WeakSet().has(input)", "WeakSet.prototype.has"],
		["new ArrayBuffer(input).slice(0)", "ArrayBuffer.prototype.slice"],
		["new DataView(input).getInt8(0)", "DataView.prototype.getInt8"],
		["new RegExp(input).test(input)", "RegExp.prototype.test"],
		["new Error(input).toString()", "Error.prototype.toString"],
		["new Promise(input).then(input)", "Promise.prototype.then"],
		["new WeakRef(input).deref()", "WeakRef.prototype.deref"],
		[
			"new FinalizationRegistry(input).unregister(input)",
			"FinalizationRegistry.prototype.unregister",
		],
		["new DisposableStack().use(input)", "DisposableStack.prototype.use"],
		["new AsyncDisposableStack().use(input)", "AsyncDisposableStack.prototype.use"],
		[
			"new Uint8Array(input).subarray(1)",
			resolvePrimordialProperty("Uint8Array.prototype", "subarray")!.value![0],
		],
		["new WeakMap().has(input)", "WeakMap.prototype.has"],
		["new Set(input).values()", primordialNode("Set.prototype.values")![0]],
	])("resolves %s with dynamic contents", (expression, operation) => {
		const result = inspectStaticValueFunction(
			`function probe(input) { return ${expression}; } globalThis.probe = probe;`,
			"probe",
		);
		expect(
			result.fn.instructions
				.filter((instruction) => instruction.opcode === "CALL_KNOWN")
				.map((instruction) => instruction.operation),
		).toContain(operation);
		expect(result.structure.genericLookups).toBe(0);
		expect(result.c.source).toContain("mal_vm_call_known_native(vm, mal_known_native_");
	});
	it.each(["Number", "String", "Boolean"])(
		"resolves valueOf before a %s wrapper escapes",
		(constructor) => {
			const result = inspectStaticValueFunction(
				`
			function probe(input) {
				const box = new ${constructor}(input);
				const value = box.valueOf();
				return [box, value];
			}
			globalThis.probe = probe;
		`,
				"probe",
			);
			const calls = result.fn.instructions.filter(
				(instruction) => instruction.opcode === "CALL_KNOWN",
			);
			expect(
				calls.some(
					(instruction) => instruction.operation === constructor && instruction.construct,
				),
			).toBe(true);
			expect(
				calls.some(
					(instruction) => instruction.operation === `${constructor}.prototype.valueOf`,
				),
			).toBe(true);
			expect(result.structure.genericLookups).toBe(0);
		},
	);
	it("keeps mutable-world method lookup", () => {
		const result = inspectStaticValueFunction(
			"function probe(input) { return new Date(input).getTime(); } globalThis.probe = probe;",
			"probe",
			{ locked: false },
		);
		expect(result.structure.genericLookups).toBeGreaterThan(0);
		expect(
			result.fn.instructions.some((instruction) => instruction.opcode === "CALL_KNOWN"),
		).toBe(false);
	});
	it("retains unknown Error payload properties while resolving inherited methods", () => {
		const result = inspectStaticValueFunction(
			"function probe(value) { const error = new Error(value, {cause: value}); const text = error.toString(); return [error.message, error.cause, text]; } globalThis.probe = probe;",
			"probe",
		);
		expect(result.structure.genericLookups).toBeGreaterThanOrEqual(2);
		expect(result.fn.instructions).toContainEqual(
			expect.objectContaining({
				opcode: "CALL_KNOWN",
				operation: "Error.prototype.toString",
			}),
		);
	});
	it.each([
		"return Date.prototype.getTime.call(value);",
		"return Date.prototype.getTime.apply(value, []);",
		"return Date.prototype.getTime.apply(value, value.arguments);",
		"return Reflect.apply(Date.prototype.getTime, value, value.arguments);",
		"return Date.prototype.getTime.bind(value)(...value.arguments);",
		"return Reflect.apply(Date.prototype.getTime, value, []);",
		"const read = Date.prototype.getTime.bind(value); return read();",
		"const read = Date.prototype.getTime.bind(value).bind(null, 7); return read();",
	])("normalizes a captured call form: %s", (body) => {
		const result = inspectStaticValueFunction(
			`function probe(value) { ${body} } globalThis.probe = probe;`,
			"probe",
		);
		expect(
			result.fn.instructions.some(
				(instruction) =>
					instruction.opcode === "CALL_KNOWN" &&
					instruction.operation === "Date.prototype.getTime",
			),
		).toBe(true);
		expect(result.structure.genericCalls).toBe(0);
	});
	it("discharges a bounded includes result into boolean IR", () => {
		const result = inspectStaticValueFunction(
			"function probe(input) { return [1, NaN, undefined].includes(input); } globalThis.probe = probe;",
			"probe",
		);
		expect(
			result.fn.instructions.some((instruction) => instruction.opcode === "CALL_KNOWN"),
		).toBe(false);
		expect(
			result.core.some(
				(instruction) =>
					instruction.opcode === "binary" && instruction.attributes.operator === "!==",
			),
		).toBe(true);
	});
	it("removes an unused includes result after its effects are discharged", () => {
		const result = inspectStaticValueFunction(
			"function probe(input) { [1, 2].includes(input); } globalThis.probe = probe;",
			"probe",
		);
		expect(
			result.fn.instructions.some((instruction) => instruction.opcode === "CALL_KNOWN"),
		).toBe(false);
		expect(result.structure.allocations).toBe(0);
	});
	it.each(["map(input)", "toSorted(input)"])(
		"retains observable work in an unused %s result",
		(operation) => {
			const result = inspectStaticValueFunction(
				`function probe(input) { [2, 1].${operation}; } globalThis.probe = probe;`,
				"probe",
			);
			expect(
				result.fn.instructions.some((instruction) => instruction.opcode === "CALL_KNOWN"),
			).toBe(true);
		},
	);
	it.each([
		"return Math.max.apply(null, value);",
		"return Reflect.apply(Math.max, null, value);",
		"return Math.max.bind(null, 7)(...value);",
		"return new Date(...value);",
		"return Reflect.construct(Date, value);",
		"return Date.prototype;",
	])(
		"preserves operation identity and argument modes through artifact caching: %s",
		(body) => {
			const { image } = inspectStaticValueFunction(
				`function probe(value) { ${body} } globalThis.probe = probe;`,
				"probe",
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored.runtime.functions).toEqual(image.runtime.functions);
			expect(restored.native.functions).toEqual(image.native.functions);
		},
	);
});
