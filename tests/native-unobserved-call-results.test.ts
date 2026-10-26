import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const calls = [
	{ opcode: "CALL", dst: 3, callee: 0, thisValue: 1, argumentCount: 1, arguments: [1] },
	{
		opcode: "CALL_KNOWN",
		dst: 3,
		operation: "Object.keys",
		thisValue: -1,
		argumentCount: 1,
		arguments: [1],
	},
	{ opcode: "CONSTRUCT", dst: 3, callee: 0, argumentCount: 1, arguments: [1] },
	{ opcode: "CALL_SPREAD", dst: 3, callee: 0, thisValue: 1, argumentsArray: 1 },
	{
		opcode: "CALL_SPREAD_ITERABLE",
		dst: 3,
		callee: 0,
		thisValue: 1,
		iterable: 1,
		prefixArguments: [1],
	},
	{
		opcode: "CALL_REST_ARGUMENTS",
		dst: 3,
		callee: 0,
		thisValue: 1,
		receiver: 1,
		startIndex: 0,
		apply: false,
		argumentsObject: false,
		state: 2,
		prefixArguments: [1],
	},
	{ opcode: "CONSTRUCT_SPREAD", dst: 3, callee: 0, argumentsArray: 1 },
] satisfies Array<BytecodeInstruction>;
let template: ReturnType<typeof inspectStaticValueFunction>["fn"] | undefined;
function fixture(call: BytecodeInstruction, used = false, resumable = false) {
	template ??= inspectStaticValueFunction(
		"function compute(callee,input){return callee(input);}globalThis.compute=compute;",
		"compute",
	).fn;
	const instructions: Array<BytecodeInstruction> = [
		call,
		{ opcode: "RETURN", value: used ? 3 : 1 },
	];
	const body = {
		...template,
		registerCount: 4,
		parameterCount: 2,
		isGenerator: resumable,
		instructions,
		positions: instructions.map(() => 0),
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	return lowerNativeFunctionStorage({ ...native, storageValues: [0, 1, 2, 3] });
}

describe("unobserved final call results", () => {
	it.each(calls)(
		"omits the unobserved $opcode destination while preserving inputs and helpers",
		(call) => {
			for (const resumable of [false, true]) {
				const native = fixture(call, false, resumable);
				expect(native.storage!.rootRegisters).not.toContain(3);
				expect(native.storage!.rootRegisters).toContain(0);
				expect(native.storage!.rootRegisters).toContain(1);
				if (call.opcode === "CALL_REST_ARGUMENTS")
					expect(native.storage!.rootRegisters).toContain(call.state);
				expect(() => validateNativeStorage(native)).not.toThrow();
				expect(fixture(call, true, resumable).storage!.rootRegisters).toContain(3);
			}
		},
	);
	it("retains a destination also used as an incoming argument", () => {
		const call = {
			opcode: "CALL",
			dst: 3,
			callee: 0,
			thisValue: 1,
			argumentCount: 1,
			arguments: [3],
		} satisfies BytecodeInstruction;
		expect(fixture(call).storage!.rootRegisters).toContain(3);
	});
	it("retains an iterator helper output even when a later call overwrites it", () => {
		const original = fixture(calls[0]!);
		const body = {
			...original.body,
			instructions: [
				{ opcode: "GET_ITERATOR" as const, iteratorDst: 3, nextDst: 2, source: 1 },
				...original.body.instructions,
			],
		};
		const native = createConservativeNativePlan([body]).functions[0]!;
		expect(
			lowerNativeFunctionStorage({ ...native, storageValues: [0, 1, 2, 3] }).storage!
				.rootRegisters,
		).toContain(3);
	});
	it("rejects an omitted root after a new consumer observes the result", () => {
		const native = fixture(calls[0]!);
		expect(() =>
			validateNativeStorage({
				...native,
				body: {
					...native.body,
					instructions: [calls[0]!, { opcode: "RETURN", value: 3 }],
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
	it("keeps ownership decisions stable through compiler artifacts", () => {
		const out = inspectStaticValueFunction(
			"function compute(callee,input,gate){callee(input);gate();return input;}globalThis.compute=compute;",
			"compute",
		);
		const call = out.native.body.instructions.find(
			(op) => op.opcode === "CALL" && op.arguments.length === 1,
		)!;
		if (call.opcode !== "CALL") throw new Error("Missing call");
		expect(out.native.storage!.rootRegisters).not.toContain(call.dst);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
	it("does not extend an unobserved result's lifetime across a handler scheduling barrier", () => {
		const out = inspectStaticValueFunction(
			"function compute(callee,input){try{callee(input);}catch(error){return input;}return input;}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === "CALL");
		const call = out.native.body.instructions[ip]!;
		if (call.opcode !== "CALL") throw new Error("Missing protected call");
		expect(
			out.native.gc.safepoints.find((point) => point.instructionIp === ip)!.rootRegisters,
		).toContain(call.dst);
		expect(out.native.storage!.rootRegisters).not.toContain(call.dst);
		expect(out.native.storage!.rootRegisters).toContain(call.arguments[0]);
	});
});
