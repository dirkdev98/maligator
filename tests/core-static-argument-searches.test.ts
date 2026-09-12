import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const entries = Array.from({ length: 32 }, (_, index) => index % 8).join(",");

describe("static search arguments across retained helpers", () => {
	it.each(["includes", "indexOf", "lastIndexOf"])(
		"specializes %s without materializing a private argument",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`const search = (xs, x) => xs.${method}(x);
				function probe(x) { return search([${entries}], x); }
				globalThis.probe = probe; globalThis.search = search;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
			expect(inspected.core.some((operation) => operation.opcode === "call")).toBe(true);
		},
	);

	it.each(["indexOf", "lastIndexOf"])(
		"specializes sparse %s arguments while preserving original indexes",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`const search = (xs, x) => xs.${method}(x);
				function probe(x) { return search([, undefined, NaN, -0, 1n, ${entries}], x); }
				globalThis.probe = probe; globalThis.search = search;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
		},
	);

	it.each(
		["includes", "indexOf", "lastIndexOf"].flatMap((method) =>
			[
				"0",
				"1.9",
				"-2.9",
				"99",
				"-99",
				"undefined",
				"null",
				"false",
				"true",
				'"2"',
				'"-2"',
				'""',
				'" 0x2 "',
				'"bad"',
			].map((offset) => ({
				method,
				offset,
			})),
		),
	)("specializes $method with helper-local offset $offset", ({ method, offset }) => {
		const inspected = inspectStaticValueFunction(
			`const search = (xs, x) => { const start = ${offset}; return xs.${method}(x, start); };
			function probe(x) { return search([${entries}], x); }
			globalThis.probe = probe; globalThis.search = search;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
	});

	it.each(["includes", "indexOf", "lastIndexOf"])(
		"specializes empty %s arguments without coercing a dynamic offset",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`const search = (xs, x, start) => xs.${method}(x, start);
				function probe(x, start) { return search([], x, start); }
				globalThis.probe = probe; globalThis.search = search;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
		},
	);

	it.each(["includes", "indexOf", "lastIndexOf"])(
		"routes %s through the runtime query when its helper offset is dynamic",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`const search = (xs, x, start) => xs.${method}(x, start);
				function probe(x, start) { return search([${entries}], x, start); }
				globalThis.probe = probe; globalThis.search = search;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
			expect(
				inspected.core.some((operation) => operation.opcode === "queryStaticData"),
			).toBe(true);
		},
	);

	it.each(["indexOf", "lastIndexOf"])(
		"retains %s inputs when a helper exposes their identity",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`const search = (xs, x) => { globalThis.observe(xs); return xs.${method}(x); };
				function probe(x) { return search([${entries}], x); }
				globalThis.probe = probe; globalThis.search = search;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBeGreaterThan(0);
		},
	);

	it("retains mutable prototype lookup in the original helper", () => {
		const inspected = inspectStaticValueFunction(
			`const search = (xs, x) => xs.indexOf(x);
			function probe(x) { return search([${entries}], x); }
			globalThis.probe = probe; globalThis.search = search;`,
			"probe",
			{ locked: false },
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
	});
});
