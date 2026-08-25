import { expect, test } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import type {
	CoreFunction,
	CoreInstruction,
	CoreProgram,
} from "../src/compiler/core/core-ir.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";

function compileScript(source: string, evalCompletion = false) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"duplicate.js",
		parseScript(source, { strict: false }),
	);
	return lowerSemanticProgramToCore(semantic, { evalCompletion }).program;
}

function instructionsOf(fn: CoreFunction): Array<CoreInstruction> {
	return fn.blocks.flatMap((block) => block.instructions);
}

function functionsNamed(program: CoreProgram, name: string): Array<CoreFunction> {
	return program.functions.filter(
		(fn) =>
			String.fromCharCode(...program.stringConstants[fn.metadata.nameStringIndex]!) ===
			name,
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
		const values = instructionsOf(functions[0]!)
			.filter(({ opcode }) => opcode === "createNumber")
			.map(({ attributes }) => attributes.value);
		expect(values).toContain(2);
		expect(values).not.toContain(1);
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
		expect(
			instructionsOf(functions[0]!).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 2,
			),
		).toBe(true);
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
			instruction.opcode === "storeGlobalProperty" &&
			instruction.attributes.declaration === true &&
			instruction.attributes.nameStringIndex === nameIndex,
	);

	expect(stores).toHaveLength(2);
});
