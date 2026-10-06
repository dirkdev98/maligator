import { describe, expect, it } from "vitest";
import { lowerNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import type { VmRegisterRepresentation } from "../src/compiler/target/program-image.ts";
import type {
	BytecodeExceptionHandler,
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { vmInstructionUsesRegister } from "../src/compiler/target/runtime-image.ts";

function load(dst: number, object = 0): BytecodeInstruction {
	return {
		opcode: "LOAD_PROPERTY_STATIC",
		dst,
		object,
		stringIndex: dst,
		icIndex: dst,
	};
}

function lower(
	instructions: Array<BytecodeInstruction>,
	options: {
		representations?: Array<VmRegisterRepresentation>;
		jumpTargets?: ReadonlySet<number>;
		conflicts?: (ip: number) => boolean;
		handlers?: Array<BytecodeExceptionHandler>;
	} = {},
) {
	const representations: Array<VmRegisterRepresentation> =
		options.representations ?? Array.from({ length: 32 }, () => "boxed");
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 1,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 1,
		registerCount: representations.length,
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
		handlers: options.handlers ?? [],
		fileIndex: -1,
		positions: [],
	};
	return lowerNativeFastPaths(
		fn,
		representations,
		options.jumpTargets ?? new Set(),
		options.conflicts ?? (() => false),
		{ kind: "select" },
	);
}

const copy: BytecodeInstruction = { opcode: "MOVE", dst: 4, src: 1 };

describe("bounded native property read regions", () => {
	it("tracks every register consumed by static queries and explicit super construction", () => {
		const query: BytecodeInstruction = {
			opcode: "QUERY_STATIC_DATA",
			dst: 1,
			needle: 2,
			fromIndex: 3,
			templateOffset: 0,
			queryKind: "includes",
		};
		expect(vmInstructionUsesRegister(query, 2)).toBe(true);
		expect(vmInstructionUsesRegister(query, 3)).toBe(true);
		expect(
			vmInstructionUsesRegister(
				{ opcode: "SET_PROTOTYPE", object: 1, prototype: 2, literal: true },
				2,
			),
		).toBe(true);
		expect(
			vmInstructionUsesRegister(
				{
					opcode: "CONSTRUCT_SUPER_EXPLICIT",
					dst: 4,
					parent: 5,
					argumentsArray: 6,
					newTarget: 7,
				},
				4,
			),
		).toBe(true);
	});

	it("retains boxed results across pure steps and names the generic continuation", () => {
		const lowered = lower([load(1), copy, load(2), load(3)]);
		expect(lowered.propertyReadRegions).toHaveLength(1);
		const plan = lowered.propertyReadRegions[0]!;
		expect(plan).toMatchObject({
			object: 0,
			endIp: 3,
			continuation: "remaining-instructions",
		});
		expect(plan.loads.map(({ ip }) => ip)).toEqual([0, 2, 3]);
		expect(lowered.propertyReadRegionActions.get(2)).toEqual({ plan, index: 1 });
	});

	it("does not admit object storage for known primitive receivers", () => {
		for (const representation of ["number", "int32", "boolean", "string"] as const) {
			const lowered = lower([load(1), copy, load(2), load(3)], {
				representations: [representation, "boxed", "boxed", "boxed", "boxed"],
			});
			expect(lowered.propertyReadRegions, representation).toHaveLength(0);
			expect(lowered.propertyReadRegionActions.size, representation).toBe(0);
		}
	});

	it("preserves the existing numeric projection and adjacent boxed pair", () => {
		const numeric = lower([
			load(1),
			load(2),
			{ opcode: "BINARY", dst: 3, left: 1, right: 2, operator: "+" },
			{ opcode: "RETURN", value: 3 },
		]);
		expect(numeric.propertyProjections).toHaveLength(1);
		expect(numeric.propertyReadRegions).toHaveLength(0);
		expect(lower([load(1), load(2)]).propertyReadRegions).toHaveLength(0);
	});

	it("keeps projected registers live across branches and exceptional definitions", () => {
		const prefix: Array<BytecodeInstruction> = [
			load(1),
			load(2),
			{ opcode: "BINARY", dst: 3, left: 2, right: 5, operator: "*" },
			{ opcode: "BINARY", dst: 4, left: 1, right: 3, operator: "+" },
			{
				opcode: "STORE_PROPERTY_STATIC",
				object: 0,
				value: 4,
				stringIndex: 1,
				icIndex: 1,
			},
		];
		const branch = lower([
			...prefix,
			{ opcode: "JUMP_IF", cond: 6, targetIp: 8 },
			{ opcode: "CREATE_NUMBER", dst: 4, value: 0 },
			{ opcode: "JUMP", targetIp: 9 },
			{ opcode: "RETURN", value: 4 },
			{ opcode: "RETURN", value: 6 },
		]);
		expect(branch.propertyProjections).toHaveLength(1);
		expect(branch.propertyProjections[0]?.terminalStore).toBeUndefined();
		const overwrittenOnBothPaths = lower([
			...prefix,
			{ opcode: "JUMP_IF", cond: 6, targetIp: 8 },
			{ opcode: "CREATE_NUMBER", dst: 4, value: 0 },
			{ opcode: "JUMP", targetIp: 9 },
			{ opcode: "CREATE_NUMBER", dst: 4, value: 1 },
			{ opcode: "RETURN", value: 4 },
		]);
		expect(overwrittenOnBothPaths.propertyProjections[0]?.terminalStore).toBeDefined();

		const handled = lower(
			[
				...prefix,
				{
					opcode: "CALL",
					dst: 4,
					callee: 7,
					thisValue: 0,
					argumentCount: 0,
					arguments: [],
				},
				{ opcode: "RETURN", value: 4 },
				{ opcode: "RETURN", value: 4 },
			],
			{ handlers: [{ startIp: 5, endIp: 6, handlerIp: 7 }] },
		);
		expect(handled.propertyProjections).toHaveLength(1);
		expect(handled.propertyProjections[0]?.terminalStore).toBeUndefined();
	});

	it("requires a continuation before collection, reentry, throwing, or mutation", () => {
		const boundaries: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_OBJECT", dst: 4 },
			{
				opcode: "CALL",
				dst: 4,
				callee: 7,
				thisValue: 0,
				argumentCount: 0,
				arguments: [],
			},
			{ opcode: "THROW_IF_TDZ", src: 4, nameStringIndex: 0 },
			{ opcode: "THROW", value: 4 },
			{
				opcode: "STORE_PROPERTY_STATIC",
				object: 0,
				value: 4,
				stringIndex: 0,
				icIndex: 0,
			},
			{ opcode: "BINARY", dst: 4, left: 1, right: 1, operator: "+" },
		];
		for (const boundary of boundaries) {
			expect(
				lower([load(1), boundary, load(2)]).propertyReadRegions,
				boundary.opcode,
			).toHaveLength(0);
		}
	});

	it("admits proven numeric arithmetic while rejecting string allocation and exotic operators", () => {
		const arithmetic: BytecodeInstruction = {
			opcode: "BINARY",
			dst: 4,
			left: 5,
			right: 6,
			operator: "+",
		};
		const representations: Array<VmRegisterRepresentation> = [
			"boxed",
			"boxed",
			"boxed",
			"boxed",
			"number",
			"number",
			"number",
		];
		expect(
			lower([load(1), arithmetic, load(2)], { representations }).propertyReadRegions,
		).toHaveLength(1);
		for (const representation of ["boxed", "string"] as const) {
			const specialized = representations.map((current, index) =>
				index >= 4 ? representation : current,
			);
			expect(
				lower([load(1), arithmetic, load(2)], {
					representations: specialized,
				}).propertyReadRegions,
			).toHaveLength(0);
		}
		expect(
			lower([load(1), { ...arithmetic, operator: "in" }, load(2)], {
				representations: [...representations.slice(0, 4), "boolean", "number", "number"],
			}).propertyReadRegions,
		).toHaveLength(0);
	});

	it("ends storage admission when a receiver register changes or a different receiver is read", () => {
		expect(
			lower([load(1), { opcode: "MOVE", dst: 0, src: 1 }, load(2)]).propertyReadRegions,
		).toHaveLength(0);
		expect(lower([load(1), load(2, 9), load(3)]).propertyReadRegions).toHaveLength(0);
		const clobber = lower([load(1), copy, load(0), load(2)]);
		expect(clobber.propertyReadRegions).toHaveLength(1);
		expect(clobber.propertyReadRegions[0]!.endIp).toBe(2);
		expect(clobber.propertyReadRegionActions.has(3)).toBe(false);
	});

	it("does not carry admission through a control-flow entry or an exclusive native plan", () => {
		const instructions = [load(1), copy, load(2)];
		expect(
			lower(instructions, { jumpTargets: new Set([2]) }).propertyReadRegions,
		).toHaveLength(0);
		expect(
			lower(instructions, { conflicts: (ip) => ip === 1 }).propertyReadRegions,
		).toHaveLength(0);
	});

	it("bounds admissions to eight loads and twenty-four instructions", () => {
		const many = lower(Array.from({ length: 10 }, (_, index) => load(index + 1)));
		expect(many.propertyReadRegions).toHaveLength(1);
		expect(many.propertyReadRegions[0]!.loads).toHaveLength(8);
		const gap: Array<BytecodeInstruction> = Array.from({ length: 22 }, () => ({
			opcode: "CREATE_NUMBER",
			dst: 20,
			value: 3,
		}));
		expect(lower([load(1), ...gap, load(2)]).propertyReadRegions).toHaveLength(1);
		expect(lower([load(1), ...gap, copy, load(2)]).propertyReadRegions).toHaveLength(0);
	});
});
