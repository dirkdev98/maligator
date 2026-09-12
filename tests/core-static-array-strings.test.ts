import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string, locked = true) {
	return inspectStaticValueFunction(
		`function probe(x, separator) { ${body} } globalThis.probe = probe;`,
		"probe",
		{ locked },
	);
}

function returnedString(result: ReturnType<typeof inspect>) {
	const instructions = result.fn.instructions;
	const returns = instructions.filter((instruction) => instruction.opcode === "RETURN");
	expect(returns).toHaveLength(1);
	let register = returns[0]!.value;
	for (let index = instructions.indexOf(returns[0]!) - 1; index >= 0; index--) {
		const instruction = instructions[index]!;
		if (!("dst" in instruction) || instruction.dst !== register) continue;
		if (instruction.opcode === "MOVE") {
			register = instruction.src;
			continue;
		}
		if (instruction.opcode !== "CREATE_STRING") return undefined;
		return String.fromCharCode(
			...result.image.runtime.stringConstants[instruction.stringIndex]!,
		);
	}
	return undefined;
}

describe("bounded static-array join", () => {
	it.each([
		["[].join()", ""],
		['["a", "b"].join()', "a,b"],
		['["a", "b"].join(undefined)', "a,b"],
		['["a", , null, undefined, "b"].join("|")', "a||||b"],
		["[, ,].join()", ","],
		[
			'[true, false, NaN, Infinity, -Infinity, -0, 2.5].join("|")',
			"true|false|NaN|Infinity|-Infinity|0|2.5",
		],
		[
			'[9007199254740993n, -9007199254740993n].join("/")',
			"9007199254740993/-9007199254740993",
		],
		['["a", "b"].join(null)', "anullb"],
		['["a", "b"].join(false)', "afalseb"],
		['["a", "b"].join(5n)', "a5b"],
		['["\\ud800", "\\udc00"].join("")', "\ud800\udc00"],
		['["\\ud800", "x"].join("\\udc00")', "\ud800\udc00x"],
	] as const)("materializes the primitive result of %s", (expression, expected) => {
		const result = inspect(`return ${expression};`);
		expect(returnedString(result)).toBe(expected);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "callKnown" &&
					operation.attributes.operation === "Array.prototype.join",
			),
		).toBe(false);
	});

	it("uses writes observed before the join", () => {
		const result = inspect(
			'const values = ["old", "tail"]; values[0] = "new"; return values.join("|");',
		);
		expect(returnedString(result)).toBe("new|tail");
	});

	it("preserves element, separator, and unused argument producers", () => {
		const result = inspect('return [(x(), "a"), (x(), "b")].join((x(), "|"), x());');
		expect(returnedString(result)).toBe("a|b");
		expect(result.structure.genericCalls).toBe(4);
	});

	it.each([
		'return [x].join("|");',
		'return ["a"].join(separator);',
		"return [].join(separator);",
		'return ["a"].join({ toString() { return "|"; } });',
		"return [].join({ toString() { return x(); } });",
		'return ["a"].join(Symbol());',
		"return [].join(Symbol());",
		'return [{ toString() { return "a"; } }].join("|");',
		'return [Symbol()].join("|");',
		'const values = ["a"]; values[0] = values; return values.join("|");',
		'const values = ["a"]; Object.defineProperty(values, "0", { get() { return x(); } }); return values.join("|");',
		'const values = [, "b"]; Object.setPrototypeOf(values, { get 0() { return x(); } }); return Array.prototype.join.call(values, "|");',
	])("retains coercion and observation for %s", (body) => {
		const result = inspect(body);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "builtinError" ||
					operation.opcode === "call" ||
					(operation.opcode === "callKnown" &&
						operation.attributes.operation === "Array.prototype.join"),
			),
		).toBe(true);
	});

	it("retains method lookup in mutable worlds", () => {
		const result = inspect('return ["a", "b"].join("|");', false);
		expect(returnedString(result)).toBeUndefined();
		expect(result.structure.genericLookups).toBeGreaterThan(0);
	});

	it.each([
		`return [${Array.from({ length: 257 }, () => '"a"').join(",")}].join("");`,
		`return [${JSON.stringify("a".repeat(4097))}].join("");`,
		`return ["a", "b"].join(${JSON.stringify("|".repeat(4097))});`,
		"return [170141183460469231731687303715884105728n].join();",
	])("retains target execution outside the proof budget", (body) => {
		const result = inspect(body);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "callKnown" &&
					operation.attributes.operation === "Array.prototype.join",
			),
		).toBe(true);
	});
});
