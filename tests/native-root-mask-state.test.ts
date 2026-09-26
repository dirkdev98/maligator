import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
describe("native root-mask state after pure operators", () => {
	it("preserves the known mask when a numeric operator emits no publication", () => {
		const call = {
			opcode: "CALL",
			dst: 2,
			callee: 1,
			thisValue: 0,
			argumentCount: 0,
			arguments: [],
		} satisfies BytecodeInstruction;
		const fn: BytecodeFunction = {
			nameStringIndex: -1,
			isGenerator: false,
			isAsync: false,
			parameterCount: 2,
			mappedArguments: false,
			mappedArgumentSlots: [],
			length: 2,
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
			instructions: [
				call,
				{ opcode: "BINARY", dst: 3, left: 4, right: 5, operator: "+" },
				call,
				{ opcode: "RETURN", value: 0 },
			],
			handlers: [],
			fileIndex: -1,
			positions: [],
		};
		const native = createConservativeNativePlan([fn]).functions[0]!;
		const callPoint = {
			kind: "operation",
			rootRegisters: [0, 1, 2],
			incomingRootRegisters: [0, 1],
			outgoingRootRegisters: [0, 1, 2],
		} as const;
		const output = emitCompiledFunction(
			fn,
			{
				...native,
				registerRepresentations: [
					"boxed",
					"boxed",
					"boxed",
					"number",
					"number",
					"number",
				],
				gc: {
					safepoints: [
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
				},
			},
			0,
			"",
			false,
		)!.source;
		expect(output).not.toContain("mal_vm_binary_op");
		expect(output.match(/MAL_ROOT_MASK\(0x0\)/g)).toHaveLength(1);
		expect(output).not.toContain("MAL_ROOT_MASK(0x4)");
	});
});
