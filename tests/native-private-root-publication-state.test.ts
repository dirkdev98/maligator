import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	NativeFunctionPlan,
	NativeInstructionPlan,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { vmInstructionWriteRegisters } from "../src/compiler/target/runtime-image.ts";
import type {
	BytecodeExceptionHandler,
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

const retained = 2;
const live = [0, 1, retained];
const load = {
	opcode: "LOAD_PROPERTY_STATIC",
	object: 0,
	dst: retained,
	stringIndex: 0,
	icIndex: 0,
} satisfies BytecodeInstruction;
const call = (dst = 4, arguments_: Array<number> = [retained]): BytecodeInstruction => ({
	opcode: "CALL",
	dst,
	callee: 1,
	thisValue: 0,
	argumentCount: arguments_.length,
	arguments: arguments_,
});
const returned = { opcode: "RETURN", value: retained } satisfies BytecodeInstruction;

function point(
	instructionIp: number,
	incomingRootRegisters = live,
	outgoingRootRegisters = [...live, 4],
	kind: "operation" | "loop-backedge" = "operation",
): NativeFunctionPlan["gc"]["safepoints"][number] {
	return {
		kind,
		instructionIp,
		rootRegisters: [
			...new Set([...incomingRootRegisters, ...outgoingRootRegisters]),
		].sort((left, right) => left - right),
		incomingRootRegisters,
		outgoingRootRegisters,
	};
}

function emit(
	instructions: Array<BytecodeInstruction>,
	safepoints: NativeFunctionPlan["gc"]["safepoints"],
	options: {
		handlers?: Array<BytecodeExceptionHandler>;
		nativeInstructions?: ReadonlyMap<number, NativeInstructionPlan>;
		capturedCount?: number;
	} = {},
): string {
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 2,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 2,
		registerCount: 6,
		capturedCount: options.capturedCount ?? 0,
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
	const native = createConservativeNativePlan([fn]).functions[0]!;
	return emitCompiledFunction(
		fn,
		{
			...native,
			instructions: instructions.map((_, ip) => options.nativeInstructions?.get(ip)),
			registerRepresentations: ["boxed", "boxed", "boxed", "boxed", "boxed", "boolean"],
			gc: { safepoints },
		},
		0,
		"",
		false,
	)!.source;
}

function privatePublication(source: string, register = retained): string {
	expect(source).toContain(`#define r${register} (__private_r${register})`);
	const slot = source.match(new RegExp(`__gc_slots\\[(\\d+)\\] = r${register};`))?.[1];
	expect(slot).toBeDefined();
	return `__gc_slots[${slot}] = r${register};`;
}

function beforeCall(source: string, ip: number, start = 0): string {
	const end = source.indexOf(`MalCompletion call_result_${ip} = mal_vm_call_cached`);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function afterCallResult(source: string, ip: number): number {
	const end = source.indexOf(`call_result_${ip}.value;`);
	expect(end).toBeGreaterThan(0);
	return source.indexOf("\n", end) + 1;
}

function hasIncomingCopy(source: string, publication: string): boolean {
	// Poll and fallback copies are conditional; only a top-level statement covers
	// every path entering the subsequent collecting call.
	return source.split("\n").includes(`    ${publication}`);
}

describe("private-root publication state at collecting edges", () => {
	it("reuses an unchanged published heap value across consecutive collecting calls", () => {
		const source = emit(
			[load, call(), call(), returned],
			[point(0, [0, 1], live), point(1), point(2)],
		);
		const publication = privatePublication(source);
		const propertyMiss = source.indexOf("mal_vm_op_load_property_ic_static_miss");
		expect(hasIncomingCopy(beforeCall(source, 1, propertyMiss), publication)).toBe(true);
		expect(
			hasIncomingCopy(beforeCall(source, 2, afterCallResult(source, 1)), publication),
		).toBe(false);
		expect(beforeCall(source, 2, afterCallResult(source, 1))).not.toContain(publication);
	});

	it("publishes a replacement after the physical private register is written", () => {
		const source = emit(
			[load, call(), { opcode: "MOVE", dst: retained, src: 0 }, call(), returned],
			[point(0, [0, 1], live), point(1), point(3)],
		);
		const publication = privatePublication(source);
		const replacement = source.indexOf(`r${retained} = r0;`, afterCallResult(source, 1));
		expect(replacement).toBeGreaterThan(0);
		expect(hasIncomingCopy(beforeCall(source, 3, replacement), publication)).toBe(true);
	});

	it("does not treat a coercing fallback's publication as covering its numeric hit", () => {
		const source = emit(
			[
				load,
				{ opcode: "BINARY", dst: 3, left: retained, right: 0, operator: "+" },
				call(),
				returned,
			],
			[point(0, [0, 1], live), point(1, live, [...live, 3]), point(2)],
		);
		const publication = privatePublication(source);
		const binary = source.indexOf("mal_vm_binary_op");
		const fallback = source.lastIndexOf("} else {", binary);
		expect(fallback).toBeGreaterThan(0);
		expect(source.slice(fallback, binary)).toContain(publication.slice(0, -1));
		expect(hasIncomingCopy(beforeCall(source, 2, binary), publication)).toBe(true);
	});

	it("publishes at a join when only one predecessor passed a collecting call", () => {
		const source = emit(
			[load, { opcode: "JUMP_IF", cond: 0, targetIp: 3 }, call(), call(), returned],
			[point(0, [0, 1], live), point(2), point(3)],
		);
		const publication = privatePublication(source);
		const join = source.indexOf("L3:;");
		expect(source).toContain("if (mal_value_is_truthy(r0)) goto L3;");
		expect(join).toBeGreaterThan(0);
		expect(hasIncomingCopy(beforeCall(source, 3, join), publication)).toBe(true);
	});

	it("publishes the next iteration's replacement at the loop header and collecting backedge", () => {
		const source = emit(
			[
				load,
				call(),
				call(),
				{ opcode: "MOVE", dst: retained, src: 0 },
				{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
				returned,
			],
			[point(0, [0, 1], live), point(1), point(2), point(4, live, live, "loop-backedge")],
		);
		const publication = privatePublication(source);
		const header = source.indexOf("L2:;");
		expect(hasIncomingCopy(beforeCall(source, 2, header), publication)).toBe(true);
		const replacement = source.indexOf(`r${retained} = r0;`, afterCallResult(source, 2));
		const poll = source.indexOf("mal_gc_safepoint(vm)", replacement);
		expect(source.slice(replacement, poll)).toContain(
			`if (mal_gc_poll) { ${publication}`,
		);
	});

	it("publishes on catch entry that can bypass a normal rooted-output reload", () => {
		const source = emit(
			[
				load,
				{ opcode: "CREATE_OBJECT", dst: 4 },
				call(retained),
				returned,
				{ opcode: "CATCH", dst: 3 },
				call(),
				returned,
			],
			[
				point(0, [0, 1], live),
				point(1),
				point(2, live, live),
				point(5, [...live, 3], [...live, 3, 4]),
			],
			{ handlers: [{ startIp: 1, endIp: 3, handlerIp: 4 }] },
		);
		const publication = privatePublication(source);
		const handler = source.indexOf("L4:;");
		expect(source).toContain("goto L4;");
		expect(handler).toBeGreaterThan(source.indexOf("call_result_2.value;"));
		expect(hasIncomingCopy(beforeCall(source, 5, handler), publication)).toBe(true);
	});

	it("uses a rooted call result's reload as publication of the returned heap value", () => {
		const source = emit(
			[load, call(retained, []), call(), returned],
			[point(0, [0, 1], live), point(1, [0, 1], live), point(2)],
		);
		const publication = privatePublication(source);
		const slot = publication.slice(0, publication.indexOf(" ="));
		const firstCall = beforeCall(
			source,
			1,
			source.indexOf("mal_vm_op_load_property_ic_static_miss"),
		);
		expect(firstCall).toContain(`${slot} = MAL_VALUE_UNDEFINED;`);
		const afterResult = beforeCall(source, 2, afterCallResult(source, 1));
		expect(afterResult).toContain(`__private_r${retained} = ${slot};`);
		expect(hasIncomingCopy(afterResult, publication)).toBe(false);
		expect(afterResult).not.toContain(publication);
	});

	it("clears a replaced root on a getter miss and republishes the new private result", () => {
		const replacement = { ...load, stringIndex: 1, icIndex: 1 };
		const source = emit(
			[load, call(), replacement, call(), returned],
			[point(0, [0, 1], live), point(1), point(2, [0, 1], live), point(3)],
		);
		const publication = privatePublication(source);
		const slot = publication.slice(0, publication.indexOf(" ="));
		const start = afterCallResult(source, 1);
		const miss = source.indexOf("mal_vm_op_load_property_ic_static_miss", start);
		const fallback = source.lastIndexOf("} else {", miss);
		expect(source.slice(fallback, miss)).toContain(`${slot} = MAL_VALUE_UNDEFINED;`);
		expect(hasIncomingCopy(beforeCall(source, 3, miss), publication)).toBe(true);
	});

	it("keeps a materialized static-argument fallback rooted during its internal property lookup", () => {
		const argument = {
			opcode: "LOAD_STATIC_ARGUMENT",
			dst: 4,
			direct: -1,
			fallback: retained,
			index: 2,
		} satisfies BytecodeInstruction;
		const source = emit(
			[argument, { ...load, object: retained, dst: 3 }, { opcode: "RETURN", value: 3 }],
			[point(0, [0, 1], [...live, 4]), point(1, live, [...live, 3])],
		);
		expect(vmInstructionWriteRegisters(argument)).toEqual([4, retained]);
		expect(source).not.toContain(`#define r${retained} (__private_r${retained})`);
		expect(source).toContain(`#define r${retained} (__gc_slots[`);
		const allocation = source.indexOf(`r${retained} = mal_create_arguments_object`);
		const lookup = source.indexOf(`mal_vm_op_load_property(vm, r${retained}`);
		expect(allocation).toBeGreaterThan(0);
		expect(lookup).toBeGreaterThan(allocation);
	});
	it.each([
		{ opcode: "STORE_GLOBAL", src: 0, index: 0 },
		{ opcode: "LOAD_CAPTURED", dst: 3, ownerFunctionIndex: 0, index: 0 },
	] satisfies Array<BytecodeInstruction>)(
		"preserves an unrelated published root across certified noncollecting $opcode",
		(instruction) => {
			const source = emit(
				[load, call(), instruction, call(), returned],
				[point(0, [0, 1], live), point(1), point(3)],
				{ capturedCount: instruction.opcode === "LOAD_CAPTURED" ? 1 : 0 },
			);
			const publication = privatePublication(source);
			expect(
				hasIncomingCopy(beforeCall(source, 3, afterCallResult(source, 1)), publication),
			).toBe(false);
		},
	);

	it("retains an unrelated published root across a native-planned call with a rooted result", () => {
		const source = emit(
			[
				load,
				call(),
				call(3, []),
				call(),
				{ ...load, object: 3, dst: 4, stringIndex: 1, icIndex: 1 },
				returned,
			],
			[
				point(0, [0, 1], live),
				point(1),
				point(2, live, [...live, 3]),
				point(3, [...live, 3], [...live, 3, 4]),
				point(4, [...live, 3], [...live, 4]),
			],
			{ nativeInstructions: new Map([[2, { kind: "call" }]]) },
		);
		const publication = privatePublication(source);
		const rootedResult = privatePublication(source, 3);
		const resultSlot = rootedResult.slice(0, rootedResult.indexOf(" ="));
		expect(
			hasIncomingCopy(beforeCall(source, 2, afterCallResult(source, 1)), publication),
		).toBe(false);
		const afterResult = beforeCall(source, 3, afterCallResult(source, 2));
		expect(afterResult).toContain(`__private_r3 = ${resultSlot};`);
		expect(hasIncomingCopy(afterResult, publication)).toBe(false);
	});
});
