import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("static computed function names", () => {
	it.each([
		["Symbol.iterator", "[Symbol.iterator]"],
		["Symbol()", ""],
		['Symbol("")', "[]"],
		['Symbol("named")', "[named]"],
		['Symbol.for("registered")', "[registered]"],
	] as const)("prepares the immutable description of %s", (key, expected) => {
		const result = inspectStaticValueFunction(
			`function names() { const key = ${key}; return { [key]() {} }; }`,
			"names",
		);
		const naming = result.core.find(
			(operation) => operation.opcode === "setFunctionName",
		);
		expect(naming).toBeDefined();
		const prepared = result.core.find((operation) =>
			operation.outputs.includes(naming!.inputs[1]!),
		);
		expect(prepared?.opcode).toBe("createString");
		const runtimeNameIp = result.fn.instructions.findIndex(
			(instruction) => instruction.opcode === "SET_FUNCTION_NAME",
		);
		const runtimeName = result.fn.instructions[runtimeNameIp]!;
		if (runtimeName.opcode !== "SET_FUNCTION_NAME") throw new Error("Missing naming");
		const literal = result.fn.instructions
			.slice(0, runtimeNameIp)
			.findLast(
				(instruction) => "dst" in instruction && instruction.dst === runtimeName.key,
			);
		expect(literal?.opcode).toBe("CREATE_STRING");
		if (literal?.opcode !== "CREATE_STRING") throw new Error("Missing prepared name");
		expect(
			String.fromCharCode(...result.image.runtime.stringConstants[literal.stringIndex]!),
		).toBe(expected);
	});

	it.each([
		["mutable primordial access", "Symbol.iterator", false],
		["unknown symbol descriptions", "Symbol(value)", true],
	] as const)("retains dynamic naming for %s", (_scenario, key, locked) => {
		const result = inspectStaticValueFunction(
			`function names(value) { const key = ${key}; return { [key]() {} }; }`,
			"names",
			{ locked },
		);
		const naming = result.core.find(
			(operation) => operation.opcode === "setFunctionName",
		);
		const prepared = result.core.find((operation) =>
			operation.outputs.includes(naming!.inputs[1]!),
		);
		expect(prepared?.opcode).not.toBe("createString");
	});
});
