import { expect, test } from "vitest";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compileScript(source: string, evalCompletion = false) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"duplicate.js",
		parseScript(source, { strict: false }),
	);
	return compileSemanticProgramToIr(semantic, { evalCompletion });
}

function instructionsOf(fn: IRFunction): Array<IRInstruction> {
	return fn.blocks.flatMap((block) => block.instructions);
}

function functionsNamed(program: IntermediateProgram, name: string): Array<IRFunction> {
	return program.functions.filter(
		(fn) => String.fromCharCode(...program.stringConstants[fn.nameStringIndex]!) === name,
	);
}

test.each([
	["sloppy Script", "function f(){ return 1 } function f(){ return 2 } f()", false],
	[
		"strict Script",
		'"use strict"; function f(){ return 1 } function f(){ return 2 } f()',
		false,
	],
	["eval Script", "function f(){ return 1 } function f(){ return 2 } f()", true],
] as const)(
	"duplicate functions select the final body in a %s",
	(_name, source, evalCompletion) => {
		const functions = functionsNamed(compileScript(source, evalCompletion), "f");

		expect(functions).toHaveLength(1);
		expect(instructionsOf(functions[0]!)).toContainEqual(
			expect.objectContaining({ type: "createNumber", value: 2 }),
		);
		expect(instructionsOf(functions[0]!)).not.toContainEqual(
			expect.objectContaining({ type: "createNumber", value: 1 }),
		);
	},
);

test.each([false, true])(
	"duplicate function-body declarations select the final body (strict=%s)",
	(strict) => {
		const directive = strict ? '"use strict";' : "";
		const functions = functionsNamed(
			compileScript(
				`${directive} function outer(){ function f(){ return 1 } function f(){ return 2 } return f() } outer()`,
			),
			"f",
		);

		expect(functions).toHaveLength(1);
		expect(instructionsOf(functions[0]!)).toContainEqual(
			expect.objectContaining({ type: "createNumber", value: 2 }),
		);
	},
);

test("duplicate global functions perform one declaration check and initialization", () => {
	const program = compileScript("function f(){} function f(){} f()", true);
	const instructions = instructionsOf(program.functions[0]!);
	const nameIndex = program.stringConstants.findIndex(
		(value) => String.fromCharCode(...value) === "f",
	);
	const stores = instructions.filter(
		(instruction) =>
			instruction.type === "storeGlobalProperty" &&
			instruction.declaration &&
			instruction.nameStringIndex === nameIndex,
	);

	expect(stores).toHaveLength(2);
});
