import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

const call = {
	opcode: "CALL",
	dst: 5,
	callee: 0,
	thisValue: 1,
	argumentCount: 0,
	arguments: [],
} satisfies BytecodeInstruction;

function emit(
	instructions: Array<BytecodeInstruction>,
	representations: Array<VmRegisterRepresentation>,
	safepoints: NativeFunctionPlan["gc"]["safepoints"],
	parameterCount = 2,
): string {
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: parameterCount,
		registerCount: 6,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions,
		handlers: [],
		fileIndex: -1,
		positions: [],
	};
	const native = createConservativeNativePlan([fn]).functions[0]!;
	return emitCompiledFunction(
		fn,
		{ ...native, registerRepresentations: representations, gc: { safepoints } },
		0,
		"",
		false,
	)!.source;
}

describe("native root-mask state through generic continuations", () => {
	it.each(["+", "==="] as const)(
		"preserves the current mask for a pure numeric %s operation",
		(operator) => {
			const callPoint = {
				kind: "operation",
				rootRegisters: [0, 1, 5],
				incomingRootRegisters: [0, 1],
				outgoingRootRegisters: [0, 1, 5],
			} as const;
			const output = emit(
				[
					call,
					{ opcode: "BINARY", dst: 2, left: 3, right: 4, operator },
					call,
					{ opcode: "RETURN", value: 5 },
				],
				[
					"boxed",
					"boxed",
					operator === "+" ? "number" : "boolean",
					"number",
					"number",
					"boxed",
				],
				[
					{ ...callPoint, instructionIp: 0 },
					{
						kind: "operation",
						instructionIp: 1,
						rootRegisters: [0, 1],
						incomingRootRegisters: [0, 1],
						outgoingRootRegisters: [0, 1],
					},
					{ ...callPoint, instructionIp: 2 },
				],
			);
			expect(output).not.toContain("mal_vm_binary_op");
			expect(output.match(/MAL_ROOT_MASK\(0x0\)/g)).toHaveLength(1);
			expect(output).not.toContain("MAL_ROOT_MASK(0x4)");
		},
	);

	it("restores a call's output root after a nested projection fallback changes the mask", () => {
		// Conservative load maps keep the preceding mask; the operator can omit the
		// next call's not-yet-created result, which that call must reactivate.
		const widePoint = {
			kind: "operation",
			rootRegisters: [0, 1, 2, 3, 4, 5],
			incomingRootRegisters: [0, 1, 2, 3, 4, 5],
			outgoingRootRegisters: [0, 1, 2, 3, 4, 5],
		} as const;
		const output = emit(
			[
				call,
				{ opcode: "LOAD_PROPERTY_STATIC", object: 1, dst: 2, stringIndex: 0, icIndex: 0 },
				{ opcode: "LOAD_PROPERTY_STATIC", object: 1, dst: 3, stringIndex: 1, icIndex: 1 },
				{ opcode: "BINARY", dst: 4, left: 2, right: 3, operator: "+" },
				call,
				{ opcode: "RETURN", value: 5 },
			],
			Array.from({ length: 6 }, () => "boxed"),
			[
				{ ...widePoint, instructionIp: 0 },
				{ ...widePoint, instructionIp: 1 },
				{ ...widePoint, instructionIp: 2 },
				{
					kind: "operation",
					instructionIp: 3,
					rootRegisters: [0, 1, 2, 3, 4],
					incomingRootRegisters: [0, 1, 2, 3],
					outgoingRootRegisters: [0, 1, 4],
				},
				{ ...widePoint, instructionIp: 4 },
			],
		);
		expect(output).toContain("mal_vm_property_try_load_static_number_pair");
		expect(output).toContain("mal_vm_binary_op");
		expect(output.match(/MAL_ROOT_MASK\(0x0\)/g)).toHaveLength(2);
		expect(output).toMatch(
			/MAL_ROOT_MASK\(0x20\)[\s\S]*MAL_ROOT_MASK\(0x0\)[\s\S]*mal_vm_call_cached[\s\S]*mal_gc_safepoint/,
		);
	});
	it("keeps operator masks eager after numeric projections remove all private slots", () => {
		const widePoint = {
			kind: "operation",
			rootRegisters: [0, 2, 3, 4, 5],
			incomingRootRegisters: [0, 2, 3, 4, 5],
			outgoingRootRegisters: [0, 2, 3, 4, 5],
		} as const;
		// A numeric receiver needs no traced slot; the projection consumes both
		// provisional private load results, leaving only continuously rooted values.
		const output = emit(
			[
				{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
				call,
				{ opcode: "LOAD_PROPERTY_STATIC", object: 1, dst: 2, stringIndex: 0, icIndex: 0 },
				{ opcode: "LOAD_PROPERTY_STATIC", object: 1, dst: 3, stringIndex: 1, icIndex: 1 },
				{ opcode: "BINARY", dst: 4, left: 2, right: 3, operator: "+" },
				call,
				{ opcode: "RETURN", value: 5 },
			],
			["boxed", "number", "boxed", "boxed", "boxed", "boxed"],
			[
				{ ...widePoint, instructionIp: 1 },
				{ ...widePoint, instructionIp: 2 },
				{ ...widePoint, instructionIp: 3 },
				{
					kind: "operation",
					instructionIp: 4,
					rootRegisters: [0, 2, 3, 4],
					incomingRootRegisters: [0, 2, 3],
					outgoingRootRegisters: [0, 4],
				},
				{ ...widePoint, instructionIp: 5 },
			],
			1,
		);
		expect(output).toContain("mal_vm_property_try_load_static_number_pair");
		expect(output).not.toContain("__private_r");
		const eagerMask = output.indexOf("\n    MAL_ROOT_MASK(0x10);\n");
		const binaryFallback = output.indexOf("mal_vm_binary_op");
		expect(eagerMask).toBeGreaterThan(0);
		expect(binaryFallback).toBeGreaterThan(eagerMask);
		expect(output.slice(eagerMask, binaryFallback)).toContain("if (");
		expect(output.match(/MAL_ROOT_MASK\(0x10\)/g)).toHaveLength(1);
		expect(output.match(/MAL_ROOT_MASK\(0x0\)/g)).toHaveLength(2);
	});
});
