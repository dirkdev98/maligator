import { expect, test } from "vitest";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compileScript(source: string, evalCompletion = false) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"test.js",
		parseScript(source, { strict: false }),
	);
	return compileSemanticProgramToIr(semantic, { evalCompletion });
}

function functionNamed(program: IntermediateProgram, name: string): IRFunction {
	const fn = program.functions.find(
		(candidate) =>
			String.fromCharCode(...program.stringConstants[candidate.nameStringIndex]!) ===
			name,
	);
	expect(fn).toBeDefined();
	return fn!;
}

function instructionsOf(fn: IRFunction): Array<IRInstruction> {
	return fn.blocks.flatMap((block) => block.instructions);
}

test("implicit arguments reads observe assignment through binding storage", () => {
	const program = compileScript("function f(){ arguments=42; return arguments } f()");
	const fn = functionNamed(program, "f");
	const instructions = instructionsOf(fn);
	const createArguments = instructions.find(
		(instruction) => instruction.type === "createArgumentsObject",
	);
	expect(createArguments?.type).toBe("createArgumentsObject");
	if (createArguments?.type !== "createArgumentsObject") {
		return;
	}

	expect(fn.argumentsObjectRegister).toBe(createArguments.registers[0]);
	const stores = instructions.filter((instruction) => instruction.type === "storeLocal");
	expect(stores).toHaveLength(2);
	expect(stores[0]).toMatchObject({
		registers: [createArguments.registers[0]],
		index: stores[1]!.type === "storeLocal" ? stores[1].index : -1,
	});
	const read = instructions.find((instruction) => instruction.type === "loadLocal");
	expect(read).toMatchObject({
		type: "loadLocal",
		index: stores[0]!.type === "storeLocal" ? stores[0].index : -1,
	});
});

test("eval-completion scripts retain global functions but DCE private declarations", () => {
	const program = compileScript(
		"function exposed(){ function privateFn(){} return 1 } 42",
		true,
	);
	const entryInstructions = instructionsOf(program.functions[0]!);

	expect(functionNamed(program, "exposed")).toBeDefined();
	expect(program.functions).toHaveLength(2);
	expect(
		entryInstructions.some((instruction) => instruction.type === "createFunction"),
	).toBe(true);
	expect(
		entryInstructions.some((instruction) => instruction.type === "storeGlobalProperty"),
	).toBe(true);
});
