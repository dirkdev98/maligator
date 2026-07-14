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

test("static nested data literals lower to one packed template instruction", () => {
	const program = compileScript(
		'const value = [1, "text", { foo: [, -0, true, null, 9n] }, 2, 3, 4, 5, 6, 7, 8];',
	);
	const instructions = instructionsOf(program.functions[0]!);
	const templates = instructions.filter(
		(instruction) => instruction.type === "instantiateLiteralTemplate",
	);

	expect(templates).toHaveLength(1);
	expect(program.literalTemplateData.length).toBeGreaterThan(0);
	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "createArray" || instruction.type === "defineProperty",
		),
	).toBe(false);
});

test("dynamic, special, or small literal members stay on ordinary lowering", () => {
	const program = compileScript(
		'let key = "x", source = []; const values = [[...source], { [key]: 1 }, { __proto__: null }, [/x/]];',
	);
	const instructions = instructionsOf(program.functions[0]!);

	expect(
		instructions.filter(
			(instruction) => instruction.type === "instantiateLiteralTemplate",
		),
	).toHaveLength(0);
	expect(instructions.some((instruction) => instruction.type === "createArray")).toBe(
		true,
	);
});

test("literal templates preserve exact f64 bits", () => {
	const expected = [
		-0,
		1.5,
		-2.25,
		Number.MIN_VALUE,
		2.2250738585072014e-308,
		Number.MAX_VALUE,
		Infinity,
	];
	const program = compileScript(
		"const values = [-0, 1.5, -2.25, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1e309, 1.1, 2.2, 3.3, 4.4];",
	);
	const data = program.literalTemplateData;
	let cursor = 2; // ARRAY tag + length
	for (const value of expected) {
		expect(data[cursor++]).toBe(4); // F64 tag
		const buffer = new ArrayBuffer(8);
		const view = new DataView(buffer);
		view.setUint32(0, data[cursor++]!, true);
		view.setUint32(4, data[cursor++]!, true);
		expect(Object.is(view.getFloat64(0, true), value)).toBe(true);
	}
});

test("array rest assignment captures and spills its member reference before draining", () => {
	const program = compileScript(
		'let target, source; function key(){ return "x" } [...target[key()]] = source;',
	);
	const instructions = instructionsOf(program.functions[0]!);
	const indexOf = (type: IRInstruction["type"]) =>
		instructions.findIndex((instruction) => instruction.type === type);

	expect(indexOf("getIterator")).toBeLessThan(indexOf("call"));
	expect(indexOf("call")).toBeLessThan(indexOf("iteratorStep"));
	expect(indexOf("iteratorStep")).toBeLessThan(indexOf("storeProperty"));
	expect(instructions.some((instruction) => instruction.type === "toPropertyKey")).toBe(
		false,
	);

	const storeIndices = instructions.flatMap((instruction) =>
		instruction.type === "storeLocal" ? [instruction.index] : [],
	);
	const loadIndices = instructions.flatMap((instruction) =>
		instruction.type === "loadLocal" ? [instruction.index] : [],
	);
	expect(storeIndices).toHaveLength(2);
	expect(loadIndices).toHaveLength(2);
	expect(loadIndices.sort()).toEqual(storeIndices.sort());
	expect(indexOf("tryEnd")).toBeLessThan(indexOf("iteratorStep"));
});

test("ordinary array assignment elements capture the target before stepping", () => {
	const program = compileScript(
		'let target, source; function key(){ return "x" } [target[key()]] = source;',
	);
	const instructions = instructionsOf(program.functions[0]!);
	const step = instructions.findIndex(
		(instruction) => instruction.type === "iteratorStep",
	);
	const call = instructions.findIndex((instruction) => instruction.type === "call");
	const store = instructions.findIndex(
		(instruction) => instruction.type === "storeProperty",
	);
	const begins = instructions
		.map((instruction, index) => (instruction.type === "tryBegin" ? index : -1))
		.filter((index) => index >= 0);
	const ends = instructions
		.map((instruction, index) => (instruction.type === "tryEnd" ? index : -1))
		.filter((index) => index >= 0);

	expect(step).toBeGreaterThanOrEqual(0);
	expect(begins).toHaveLength(2);
	expect(ends).toHaveLength(2);
	expect(begins[0]).toBeLessThan(call);
	expect(call).toBeLessThan(ends[0]!);
	expect(ends[0]).toBeLessThan(step);
	expect(step).toBeLessThan(begins[1]!);
	expect(call).toBeLessThan(step);
	expect(step).toBeLessThan(store);
	expect(store).toBeLessThan(ends[1]!);
	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "iteratorClose" && instruction.normal !== true,
		),
	).toBe(true);
});

test("array rest assignment spills and restores the super receiver", () => {
	const program = compileScript(
		'let source, key = "x"; class B {} class D extends B { assign(){ [...super[key]] = source; } }',
	);
	const fn = functionNamed(program, "assign");
	const instructions = instructionsOf(fn);
	const stores = instructions.filter((instruction) => instruction.type === "storeLocal");
	const loads = instructions.filter((instruction) => instruction.type === "loadLocal");

	expect(stores).toHaveLength(3);
	expect(loads).toHaveLength(3);
	expect(
		instructions.some((instruction) => instruction.type === "storeSuperProperty"),
	).toBe(true);
});
