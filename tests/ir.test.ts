import { expect, test } from "vitest";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
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

test("direct arguments count and constant-index reads avoid object materialization", () => {
	const program = compileScript(`
		function count(){ return arguments.length; }
		function first(){ return arguments[0]; }
	`);
	const count = functionNamed(program, "count");
	const first = functionNamed(program, "first");

	expect(instructionsOf(count)).toContainEqual({
		type: "loadArgumentCount",
		registers: [0],
	});
	expect(instructionsOf(first)).toContainEqual({
		type: "loadArgument",
		registers: [0],
		index: 0,
	});
	for (const fn of [count, first]) {
		expect(fn.argumentsObjectRegister).toBeUndefined();
		expect(
			instructionsOf(fn).some(
				(instruction) => instruction.type === "createArgumentsObject",
			),
		).toBe(false);
	}

	const definition = lowerIrProgramToVmDefinition(program);
	expect(definition.functions[count.functionIndex]!.needsArguments).toBe(false);
	expect(definition.functions[first.functionIndex]!.needsArguments).toBe(true);
});

test("observable arguments object uses make direct reads fall back together", () => {
	const program = compileScript(`
		function escape(flag){ return flag ? arguments[0] : arguments; }
		function mutate(){ arguments[0] = 2; return arguments[0]; }
		function callee(){ return arguments.callee; }
		function outer(){ return () => arguments.length; }
	`);
	for (const name of ["escape", "mutate", "callee", "outer"]) {
		const fn = functionNamed(program, name);
		expect(
			instructionsOf(fn).some(
				(instruction) => instruction.type === "createArgumentsObject",
			),
		).toBe(true);
		expect(
			instructionsOf(fn).some(
				(instruction) =>
					instruction.type === "loadArgument" || instruction.type === "loadArgumentCount",
			),
		).toBe(false);
	}
});

test("direct eval conservatively materializes and marshals implicit arguments", () => {
	const program = compileScript(`function f(){ return eval("arguments[0]"); }`);
	const fn = functionNamed(program, "f");
	expect(
		instructionsOf(fn).some(
			(instruction) => instruction.type === "createArgumentsObject",
		),
	).toBe(true);
	const argumentsNameIndex = program.stringConstants.findIndex(
		(value) => String.fromCharCode(...value) === "arguments",
	);
	const instructions = instructionsOf(fn);
	const key = instructions.find(
		(instruction) =>
			instruction.type === "createString" &&
			instruction.stringIndex === argumentsNameIndex,
	);
	expect(key?.type).toBe("createString");
	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "storeProperty" &&
				key?.type === "createString" &&
				instruction.registers[1] === key.registers[0],
		),
	).toBe(true);
	expect(argumentsNameIndex).toBeGreaterThanOrEqual(0);
});

test("var declarations initialize once in the owning prologue", () => {
	const program = compileScript("before = x; var x; function f(){ return y; var y; }");
	const xNameIndex = program.stringConstants.findIndex(
		(codeUnits) => String.fromCharCode(...codeUnits) === "x",
	);
	const entryStores = instructionsOf(program.functions[0]!).filter(
		(instruction) =>
			instruction.type === "storeGlobalProperty" &&
			instruction.declaration &&
			instruction.nameStringIndex === xNameIndex,
	);
	expect(entryStores).toHaveLength(2);
	for (const store of entryStores) {
		expect(store).toMatchObject({
			type: "storeGlobalProperty",
			declaration: true,
			declarationConfigurable: false,
		});
	}

	const functionStores = instructionsOf(functionNamed(program, "f")).filter(
		(instruction) => instruction.type === "storeLocal",
	);
	expect(functionStores).toHaveLength(0);
});

test("hoisted closures do not claim captured var storage from their owner", () => {
	const program = compileScript(`
		function outer() {
			var value = 1;
			function read() { return value; }
			return read();
		}
		outer();
	`);
	const outer = functionNamed(program, "outer");
	const read = functionNamed(program, "read");
	const load = instructionsOf(read).find(
		(instruction) => instruction.type === "loadCaptured",
	);

	expect(read.nextCapturedIndex).toBe(0);
	expect(load).toMatchObject({
		type: "loadCaptured",
		functionIndex: outer.functionIndex,
	});
	if (load?.type !== "loadCaptured") return;
	expect(instructionsOf(outer)).toContainEqual(
		expect.objectContaining({
			type: "storeCaptured",
			functionIndex: outer.functionIndex,
			index: load.index,
		}),
	);
});

test("register allocation keeps distinct call operands live through the instruction", () => {
	const call: IRInstruction = { type: "call", registers: [2, 3, 1, 4] };
	const fn = {
		parameterCount: 0,
		nextRegisterDestination: 5,
		blocks: [
			{
				instructions: [{ type: "createObject", registers: [1] }, call],
			},
		],
	} as unknown as IRFunction;
	allocateRegisters({ functions: [fn] } as unknown as IntermediateProgram);

	expect(new Set(call.registers.slice(1)).size).toBe(3);
});

test("register allocation does not reuse registers in a non-SSA function", () => {
	const fn = {
		parameterCount: 0,
		nextRegisterDestination: 5,
		blocks: [
			{
				instructions: [
					{ type: "createUndefined", registers: [0] },
					{ type: "createNumber", registers: [1], value: 1 },
					{ type: "move", registers: [0, 1] },
					{ type: "createObject", registers: [2] },
					{ type: "call", registers: [3, 4, 2] },
				],
			},
		],
	} as unknown as IRFunction;
	allocateRegisters({ functions: [fn] } as unknown as IntermediateProgram);

	expect(fn.nextRegisterDestination).toBe(5);
});

test("eval var declarations create configurable globals", () => {
	const program = compileScript("var x;", true);
	expect(instructionsOf(program.functions[0]!)).toContainEqual(
		expect.objectContaining({
			type: "storeGlobalProperty",
			declaration: true,
			declarationConfigurable: true,
		}),
	);
});

test("strict global function declarations check properties before initialization", () => {
	const program = compileScript('"use strict"; function first(){} function second(){}');
	const instructions = instructionsOf(program.functions[0]!);
	const firstFunction = instructions.findIndex(
		(instruction) => instruction.type === "createFunction",
	);
	const declarationChecks = instructions
		.slice(0, firstFunction)
		.filter(
			(instruction) =>
				instruction.type === "storeGlobalProperty" && instruction.declaration,
		);
	const declarationInitializations = instructions
		.slice(firstFunction)
		.filter(
			(instruction) =>
				instruction.type === "storeGlobalProperty" && instruction.declaration,
		);

	expect(declarationChecks).toHaveLength(2);
	expect(declarationInitializations).toHaveLength(2);
	for (const store of [...declarationChecks, ...declarationInitializations]) {
		expect(store).toMatchObject({
			type: "storeGlobalProperty",
			declarationConfigurable: false,
		});
	}
	const lastDeclarationStore = instructions.lastIndexOf(declarationChecks[1]!);
	expect(lastDeclarationStore).toBeLessThan(firstFunction);
	expect(
		instructions.filter((instruction) => instruction.type === "createEmpty"),
	).toHaveLength(2);
});

test("explicit var arguments preserves the arguments object", () => {
	const program = compileScript(
		"function f(){ return typeof arguments; var arguments; } f(1)",
	);
	const instructions = instructionsOf(functionNamed(program, "f"));
	expect(
		instructions.filter((instruction) => instruction.type === "createArgumentsObject"),
	).toHaveLength(1);
	expect(
		instructions.filter((instruction) => instruction.type === "storeLocal"),
	).toHaveLength(1);
});

test("a default arguments parameter suppresses the arguments object", () => {
	const program = compileScript(
		"function f(arguments = 1){ var arguments; return arguments; } f()",
	);
	const instructions = instructionsOf(functionNamed(program, "f"));
	expect(
		instructions.filter((instruction) => instruction.type === "createArgumentsObject"),
	).toHaveLength(0);
	expect(
		instructions.filter((instruction) => instruction.type === "loadLocal"),
	).not.toHaveLength(0);
	expect(
		instructions.filter((instruction) => instruction.type === "storeLocal"),
	).not.toHaveLength(0);
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

test("bare empty blocks do not grow raw IR or disturb eval completion positions", () => {
	const emptyBlocks = Array.from({ length: 256 }, () => "{}").join("\n");
	const program = compileScript(`7;\n${emptyBlocks}\n42;\n{}`, true);
	const fn = program.functions[0]!;
	const instructions = instructionsOf(fn);

	expect(fn.blocks).toHaveLength(1);
	expect(program.sourcePositions).toEqual([
		{ line: 1, column: 0 },
		{ line: 258, column: 0 },
	]);
	expect(instructions.filter((instruction) => instruction.type === "sourcePos")).toEqual([
		{ type: "sourcePos", pos: 0 },
		{ type: "sourcePos", pos: 1 },
	]);

	const completionRegister = fn.completionRegister;
	expect(completionRegister).toBeDefined();
	if (completionRegister === undefined) {
		return;
	}
	const finalValue = instructions.find(
		(instruction) => instruction.type === "createNumber" && instruction.value === 42,
	);
	expect(finalValue?.type).toBe("createNumber");
	if (finalValue?.type !== "createNumber") {
		return;
	}
	expect(instructions).toContainEqual({
		type: "move",
		registers: [completionRegister, finalValue.registers[0]],
	});
	expect(instructions.at(-1)).toEqual({
		type: "return",
		registers: [completionRegister],
	});
});

test("structural empty loop and if bodies retain raw CFG blocks", () => {
	const program = compileScript("while (false) {}\nif (true) {}");
	const fn = program.functions[0]!;
	const branchBlocks = fn.blocks.flatMap((block, blockIndex) =>
		block.instructions.flatMap((instruction) =>
			instruction.type === "jumpIf" ? [{ blockIndex, instruction }] : [],
		),
	);

	expect(branchBlocks).toHaveLength(2);
	for (const { blockIndex, instruction } of branchBlocks) {
		expect(instruction.blocks[0]).toBeGreaterThanOrEqual(0);
		expect(instruction.blocks[0]).toBeLessThan(fn.blocks.length);
		const fallthrough = fn.blocks[blockIndex]!.instructions.find(
			(candidate) => candidate.type === "jump",
		);
		expect(fallthrough?.type).toBe("jump");
		if (fallthrough?.type === "jump") {
			expect(fallthrough.blocks[0]).not.toBe(instruction.blocks[0]);
		}
	}
	expect(
		branchBlocks.some(({ blockIndex, instruction }) =>
			fn.blocks[instruction.blocks[0]]!.instructions.some(
				(candidate) => candidate.type === "jump" && candidate.blocks[0] === blockIndex,
			),
		),
	).toBe(true);
});

test("declared script-global reads use the dedicated global property opcode", () => {
	const program = compileScript(
		"var observed = 1; function read() { return observed } read()",
	);
	const read = functionNamed(program, "read");
	const instructions = instructionsOf(read);

	expect(instructions).toContainEqual(
		expect.objectContaining({ type: "loadGlobalProperty" }),
	);
	expect(instructions.some((instruction) => instruction.type === "loadProperty")).toBe(
		false,
	);
	expect(instructions.some((instruction) => instruction.type === "loadIntrinsic")).toBe(
		false,
	);
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
