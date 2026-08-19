import { describe, expect, it } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";

function compile(source: string) {
	return compileSemanticProgramToVmDefinition(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			"static-property-test.js",
			parseScript(source, { strict: false }),
		),
	);
}

describe("static-key property operations", () => {
	it("folds constant keys and removes their CREATE_STRING instructions", () => {
		const definition = compile(
			`function f(o, value) { o.answer = value; return o.answer + o["other"]; } globalThis.keep = f;`,
		);
		const instructions = definition.functions.flatMap((fn) => fn.instructions);
		expect(
			instructions.filter(
				(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC",
			),
		).toHaveLength(2);
		expect(
			instructions.filter((instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC"),
		).toHaveLength(2);
		expect(
			instructions.filter((instruction) => instruction.opcode === "LOAD_PROPERTY"),
		).toHaveLength(0);
	});

	it("keeps computed dynamic keys on the generic operations", () => {
		const definition = compile(
			`function f(o, key, value) { o[key] = value; return o[key]; } globalThis.keep = f;`,
		);
		const instructions = definition.functions.flatMap((fn) => fn.instructions);
		expect(
			instructions.some((instruction) => instruction.opcode === "STORE_PROPERTY"),
		).toBe(true);
		expect(
			instructions.some((instruction) => instruction.opcode === "LOAD_PROPERTY"),
		).toBe(true);
	});
});
