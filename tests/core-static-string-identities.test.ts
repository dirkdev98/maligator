import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(expression: string, locked = true) {
	return inspectStaticValueFunction(
		`function probe(x, record) { return ${expression}; } globalThis.probe = probe;`,
		"probe",
		{ locked },
	);
}

describe("partial primitive string identities", () => {
	it.each([
		"",
		"0",
		"-0",
		"-0.9",
		"0.9",
		"NaN",
		"undefined",
		"null",
		"false",
		'"invalid"',
	])(
		"reduces dynamic string repeat(%s) to the empty string after receiver conversion",
		(count) => {
			const output = inspect(`String(x).repeat(${count}).length`);
			expect(
				output.core.some((operation) => operation.attributes.operation === "String"),
			).toBe(true);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === "String.prototype.repeat",
				),
			).toBe(false);
		},
	);

	it.each(["1", "1.9", "true", '" 1.9 "', '"0x1"'])(
		"forwards the immutable string for repeat(%s)",
		(count) => {
			const output = inspect(`String(x).repeat(${count})`);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === "String.prototype.repeat",
				),
			).toBe(false);
			expect(
				output.core.some((operation) => operation.attributes.operation === "String"),
			).toBe(true);
		},
	);

	it.each(["padStart", "padEnd"])(
		"forwards %s at zero target length without converting the filler",
		(method) => {
			for (const count of ["0", "-1", "-Infinity", "0.9", "NaN", '"-2"']) {
				const output = inspect(`String(x).${method}(${count}, record())`);
				expect(output.structure.genericCalls).toBe(1);
				expect(
					output.core.some(
						(operation) =>
							operation.attributes.operation === `String.prototype.${method}`,
					),
				).toBe(false);
			}
		},
	);

	it.each(["0", "1"])(
		"retains ignored repeat argument producers at count %s",
		(count) => {
			const output = inspect(`String(x).repeat((record(), ${count}), record())`);
			expect(output.structure.genericCalls).toBe(2);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === "String.prototype.repeat",
				),
			).toBe(false);
		},
	);

	it.each([
		"String.prototype.repeat.call(x, 0)",
		"String.prototype.repeat.call({ toString() { return x; } }, 1)",
		"String(x).repeat(record)",
		"String(x).repeat({ valueOf() { return 1; } })",
		"String(x).repeat(1n)",
		"String(x).padStart(0n, record)",
		"String(x).padEnd(record, record)",
	])("retains receiver or argument conversion in %s", (expression) => {
		const output = inspect(expression);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "builtinError" ||
					[
						"String.prototype.repeat",
						"String.prototype.padStart",
						"String.prototype.padEnd",
					].includes(operation.attributes.operation as string),
			),
		).toBe(true);
	});

	it.each(["padStart", "padEnd"])(
		"forwards %s with an empty primitive filler after length conversion",
		(method) => {
			for (const length of ["7", "Infinity", '"8"']) {
				const output = inspect(`String(x).${method}(${length}, "")`);
				expect(
					output.core.some(
						(operation) =>
							operation.attributes.operation === `String.prototype.${method}`,
					),
				).toBe(false);
				expect(
					output.core.some((operation) => operation.attributes.operation === "String"),
				).toBe(true);
			}
		},
	);

	it.each([
		'concat((record(), ""), (record(), ""), (record(), ""))',
		'padStart((record(), Infinity), (record(), ""), record())',
		'padEnd((record(), 20), (record(), ""), record())',
	])("retains all producers in empty-string %s", (methodCall) => {
		const output = inspect(`String(x).${methodCall}`);
		const method = methodCall.slice(0, methodCall.indexOf("("));
		expect(output.structure.genericCalls).toBe(3);
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === `String.prototype.${method}`,
			),
		).toBe(false);
	});

	it.each([
		'String(x).concat("", "suffix")',
		'String(x).concat("", 0)',
		'String(x).concat("", { toString() { return ""; } })',
		'String(x).padStart(0n, "")',
		'String(x).padEnd({ valueOf() { return 1; } }, "")',
		'String(x).padStart(Infinity, { toString() { return ""; } })',
		'String.prototype.padEnd.call(x, Infinity, "")',
	])("retains nonempty data or required conversion in %s", (expression) => {
		const output = inspect(expression);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "builtinError" ||
					[
						"String.prototype.concat",
						"String.prototype.padStart",
						"String.prototype.padEnd",
					].includes(operation.attributes.operation as string),
			),
		).toBe(true);
	});

	it.each([
		"slice()",
		"slice(0)",
		"slice(undefined, undefined)",
		"slice(NaN, Infinity)",
		'slice(-Infinity, "Infinity")',
		"slice(-0.9, Infinity)",
		"substring(-1, Infinity)",
		'substring("invalid", undefined)',
		"substring(-Infinity, Infinity)",
		"substr()",
		"substr(0)",
		"substr(-Infinity, Infinity)",
		"substr(undefined, undefined)",
		"substr(-0.9, Infinity)",
		"concat()",
		'concat("")',
		'concat("", "", "")',
	])("forwards the whole primitive string for %s", (methodCall) => {
		const output = inspect(`String(x).${methodCall}`);
		const method = methodCall.slice(0, methodCall.indexOf("("));
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === `String.prototype.${method}`,
			),
		).toBe(false);
		expect(
			output.core.some((operation) => operation.attributes.operation === "String"),
		).toBe(true);
	});

	it.each(["slice", "substring"])(
		"retains %s bound and extra argument producers",
		(method) => {
			const output = inspect(
				`String(x).${method}((record(), 0), (record(), undefined), record())`,
			);
			expect(output.structure.genericCalls).toBe(3);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === `String.prototype.${method}`,
				),
			).toBe(false);
		},
	);

	it.each([
		"String(x).slice(-1, Infinity)",
		"String(x).slice(0, 1)",
		"String(x).slice(0n, Infinity)",
		"String(x).slice(0, 1n)",
		"String(x).slice(0, record)",
		"String(x).slice({ valueOf() { return 0; } }, Infinity)",
		"String(x).substring(1, Infinity)",
		"String(x).substring(0, { valueOf() { return Infinity; } })",
		"String(x).substr(-1, Infinity)",
		"String(x).substr(1, 1)",
		"String(x).substr(0n, 0)",
		"String(x).substr(Infinity, 1n)",
		"String(x).substr({ valueOf() { return 0; } }, 0)",
		"String(x).substr(0, record)",
		"String(x).concat(record)",
		"String.prototype.slice.call(x, 0, Infinity)",
		"String.prototype.substring.call(x, 0, Infinity)",
		"String.prototype.substr.call(x, 0, Infinity)",
		"String.prototype.concat.call({ toString() { return x; } })",
	])("retains dynamic range or coercion behavior in %s", (expression) => {
		const output = inspect(expression);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "builtinError" ||
					[
						"String.prototype.slice",
						"String.prototype.substring",
						"String.prototype.substr",
						"String.prototype.concat",
					].includes(operation.attributes.operation as string),
			),
		).toBe(true);
	});

	it.each([
		"slice(2, 2)",
		"slice(5, 2)",
		"slice(-2, -5)",
		"slice(Infinity)",
		"slice(0, -Infinity)",
		"slice(-Infinity, -Infinity)",
		'slice("2.9", 2)',
		"substring(2, 2)",
		"substring(-2, -5)",
		"substring(0, null)",
		"substring(Infinity, Infinity)",
		"substr(1, 0)",
		"substr(-7, -1)",
		"substr(Infinity)",
		"substr(0, NaN)",
		"substr(-Infinity, null)",
	])("reduces %s to an empty string for every receiver length", (methodCall) => {
		const output = inspect(`String(x).${methodCall}.length`);
		const method = methodCall.slice(0, methodCall.indexOf("("));
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === `String.prototype.${method}`,
			),
		).toBe(false);
		expect(
			output.core.some((operation) => operation.attributes.operation === "String"),
		).toBe(true);
	});

	it.each(["includes", "startsWith", "endsWith"])(
		"folds empty primitive needle %s after certified position conversion",
		(method) => {
			for (const position of [
				"",
				", undefined",
				", -Infinity",
				", Infinity",
				', "1.9"',
			]) {
				const output = inspect(`String(x).${method}(""${position})`);
				expect(
					output.core.some(
						(operation) =>
							operation.attributes.operation === `String.prototype.${method}`,
					),
				).toBe(false);
				expect(
					output.core
						.filter((operation) => operation.opcode === "createBoolean")
						.map((operation) => operation.attributes.value),
				).toEqual([true]);
			}
		},
	);

	it.each([
		"slice((record(), 5), (record(), 2), record())",
		"substring((record(), -5), (record(), -2), record())",
		'includes((record(), ""), (record(), Infinity), record())',
		'startsWith((record(), ""), (record(), -Infinity), record())',
		'endsWith((record(), ""), (record(), undefined), record())',
	])("retains argument producers in constant-result %s", (methodCall) => {
		const output = inspect(`String(x).${methodCall}`);
		expect(output.structure.genericCalls).toBe(3);
		const method = methodCall.slice(0, methodCall.indexOf("("));
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === `String.prototype.${method}`,
			),
		).toBe(false);
	});

	it.each([
		"String(x).slice(Infinity, 0n)",
		"String(x).substring(0n, 0n)",
		'String(x).includes("", 0n)',
		'String(x).startsWith("", Symbol.iterator)',
		'String(x).endsWith("", { valueOf() { return 0; } })',
		'String.prototype.includes.call(x, "", 0)',
		'String.prototype.startsWith.call({ toString() { return x; } }, "", 0)',
		'String(x).includes({ [Symbol.match]: true, toString() { return ""; } }, 0)',
		"String(x).endsWith(record, 0)",
	])("retains protocol checks and coercions in %s", (expression) => {
		const output = inspect(expression);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "builtinError" ||
					[
						"String.prototype.slice",
						"String.prototype.substring",
						"String.prototype.includes",
						"String.prototype.startsWith",
						"String.prototype.endsWith",
					].includes(operation.attributes.operation as string),
			),
		).toBe(true);
	});

	it.each(["repeat(1)", "slice(0, Infinity)", "substring(0, undefined)", "concat()"])(
		"keeps mutable %s lookup observable",
		(methodCall) => {
			const output = inspect(`String(x).${methodCall}`, false);
			expect(output.structure.genericLookups).toBeGreaterThan(0);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
		},
	);
});
