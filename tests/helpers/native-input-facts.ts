import type {
	NativeFunctionPlan,
	ProgramImage,
	VmRegisterRepresentation,
} from "../../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../../src/compiler/target/runtime-image.ts";
import { encodeVmValueOperand } from "../../src/compiler/target/runtime-image.ts";
import { testProgramImage, withNativeFunctionPlan } from "./program-image.ts";

export function inputFactsFixture(): { image: ProgramImage; expected: Array<string> } {
	const instructions: Array<BytecodeInstruction> = [];
	const representations: Array<VmRegisterRepresentation> = [];
	const expected: Array<string> = [];
	const strings: Array<Array<number>> = [];
	const allocate = (rep: VmRegisterRepresentation = "boxed") => {
		representations.push(rep);
		return representations.length - 1;
	};
	const number = (value: number, rep: "number" | "int32" = "number") => {
		const dst = allocate(rep);
		instructions.push(
			rep === "int32"
				? { opcode: "CREATE_NUMBER", dst, value }
				: { opcode: "CREATE_F64", dst, value },
		);
		return dst;
	};
	const string = (value: string) => {
		const dst = allocate("string"),
			stringIndex = strings.length;
		strings.push(
			Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
		);
		instructions.push({ opcode: "CREATE_STRING", dst, stringIndex });
		return dst;
	};
	const record = (src: number, value: unknown) => {
		instructions.push({ opcode: "STORE_GLOBAL", src, index: expected.length });
		expected.push(
			typeof value === "number"
				? `number ${Object.is(value, -0) ? "-0" : String(value)}`
				: typeof value === "string"
					? `string ${Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)).join(",")}`
					: typeof value === "boolean"
						? `boolean ${Number(value)}`
						: value === null
							? "null"
							: value === undefined
								? "undefined"
								: "object",
		);
	};
	const undefinedOperand = encodeVmValueOperand(-1, { kind: "undefined" });
	const builtin = (
		operation: Extract<BytecodeInstruction, { opcode: "CALL_BUILTIN" }>["operation"],
		args: Array<number>,
		value: unknown,
		thisValue = undefinedOperand,
	) => {
		const dst = allocate();
		instructions.push({
			opcode: "CALL_BUILTIN",
			dst,
			operation,
			thisValue,
			arguments: args,
			argumentCount: args.length,
		});
		record(dst, value);
	};
	const values = [
		-0,
		0,
		NaN,
		Infinity,
		-Infinity,
		-0.5,
		1.5,
		-2147483648,
		4294967295,
		9007199254740991,
		9007199254740992,
	];
	for (const value of values) {
		const src = number(value);
		for (const operator of [
			"-",
			"+",
			"tonumeric",
			"increment",
			"decrement",
			"~",
		] as const) {
			const dst = allocate();
			instructions.push({ opcode: "UNARY", dst, src, operator });
			record(
				dst,
				operator === "-"
					? -value
					: operator === "increment"
						? value + 1
						: operator === "decrement"
							? value - 1
							: operator === "~"
								? ~value
								: value,
			);
		}
		for (const [operation, predicate] of [
			["Number.isNaN", Number.isNaN],
			["Number.isFinite", Number.isFinite],
			["Number.isInteger", Number.isInteger],
			["Number.isSafeInteger", Number.isSafeInteger],
		] as const)
			builtin(operation, [src], predicate(value));
		const right = number(-value);
		builtin("Object.is", [src, right], Object.is(value, -value));
		const exponent = number(3),
			dst = allocate();
		instructions.push({
			opcode: "BINARY",
			dst,
			left: src,
			right: exponent,
			operator: "**",
		});
		record(dst, value ** 3);
	}
	for (const value of [-2147483648, -1, 0, 2147483647]) {
		const src = number(value, "int32"),
			dst = allocate();
		instructions.push({ opcode: "UNARY", dst, src, operator: "~" });
		record(dst, ~value);
		builtin("Number.isNaN", [src], false);
		builtin("Number.isFinite", [src], true);
		builtin("Number.isInteger", [src], true);
		builtin("Number.isSafeInteger", [src], true);
		builtin("Object.is", [src, src], true);
	}
	for (const [left, right] of [
		[NaN, 0],
		[-1, Infinity],
		[1, -Infinity],
		[-0, -3],
		[-2, 0.5],
	]) {
		const a = number(left!),
			b = number(right!),
			dst = allocate();
		instructions.push({ opcode: "BINARY", dst, left: a, right: b, operator: "**" });
		record(dst, left! ** right!);
	}
	const truth = encodeVmValueOperand(-1, { kind: "boolean", value: true });
	const falsehood = encodeVmValueOperand(-1, { kind: "boolean", value: false });
	builtin("Object.is", [truth, falsehood], false);
	builtin("Object.is", [truth, truth], true);
	for (const operation of [
		"Number.isNaN",
		"Number.isFinite",
		"Number.isInteger",
		"Number.isSafeInteger",
	] as const) {
		builtin(operation, [], false);
		builtin(operation, [truth], false);
		builtin(operation, [string("1")], false);
		builtin(operation, [encodeVmValueOperand(-1, { kind: "null" })], false);
	}
	for (const [left, right] of [
		["", "a"],
		["10", "2"],
		["a\u0000b", "a\u0000c"],
		["\ud800", "\udfff"],
		["\ud83d\ude00", "\uffff"],
		["same", "same"],
	]) {
		const a = string(left!),
			b = string(right!);
		for (const operator of ["<", "<=", ">", ">="] as const) {
			const dst = allocate("boolean");
			instructions.push({ opcode: "BINARY", dst, left: a, right: b, operator });
			record(
				dst,
				operator === "<"
					? left! < right!
					: operator === "<="
						? left! <= right!
						: operator === ">"
							? left! > right!
							: left! >= right!,
			);
		}
		const concat = allocate("string");
		instructions.push({
			opcode: "BINARY",
			dst: concat,
			left: a,
			right: b,
			operator: "+",
		});
		record(concat, left! + right!);
		for (const index of [NaN, -0.5, -1, 0, 1, 2, Infinity])
			builtin(
				"String.prototype.charCodeAt",
				[number(index)],
				(left! + right!).charCodeAt(index),
				concat,
			);
	}
	const src = number(1, "int32"),
		strictCallee = allocate(),
		sloppyCallee = allocate();
	instructions.push(
		{ opcode: "CREATE_FUNCTION", dst: strictCallee, functionIndex: 1 },
		{ opcode: "CREATE_FUNCTION", dst: sloppyCallee, functionIndex: 2 },
	);
	const directCalls: Array<{ ip: number; target: number; typed: boolean }> = [];
	for (const receiver of [
		undefinedOperand,
		encodeVmValueOperand(-1, { kind: "null" }),
		src,
		string("this"),
	]) {
		for (const typed of [false, true]) {
			const dst = allocate();
			directCalls.push({ ip: instructions.length, target: 1, typed });
			instructions.push({
				opcode: "CALL",
				dst,
				callee: strictCallee,
				thisValue: receiver,
				arguments: [src],
				argumentCount: 1,
				exactFunctionIndex: 1,
			});
			record(
				dst,
				receiver === undefinedOperand
					? undefined
					: receiver < 0
						? null
						: receiver === src
							? 1
							: "this",
			);
		}
	}
	const sloppyResult = allocate();
	directCalls.push({ ip: instructions.length, target: 2, typed: false });
	instructions.push({
		opcode: "CALL",
		dst: sloppyResult,
		callee: sloppyCallee,
		thisValue: src,
		arguments: [],
		argumentCount: 0,
		exactFunctionIndex: 2,
	});
	record(sloppyResult, {});
	instructions.push({ opcode: "RETURN", value: src });
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: representations.length,
		capturedCount: 0,
		strict: false,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions,
		handlers: [],
		fileIndex: 0,
		positions: [],
	};
	const callee = (strict: boolean): BytecodeFunction => ({
		...fn,
		registerCount: 2,
		parameterCount: 1,
		strict,
		instructions: [
			{ opcode: "LOAD_THIS", dst: 1 },
			{ opcode: "RETURN", value: 1 },
		],
	});
	let image = testProgramImage({
		entrypointPath: "/fixture/native-input-facts.mjs",
		functionCount: 3,
		functions: [fn, callee(true), callee(false)],
		stringConstants: strings,
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: expected.length,
		files: [],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	});
	image = withNativeFunctionPlan(image, 0, (plan) => {
		const nativeInstructions = [...plan.instructions];
		for (const call of directCalls)
			nativeInstructions[call.ip] = {
				kind: "call",
				directFunctionIndex: call.target,
				...(call.typed ? { directEntryId: 0 } : {}),
			};
		return {
			...plan,
			registerRepresentations: representations,
			instructions: nativeInstructions,
			gc: {
				safepoints: plan.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
				})),
			},
		};
	});
	image = withNativeFunctionPlan(image, 1, (plan: NativeFunctionPlan) => ({
		...plan,
		directEntries: [
			{
				id: 0,
				parameterRepresentations: ["int32"],
				resultRepresentation: "boxed",
				registerRepresentations: ["int32", "boxed"],
				gc: {
					safepoints: plan.gc.safepoints.map((point) => ({
						...point,
						rootRegisters: point.rootRegisters.filter((register) => register !== 0),
					})),
				},
			},
		],
	}));
	return { image, expected };
}
