import { expect, test } from "vitest";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import {
	computeArgumentRetentionLimit,
	lowerIrProgramToVmDefinition,
} from "../src/lower-vm.ts";
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

test("bulk-constructs wide static-key object literals", () => {
	const properties = Array.from(
		{ length: 48 },
		(_, index) => `field${index}: seed + ${index}`,
	).join(",");
	const program = compileScript(
		`function make(seed) { return { ${properties} }; } globalThis.make = make;`,
	);
	executeIROptimizations(program);
	const instructions = program.functions.flatMap(instructionsOf);
	const shaped = instructions.find(
		(instruction) =>
			instruction.type === "createObjectShaped" &&
			instruction.keyStringIndices.length === 48,
	);
	expect(shaped).toBeDefined();
});

test("accepts non-index numeric-looking names in static shapes", () => {
	const program = compileScript(`globalThis.value = { "01": 1, "1e3": 2, "-1": 3 };`);
	executeIROptimizations(program);
	const instructions = program.functions.flatMap(instructionsOf);
	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "createObjectShaped" &&
				instruction.keyStringIndices.length === 3,
		),
	).toBe(true);
});

test("reuses an otherwise-unobserved object rest value for a leading spread", () => {
	const program = compileScript(`
		function normalize({ id, ...rest }) {
			return { ...rest, id };
		}
		globalThis.normalize = normalize;
	`);
	executeIROptimizations(program);
	const instructions = instructionsOf(functionNamed(program, "normalize"));
	expect(
		instructions.filter((instruction) => instruction.type === "copyDataProperties"),
	).toHaveLength(1);
	expect(
		instructions.filter((instruction) => instruction.type === "createObject"),
	).toHaveLength(0);
	expect(
		instructions.filter((instruction) => instruction.type === "mergeDataProperties"),
	).toHaveLength(0);
});

test("keeps a leading spread target when the object rest identity is observed", () => {
	const program = compileScript(`
		function normalize({ id, ...rest }) {
			globalThis.rest = rest;
			return { ...rest, id };
		}
		globalThis.normalize = normalize;
	`);
	executeIROptimizations(program);
	const instructions = instructionsOf(functionNamed(program, "normalize"));
	expect(
		instructions.filter((instruction) => instruction.type === "createObject"),
	).toHaveLength(1);
	expect(
		instructions.filter((instruction) => instruction.type === "mergeDataProperties"),
	).toHaveLength(1);
});

test("canonicalizes a computed object-rest exclusion once", () => {
	const program = compileScript(`
		function omit(source, key) {
			const { [key]: removed, ...rest } = source;
			return [removed, rest];
		}
		globalThis.omit = omit;
	`);
	const instructions = instructionsOf(functionNamed(program, "omit"));
	const conversions = instructions.filter(
		(instruction) => instruction.type === "toPropertyKey",
	);
	expect(conversions).toHaveLength(1);
	const canonicalKey = conversions[0]!.registers[0];
	const load = instructions.find((instruction) => instruction.type === "loadProperty");
	const copy = instructions.find(
		(instruction) => instruction.type === "copyDataProperties",
	);
	expect(load?.registers[2]).toBe(canonicalKey);
	expect(copy?.registers.slice(2)).toContain(canonicalKey);
});

test("generator class computed keys suspend in class-element source order", () => {
	const program = compileScript(`
		function* define() {
			class C {
				[(yield 11)];
				[(yield 22)]() {}
				static [(yield 33)] = initializeStatic();
				get [(yield 44)]() {}
			}
			return C;
		}
	`);
	const define = functionNamed(program, "define");
	const defineInstructions = instructionsOf(define);
	const yieldedValues = defineInstructions.flatMap((instruction) => {
		if (instruction.type !== "yield") return [];
		const source = defineInstructions.find(
			(candidate) =>
				candidate.type === "createNumber" &&
				candidate.registers[0] === instruction.registers[2],
		);
		return source?.type === "createNumber" ? [source.value] : [];
	});

	expect(yieldedValues).toEqual([11, 22, 33, 44]);
	expect(
		defineInstructions.filter((instruction) => instruction.type === "toPropertyKey"),
	).toHaveLength(4);
	expect(
		program.functions
			.filter((fn) => fn !== define)
			.flatMap(instructionsOf)
			.some((instruction) => instruction.type === "toPropertyKey"),
	).toBe(false);
	const constructorInstructions = instructionsOf(functionNamed(program, "C"));
	const instanceFieldDefinition = constructorInstructions.find(
		(instruction) =>
			instruction.type === "defineProperty" && instruction.enumerable === true,
	);
	expect(instanceFieldDefinition?.type).toBe("defineProperty");
	if (instanceFieldDefinition?.type !== "defineProperty") return;
	expect(constructorInstructions).toContainEqual(
		expect.objectContaining({
			type: "loadCaptured",
			registers: [instanceFieldDefinition.registers[1]],
		}),
	);

	const staticInitializer = program.functions.find((fn) => {
		if (fn === define) return false;
		const instructions = instructionsOf(fn);
		return (
			instructions.some((instruction) => instruction.type === "loadThis") &&
			instructions.some((instruction) => instruction.type === "loadCaptured") &&
			instructions.some((instruction) => instruction.type === "call") &&
			instructions.some(
				(instruction) =>
					instruction.type === "defineProperty" && instruction.enumerable === true,
			)
		);
	});
	expect(staticInitializer).toBeDefined();
	if (!staticInitializer) return;
	const staticInstructions = instructionsOf(staticInitializer);
	const fieldDefinition = staticInstructions.find(
		(instruction) =>
			instruction.type === "defineProperty" && instruction.enumerable === true,
	);
	expect(fieldDefinition?.type).toBe("defineProperty");
	if (fieldDefinition?.type !== "defineProperty") return;
	expect(staticInstructions).toContainEqual(
		expect.objectContaining({
			type: "loadCaptured",
			registers: [fieldDefinition.registers[1]],
		}),
	);
	expect(
		staticInstructions.some(
			(instruction) =>
				instruction.type === "call" &&
				instruction.registers[0] === fieldDefinition.registers[2],
		),
	).toBe(true);
	expect(
		staticInstructions.some(
			(instruction) =>
				instruction.type === "yield" || instruction.type === "toPropertyKey",
		),
	).toBe(false);
});

test("async class computed keys await in class-element source order", () => {
	const program = compileScript(`
		async function define() {
			const C = class {
				[await 11];
				[await 22]() {}
				static [await 33];
			};
			return C;
		}
	`);
	const define = functionNamed(program, "define");
	const defineInstructions = instructionsOf(define);
	const awaitedValues = defineInstructions.flatMap((instruction) => {
		if (instruction.type !== "await") return [];
		const source = defineInstructions.find(
			(candidate) =>
				candidate.type === "createNumber" &&
				candidate.registers[0] === instruction.registers[2],
		);
		return source?.type === "createNumber" ? [source.value] : [];
	});

	expect(awaitedValues).toEqual([11, 22, 33]);
	expect(
		defineInstructions.filter((instruction) => instruction.type === "toPropertyKey"),
	).toHaveLength(3);
	expect(
		program.functions
			.filter((fn) => fn !== define)
			.flatMap(instructionsOf)
			.some((instruction) => instruction.type === "await"),
	).toBe(false);
});

test("computed field keys retain the class private environment", () => {
	const program = compileScript(`
		let read;
		class C {
			static #value = 42;
			static [(class {}, read = () => C.#value)];
		}
	`);

	expect(
		program.functions
			.flatMap(instructionsOf)
			.some((instruction) => instruction.type === "loadPrivate"),
	).toBe(true);
});

test("named class inner bindings stay in the TDZ through computed keys", () => {
	const program = compileScript(`
		(class Inner {
			[Inner]() {}
			static value = Inner;
		});
	`);
	const instructions = instructionsOf(program.functions[0]!);
	const nameStringIndex = program.stringConstants.findIndex(
		(value) => String.fromCharCode(...value) === "Inner",
	);
	const guardIndex = instructions.findIndex(
		(instruction) =>
			instruction.type === "throwIfTdz" &&
			instruction.nameStringIndex === nameStringIndex,
	);
	expect(guardIndex).toBeGreaterThanOrEqual(0);
	const guard = instructions[guardIndex];
	if (guard?.type !== "throwIfTdz") return;
	const load = instructions.find(
		(instruction) =>
			(instruction.type === "loadLocal" || instruction.type === "loadCaptured") &&
			instruction.registers[0] === guard.registers[0],
	);
	expect(load).toBeDefined();
	if (load?.type !== "loadLocal" && load?.type !== "loadCaptured") return;
	const stores = instructions.flatMap((instruction, index) => {
		if (load.type === "loadLocal") {
			return instruction.type === "storeLocal" && instruction.index === load.index
				? [{ instruction, index }]
				: [];
		}
		return instruction.type === "storeCaptured" &&
			instruction.functionIndex === load.functionIndex &&
			instruction.index === load.index
			? [{ instruction, index }]
			: [];
	});
	expect(stores).toHaveLength(2);
	expect(stores[0]!.index).toBeLessThan(guardIndex);
	expect(stores[1]!.index).toBeGreaterThan(guardIndex);
	expect(instructions).toContainEqual(
		expect.objectContaining({
			type: "createEmpty",
			registers: [stores[0]!.instruction.registers[0]],
		}),
	);
	expect(instructions).toContainEqual(
		expect.objectContaining({
			type: "createFunction",
			registers: [stores[1]!.instruction.registers[0]],
		}),
	);
});

test("named class inner assignments use const TDZ semantics", () => {
	const program = compileScript(`(class Inner extends (Inner = Object) {});`);
	const innerScope = program.semantic.files[0]!.scopes.find(
		(scope) => scope.node.type === "ClassExpression",
	);
	const binding = innerScope?.bindings.find((candidate) => candidate.name === "Inner");
	expect(binding).toMatchObject({ kind: "const" });
	expect(binding?.immutableSelfReference).toBeUndefined();

	const nameStringIndex = program.stringConstants.findIndex(
		(value) => String.fromCharCode(...value) === "Inner",
	);
	expect(instructionsOf(program.functions[0]!)).toContainEqual(
		expect.objectContaining({
			type: "throwIfTdz",
			nameStringIndex,
		}),
	);
});

test("field initializer context propagates through lexical arrows", () => {
	const program = compileScript(`
		class C {
			field = () => eval("arguments");
		}
	`);

	expect(program.functions.some((fn) => fn.inFieldInitializer)).toBe(true);
});

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

test("direct arguments reads avoid eager object materialization", () => {
	const program = compileScript(`
		function count(){ return arguments.length; }
		function first(){ return arguments[0]; }
		function third(){ return arguments[2]; }
	`);
	const count = functionNamed(program, "count");
	const first = functionNamed(program, "first");
	const third = functionNamed(program, "third");

	expect(instructionsOf(count)).toContainEqual({
		type: "loadArgumentCount",
		registers: [0],
	});
	expect(instructionsOf(first)).toContainEqual({
		type: "loadStaticArgument",
		registers: [2, 0, 1],
		index: 0,
	});
	expect(count.argumentsObjectRegister).toBeUndefined();
	expect(
		instructionsOf(count).some(
			(instruction) => instruction.type === "createArgumentsObject",
		),
	).toBe(false);
	expect(first.argumentsObjectRegister).toBeDefined();
	expect(
		instructionsOf(first).some(
			(instruction) => instruction.type === "createArgumentsObject",
		),
	).toBe(false);

	const definition = lowerIrProgramToVmDefinition(program);
	expect(definition.functions[count.functionIndex]!.needsArguments).toBe(false);
	expect(definition.functions[first.functionIndex]!.needsArguments).toBe(true);
	expect(definition.functions[third.functionIndex]!.needsArguments).toBe(true);
	expect(computeArgumentRetentionLimit(definition.functions[count.functionIndex]!)).toBe(
		-1,
	);
	expect(computeArgumentRetentionLimit(definition.functions[first.functionIndex]!)).toBe(
		0,
	);
	expect(computeArgumentRetentionLimit(definition.functions[third.functionIndex]!)).toBe(
		2,
	);
	expect(
		computeArgumentRetentionLimit({
			argumentSnapshotCount: 0,
			instructions: [{ opcode: "CREATE_ARGUMENTS_OBJECT", dst: 0 }],
		}),
	).toBe(0x7fffffff);
	expect(definition.functions[count.functionIndex]!.argumentSnapshotCount).toBe(1);
	expect(definition.functions[first.functionIndex]!.argumentSnapshotCount).toBe(1);
});

test("repeated static arguments reads share one snapshot per count or index", () => {
	const program = compileScript(`
		function repeated() {
			return arguments.length + arguments[2] + arguments.length + arguments[2] + arguments[0];
		}
	`);
	const repeated = functionNamed(program, "repeated");
	const snapshots = instructionsOf(repeated).filter(
		(instruction) =>
			instruction.type === "loadArgumentCount" || instruction.type === "loadArgument",
	);
	expect(snapshots).toEqual([
		{ type: "loadArgumentCount", registers: [0] },
		{ type: "loadArgument", registers: [1], index: 2 },
		{ type: "loadArgument", registers: [2], index: 0 },
	]);
	expect(
		instructionsOf(repeated).filter(
			(instruction) => instruction.type === "loadStaticArgument",
		),
	).toHaveLength(3);

	const lowered =
		lowerIrProgramToVmDefinition(program).functions[repeated.functionIndex]!;
	expect(lowered.argumentSnapshotCount).toBe(3);
	expect(
		lowered.instructions.slice(0, 3).map((instruction) => instruction.opcode),
	).toEqual(["LOAD_ARGUMENT_COUNT", "LOAD_ARGUMENT", "LOAD_ARGUMENT"]);
});

test("try markers lower only into exception handler ranges", () => {
	const program = compileScript(`
		function guarded(value) {
			try {
				if (value) throw value;
				return 2;
			} catch (error) {
				return error;
			}
		}
	`);
	const guarded = functionNamed(program, "guarded");
	executeIROptimizations(program);
	allocateRegisters(program);
	const lowered = lowerIrProgramToVmDefinition(program).functions[guarded.functionIndex]!;

	expect(
		lowered.instructions.some(
			(instruction) =>
				instruction.opcode === "TRY_BEGIN" || instruction.opcode === "TRY_END",
		),
	).toBe(false);
	expect(lowered.handlers).toHaveLength(1);
	const handler = lowered.handlers[0]!;
	expect(handler.startIp).toBeLessThan(handler.endIp);
	expect(lowered.instructions[handler.handlerIp]?.opcode).toBe("CATCH");
	expect(lowered.positions).toHaveLength(lowered.instructions.length);
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

test("direct eval marshals global lexical but not global property bindings", () => {
	const program = compileScript(`
		var propertyBacked = 1;
		let lexical = 2;
		eval("propertyBacked + lexical");
	`);
	const instructions = instructionsOf(program.functions[0]!);
	const nameIndex = (name: string) =>
		program.stringConstants.findIndex((value) => String.fromCharCode(...value) === name);
	const propertyNameIndex = nameIndex("propertyBacked");
	const lexicalNameIndex = nameIndex("lexical");

	expect(propertyNameIndex).toBeGreaterThanOrEqual(0);
	expect(lexicalNameIndex).toBeGreaterThanOrEqual(0);
	expect(instructions).not.toContainEqual(
		expect.objectContaining({
			type: "loadGlobalProperty",
			nameStringIndex: propertyNameIndex,
		}),
	);
	const lexicalLoad = instructions.find(
		(instruction) => instruction.type === "loadGlobal",
	);
	const lexicalKey = instructions.find(
		(instruction) =>
			instruction.type === "createString" && instruction.stringIndex === lexicalNameIndex,
	);
	expect(lexicalLoad?.type).toBe("loadGlobal");
	expect(lexicalKey?.type).toBe("createString");
	if (lexicalLoad?.type !== "loadGlobal" || lexicalKey?.type !== "createString") {
		return;
	}
	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "storeProperty" &&
				instruction.registers.includes(lexicalKey.registers[0]) &&
				instruction.registers.includes(lexicalLoad.registers[0]),
		),
	).toBe(true);
});

test("nested direct eval marshals script-global property bindings", () => {
	const program = compileScript(`
		var globalValue = 1;
		function read() { return eval("globalValue"); }
		read();
	`);
	const instructions = instructionsOf(functionNamed(program, "read"));
	const nameStringIndex = program.stringConstants.findIndex(
		(value) => String.fromCharCode(...value) === "globalValue",
	);

	expect(instructions).toContainEqual(
		expect.objectContaining({ type: "loadGlobalProperty", nameStringIndex }),
	);
});

test("contiguous global var initializations batch after scalar declaration checks", () => {
	const program = compileScript(
		"before = x; var x, y, z; function f(){ return local; var local; }",
	);
	const nameIndices = ["x", "y", "z"].map((name) =>
		program.stringConstants.findIndex(
			(codeUnits) => String.fromCharCode(...codeUnits) === name,
		),
	);
	const entryInstructions = instructionsOf(program.functions[0]!);
	const declarationChecks = entryInstructions
		.filter(
			(instruction) =>
				instruction.type === "storeGlobalProperty" && instruction.declaration,
		)
		.filter(
			(instruction) =>
				instruction.type === "storeGlobalProperty" &&
				nameIndices.includes(instruction.nameStringIndex),
		);
	expect(declarationChecks).toHaveLength(3);
	expect(
		entryInstructions.filter((instruction) => instruction.type === "createNull"),
	).toHaveLength(3);
	expect(
		entryInstructions.filter((instruction) => instruction.type === "initGlobalVars"),
	).toEqual([
		{
			type: "initGlobalVars",
			nameStringIndices: nameIndices,
			declarationConfigurable: false,
		},
	]);
	expect(entryInstructions.indexOf(declarationChecks[2]!)).toBeLessThan(
		entryInstructions.findIndex((instruction) => instruction.type === "initGlobalVars"),
	);

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

test("captured block functions reserve storage before compiling nested direct eval", () => {
	const program = compileScript(`
		function outer() {
			"use strict";
			{
				function capturedBlock() { return eval("capturedBlock"); }
				return capturedBlock;
			}
		}
		outer();
	`);
	const outer = functionNamed(program, "outer");
	const capturedBlock = functionNamed(program, "capturedBlock");
	const load = instructionsOf(capturedBlock).find(
		(instruction) => instruction.type === "loadCaptured",
	);

	expect(capturedBlock.nextCapturedIndex).toBe(0);
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

test("register allocation safely reuses registers in a non-SSA function", () => {
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

	expect(fn.nextRegisterDestination).toBe(4);
});

test("register allocation does not reuse a loop temporary for a loop-carried value", () => {
	const iteratorStep: IRInstruction = {
		type: "iteratorStep",
		registers: [4, 5, 2, 3],
	};
	const carry: IRInstruction = { type: "move", registers: [6, 4] };
	const fn = {
		parameterCount: 0,
		nextRegisterDestination: 7,
		blocks: [
			{
				instructions: [
					{ type: "createString", registers: [0], stringIndex: 0 },
					{ type: "forInKeys", registers: [1, 0] },
					{ type: "getIterator", registers: [2, 3, 1] },
					{ type: "jump", blocks: [1] },
				],
			},
			{
				instructions: [
					iteratorStep,
					{ type: "jumpIf", registers: [5], blocks: [2] },
					carry,
					{ type: "jump", blocks: [1] },
				],
			},
			{ instructions: [{ type: "return", registers: [6] }] },
		],
	} as unknown as IRFunction;
	allocateRegisters({ functions: [fn] } as unknown as IntermediateProgram);

	expect(iteratorStep.registers[1]).not.toBe(carry.registers[0]);
});

test("eval var declarations create configurable globals", () => {
	const program = compileScript("var x, y;", true);
	const instructions = instructionsOf(program.functions[0]!);
	expect(
		instructions.filter(
			(instruction) =>
				instruction.type === "storeGlobalProperty" && instruction.declaration,
		),
	).toHaveLength(2);
	expect(instructions).toContainEqual(
		expect.objectContaining({ type: "initGlobalVars", declarationConfigurable: true }),
	);
});

test("private names and initializer-free private field runs lower in bulk", () => {
	const program = compileScript(`
		function make() {
			return class {
				#a;
				#b;
				#initialized = 1;
				#d;
				#e;
				#method() {}
				get #accessor() { return 1; }
			};
		}
	`);
	const make = functionNamed(program, "make");
	const constructor = program.functions.find((fn) => fn.classContext?.isConstructor);
	expect(constructor).toBeDefined();

	expect(
		instructionsOf(make).filter(
			(instruction) => instruction.type === "createPrivateNames",
		),
	).toEqual([
		expect.objectContaining({
			type: "createPrivateNames",
			functionIndex: make.functionIndex,
		}),
	]);
	const nameBatch = instructionsOf(make).find(
		(instruction) => instruction.type === "createPrivateNames",
	);
	expect(
		nameBatch?.type === "createPrivateNames" ? nameBatch.capturedIndices : [],
	).toHaveLength(6);

	const privateInitializers = instructionsOf(constructor!).filter(
		(instruction) =>
			instruction.type === "definePrivate" || instruction.type === "initPrivateFields",
	);
	expect(privateInitializers.map((instruction) => instruction.type)).toEqual([
		"definePrivate",
		"initPrivateFields",
		"definePrivate",
		"initPrivateFields",
	]);
	expect(
		privateInitializers
			.filter((instruction) => instruction.type === "initPrivateFields")
			.map((instruction) => instruction.registers.length - 1),
	).toEqual([2, 2]);

	executeIROptimizations(program);
	allocateRegisters(program);
	const definition = lowerIrProgramToVmDefinition(program);
	const loweredNameBatch = definition.functions[make.functionIndex]!.instructions.find(
		(instruction) => instruction.opcode === "CREATE_PRIVATE_NAMES",
	);
	expect(loweredNameBatch?.opcode).toBe("CREATE_PRIVATE_NAMES");
	expect(
		loweredNameBatch?.opcode === "CREATE_PRIVATE_NAMES"
			? loweredNameBatch.capturedIndices.length
			: 0,
	).toBe(6);
	expect(
		definition.functions[constructor!.functionIndex]!.instructions.filter(
			(instruction) => instruction.opcode === "INIT_PRIVATE_FIELDS",
		).map((instruction) =>
			instruction.opcode === "INIT_PRIVATE_FIELDS" ? instruction.keyRegisters.length : 0,
		),
	).toEqual([2, 2]);

	const vmInstructions = definition.functions.flatMap((fn) => fn.instructions);
	const scalarizedCount = vmInstructions.reduce((count, instruction) => {
		if (instruction.opcode === "CREATE_PRIVATE_NAMES") {
			return count + instruction.capturedIndices.length * 2;
		}
		if (instruction.opcode === "INIT_PRIVATE_FIELDS") {
			// The batch's shared LOAD_THIS and per-key LOAD_CAPTURED remain in the
			// stream. Scalar lowering additionally needs N undefined values, N
			// DEFINE_PRIVATE ops, and N-1 extra LOAD_THIS ops.
			return count + instruction.keyRegisters.length * 3 - 1;
		}
		return count + 1;
	}, 0);
	expect(scalarizedCount - vmInstructions.length).toBe(19);
});

test("private destructuring and loop targets lower to brand-checked stores", () => {
	const program = compileScript(`
		class C {
			#field;
			write(source) {
				for (this.#field of source) break;
				for (this.#field in source) break;
				[this.#field] = source;
				[...this.#field] = source;
				({ value: this.#field } = source);
				({ ...this.#field } = source);
			}
		}
	`);
	const instructions = instructionsOf(functionNamed(program, "write"));
	expect(
		instructions.filter((instruction) => instruction.type === "storePrivate"),
	).toHaveLength(6);

	const orderingProgram = compileScript(`
		class Ordering {
			#field;
			write(source) {
				({ value: this.#field } = source);
			}
		}
	`);
	const ordering = instructionsOf(functionNamed(orderingProgram, "write"));
	const objectTargetReceiver = ordering.findIndex(
		(instruction) => instruction.type === "loadThis",
	);
	const objectTargetRead = ordering.findIndex(
		(instruction) => instruction.type === "loadProperty",
	);
	const objectTargetStore = ordering.findIndex(
		(instruction) => instruction.type === "storePrivate",
	);
	expect(objectTargetReceiver).toBeGreaterThanOrEqual(0);
	expect(objectTargetRead).toBeGreaterThan(objectTargetReceiver);
	expect(objectTargetStore).toBeGreaterThan(objectTargetRead);
});

test("Annex B global var initialization remains an EMPTY scalar store", () => {
	const program = compileScript("var before; { function annex() {} } var after;");
	const instructions = instructionsOf(program.functions[0]!);
	const annexNameIndex = program.stringConstants.findIndex(
		(codeUnits) => String.fromCharCode(...codeUnits) === "annex",
	);
	const empty = instructions.find((instruction) => instruction.type === "createEmpty");
	expect(empty?.type).toBe("createEmpty");
	expect(instructions).toContainEqual(
		expect.objectContaining({
			type: "storeGlobalProperty",
			registers: empty?.type === "createEmpty" ? empty.registers : [],
			nameStringIndex: annexNameIndex,
			declaration: true,
			declarationConfigurable: false,
		}),
	);
	expect(
		instructions.filter((instruction) => instruction.type === "initGlobalVars"),
	).toEqual([
		expect.objectContaining({ nameStringIndices: [expect.any(Number)] }),
		expect.objectContaining({ nameStringIndices: [expect.any(Number)] }),
	]);
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

test("compound statements reset eval completion to undefined exactly once", () => {
	const sources = [
		"1; if (false) {}",
		"1; while (false) {}",
		"1; do {} while (false)",
		"1; for (; false; ) {}",
		"var key; 1; for (key in {}) {}",
		"var value; 1; for (value of []) {}",
		"1; switch (0) {}",
		"1; with ({}) {}",
	];

	for (const source of sources) {
		const fn = compileScript(source, true).functions[0]!;
		const completionRegister = fn.completionRegister;
		expect(completionRegister, source).toBeDefined();
		expect(
			instructionsOf(fn).filter(
				(instruction) =>
					instruction.type === "createUndefined" &&
					instruction.registers[0] === completionRegister,
			),
			source,
		).toHaveLength(2);
	}
});

test("valued compound bodies still update eval completion", () => {
	const program = compileScript("1; if (true) { 2; }", true);
	const fn = program.functions[0]!;
	const completionRegister = fn.completionRegister;
	const instructions = instructionsOf(fn);
	const bodyValue = instructions.find(
		(instruction) => instruction.type === "createNumber" && instruction.value === 2,
	);

	expect(bodyValue?.type).toBe("createNumber");
	if (bodyValue?.type === "createNumber") {
		expect(instructions).toContainEqual({
			type: "move",
			registers: [completionRegister!, bodyValue.registers[0]],
		});
	}
});

test("empty statements, blocks, and declarations preserve eval completion", () => {
	const fn = compileScript("1; ; {}; var retained;", true).functions[0]!;
	const completionRegister = fn.completionRegister;
	const instructions = instructionsOf(fn);

	expect(
		instructions.filter(
			(instruction) =>
				instruction.type === "createUndefined" &&
				instruction.registers[0] === completionRegister,
		),
	).toHaveLength(1);
	expect(
		instructions.filter(
			(instruction) =>
				instruction.type === "move" && instruction.registers[0] === completionRegister,
		),
	).toHaveLength(1);
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

test("captured loop body bindings use the per-iteration environment", () => {
	const program = compileScript(`
		function collect() {
			const callbacks = [];
			for (const size of [1, 2]) {
				let thrown = size;
				callbacks.push(() => size + thrown);
			}
			return callbacks;
		}
	`);
	const collect = functionNamed(program, "collect");
	const envPush = instructionsOf(collect).filter(
		(instruction) => instruction.type === "envPush",
	);

	expect(envPush).toHaveLength(1);
	expect(envPush[0]).toMatchObject({ slotCount: 2 });
	if (envPush[0]?.type !== "envPush") return;
	const { scopeId } = envPush[0];

	const callback = program.functions.find(
		(fn) =>
			fn !== collect &&
			instructionsOf(fn).some(
				(instruction) =>
					instruction.type === "loadCaptured" && instruction.functionIndex === scopeId,
			),
	);
	expect(callback).toBeDefined();
	expect(
		instructionsOf(callback!).filter(
			(instruction) =>
				instruction.type === "loadCaptured" && instruction.functionIndex === scopeId,
		),
	).toHaveLength(2);
	expect(
		collect.blocks.some((block) =>
			block.instructions.some((instruction, index) => {
				const next = block.instructions[index + 1];
				return (
					instruction.type === "createEmpty" &&
					next?.type === "storeCaptured" &&
					next.functionIndex === scopeId &&
					next.registers[0] === instruction.registers[0]
				);
			}),
		),
	).toBe(true);
});

test.each([
	[
		"classic for",
		`function collect() {
			const callbacks = [];
			for (let value = 0; value < 2; value++) {
				let body = value;
				callbacks.push(() => value + body);
			}
		}`,
	],
	[
		"for-in",
		`function collect() {
			const callbacks = [];
			for (const value in { a: 1, b: 2 }) {
				let body = value;
				callbacks.push(() => value + body);
			}
		}`,
	],
	[
		"for-await-of",
		`async function collect(source) {
			const callbacks = [];
			for await (const value of source) {
				let body = value;
				callbacks.push(() => value + body);
			}
		}`,
	],
])("captured %s body bindings use a two-slot iteration environment", (_name, source) => {
	const program = compileScript(source);
	const envPushes = program.functions.flatMap((fn) =>
		instructionsOf(fn).filter((instruction) => instruction.type === "envPush"),
	);
	expect(envPushes).toContainEqual(expect.objectContaining({ slotCount: 2 }));
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
