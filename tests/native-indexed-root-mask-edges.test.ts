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

type Safepoint = NativeFunctionPlan["gc"]["safepoints"][number];

const retainedLoad = {
	opcode: "LOAD_PROPERTY_STATIC",
	object: 0,
	dst: 1,
	stringIndex: 0,
	icIndex: 0,
} satisfies BytecodeInstruction;
const key = { opcode: "CREATE_NUMBER", dst: 2, value: 0 } satisfies BytecodeInstruction;
const indexedLoad = {
	opcode: "LOAD_PROPERTY",
	object: 0,
	key: 2,
	dst: 3,
	icIndex: 1,
} satisfies BytecodeInstruction;
const resultLoad = {
	opcode: "LOAD_PROPERTY_STATIC",
	object: 3,
	dst: 4,
	stringIndex: 1,
	icIndex: 2,
} satisfies BytecodeInstruction;
const call = {
	opcode: "CALL",
	dst: 6,
	callee: 5,
	thisValue: 0,
	argumentCount: 3,
	arguments: [1, 3, 4],
} satisfies BytecodeInstruction;

function fn(
	instructions: Array<BytecodeInstruction>,
	registerCount = 7,
): BytecodeFunction {
	return {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 1,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 1,
		registerCount,
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
}

function point(
	instructionIp: number,
	incomingRootRegisters: Array<number>,
	outgoingRootRegisters: Array<number>,
	kind: Safepoint["kind"] = "operation",
): Safepoint {
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
	body: BytecodeFunction,
	safepoints: Array<Safepoint>,
	keyRepresentation: VmRegisterRepresentation = "number",
	plan?: NativeFunctionPlan["instructions"][number],
): string {
	const native = createConservativeNativePlan([body]).functions[0]!;
	return emitCompiledFunction(
		body,
		{
			...native,
			registerRepresentations: native.registerRepresentations.map(
				(representation, index) =>
					index === indexedLoad.key ? keyRepresentation : representation,
			),
			instructions: body.instructions.map((instruction) =>
				instruction.opcode === "LOAD_PROPERTY" ? plan : undefined,
			),
			gc: { safepoints },
		},
		0,
		"",
		false,
	)!.source;
}

function ordinary(
	keyRepresentation: VmRegisterRepresentation = "number",
	plan?: NativeFunctionPlan["instructions"][number],
): string {
	return emit(
		fn([
			retainedLoad,
			key,
			indexedLoad,
			resultLoad,
			call,
			{ opcode: "RETURN", value: 6 },
		]),
		[
			point(0, [0, 5], [0, 1, 5]),
			point(2, keyRepresentation === "boxed" ? [0, 1, 2, 5] : [0, 1, 5], [0, 1, 3, 5]),
			point(3, [0, 1, 3, 5], [0, 1, 3, 4, 5]),
			point(4, [0, 1, 3, 4, 5], [6]),
		],
		keyRepresentation,
		plan,
	);
}

function privateSlot(source: string, register: number): number {
	expect(source).toContain(`#define r${register} (__private_r${register})`);
	const store = source.match(new RegExp(`__gc_slots\\[(\\d+)\\] = r${register};`));
	expect(store).not.toBeNull();
	return Number(store![1]);
}

describe("native numeric indexed-load root publication", () => {
	it.each(["int32", "number"] as const)(
		"keeps the union mask eager and deduplicated without final private roots for %s indices",
		(representation) => {
			const source = emit(
				fn([key, indexedLoad, indexedLoad, call, { opcode: "RETURN", value: 6 }]),
				[
					point(1, [0, 5], [0, 3, 5]),
					point(2, [0, 5], [0, 3, 5]),
					point(3, [0, 1, 3, 4, 5], [6]),
				],
				representation,
			);
			expect(source).not.toContain("__private_r");
			const firstProbe = source.indexOf("mal_vm_array_try_get_index(");
			const mask = source.indexOf("MAL_ROOT_MASK(");
			expect(mask).toBeGreaterThan(-1);
			expect(firstProbe).toBeGreaterThan(mask);
			const secondProbe = source.indexOf("mal_vm_array_try_get_index(", firstProbe + 1);
			expect(source.slice(0, secondProbe).match(/MAL_ROOT_MASK\(/g)).toHaveLength(1);
			expect(source.slice(firstProbe, secondProbe)).not.toContain("MAL_ROOT_MASK(");
			expect(source.match(/mal_vm_indexed_fast_load_index\(/g)).toHaveLength(2);
		},
	);

	it("adds no publication for an indexed instruction without a refined GC point", () => {
		const source = emit(fn([key, indexedLoad, { opcode: "RETURN", value: 3 }]), []);
		expect(source).not.toContain("__private_r");
		expect(source).not.toContain("MAL_ROOT_MASK(");
		expect(source).toContain("mal_vm_array_try_get_index(");
		expect(source).toContain("mal_vm_indexed_fast_load_index(");
	});

	it.each(["int32", "number"] as const)(
		"publishes private inputs and the union mask only after the %s array probe misses",
		(representation) => {
			const source = ordinary(representation);
			const slot = privateSlot(source, retainedLoad.dst);
			privateSlot(source, indexedLoad.dst);
			const start = source.indexOf(
				`r${key.dst} =`,
				source.indexOf("mal_vm_op_load_property_ic_static_miss("),
			);
			const probe = source.indexOf("mal_vm_array_try_get_index(", start);
			const miss = source.indexOf("mal_vm_indexed_fast_load_index(", probe);
			const fallback = source.lastIndexOf("} else {", miss);
			expect(probe).toBeGreaterThan(start);
			expect(fallback).toBeGreaterThan(probe);
			expect(miss).toBeGreaterThan(fallback);
			expect(source.slice(start, fallback)).not.toContain("__gc_slots[");
			expect(source.slice(start, fallback)).not.toContain("MAL_ROOT_MASK(");
			expect(source.slice(fallback, miss)).toContain(`__gc_slots[${slot}] = r1;`);
			expect(source.slice(fallback, miss)).toContain("MAL_ROOT_MASK(0x28)");
			expect(source.slice(miss, source.indexOf("\n    }", miss))).toContain(
				"vm->completion.kind == MAL_COMPLETION_THROW",
			);
		},
	);

	it("keeps publication before the boxed-key helper that owns conversion and reentry", () => {
		const source = ordinary("boxed");
		const slot = privateSlot(source, retainedLoad.dst);
		const start = source.indexOf(
			`r${key.dst} =`,
			source.indexOf("mal_vm_op_load_property_ic_static_miss("),
		);
		const helper = source.indexOf("mal_vm_indexed_fast_load(", start);
		expect(helper).toBeGreaterThan(start);
		expect(source.slice(start, helper)).toContain(`__gc_slots[${slot}] = r1;`);
		expect(source.slice(start, helper)).toContain("MAL_ROOT_MASK(");
		expect(source).not.toContain("mal_vm_array_try_get_index(");
	});

	it("retains eager publication for specialized array plans with their own fallback", () => {
		const source = ordinary("number", { kind: "exact-contained-array-element" });
		const slot = privateSlot(source, retainedLoad.dst);
		const start = source.indexOf(
			`r${key.dst} =`,
			source.indexOf("mal_vm_op_load_property_ic_static_miss("),
		);
		const probe = source.indexOf("mal_vm_private_array_try_get_index(", start);
		expect(probe).toBeGreaterThan(start);
		expect(source.slice(start, probe)).toContain(`__gc_slots[${slot}] = r1;`);
		expect(source.slice(start, probe)).toContain("MAL_ROOT_MASK(0x28)");
		expect(source).not.toContain("mal_vm_array_try_get_index(");
	});

	it("restores a following collecting operation's mask after either indexed edge", () => {
		const roots = [0, 1, 3, 4, 5, 6];
		const source = emit(
			fn([
				call,
				retainedLoad,
				key,
				indexedLoad,
				call,
				resultLoad,
				{ opcode: "RETURN", value: 6 },
			]),
			[
				point(0, roots, roots),
				point(1, roots, roots),
				point(3, [0, 1, 5], [0, 1, 3, 5]),
				point(4, roots, roots),
				point(5, [3, 6], [4, 6]),
			],
		);
		const miss = source.indexOf("mal_vm_indexed_fast_load_index(");
		const end = source.indexOf("\n    }", miss);
		const nextCall = source.indexOf("mal_vm_call_cached(", end);
		expect(nextCall).toBeGreaterThan(end);
		expect(source.slice(source.lastIndexOf("} else {", miss), miss)).toContain(
			"MAL_ROOT_MASK(0x28)",
		);
		expect(source.slice(end, nextCall)).toContain("MAL_ROOT_MASK(0x0)");
	});

	it("publishes a private heap-valued hit before the following loop poll", () => {
		const source = emit(
			fn([retainedLoad, key, indexedLoad, { opcode: "JUMP", targetIp: 1 }, resultLoad]),
			[
				point(0, [0], [0, 1]),
				point(2, [0, 1], [0, 1, 3]),
				point(3, [0, 1, 3], [0, 1, 3], "loop-backedge"),
				point(4, [3], [4]),
			],
		);
		const slot = privateSlot(source, indexedLoad.dst);
		const miss = source.indexOf("mal_vm_indexed_fast_load_index(");
		const pollGuard = source.indexOf("if (mal_gc_poll)", miss);
		const safepoint = source.indexOf("mal_gc_safepoint(vm)", pollGuard);
		expect(pollGuard).toBeGreaterThan(miss);
		expect(safepoint).toBeGreaterThan(pollGuard);
		expect(source.slice(pollGuard, safepoint)).toContain(`__gc_slots[${slot}] = r3;`);
		expect(source.slice(pollGuard, safepoint)).toContain("MAL_ROOT_MASK(");
	});

	it("clears private output slots beyond the mask only on the indexed fallback", () => {
		const roots = Array.from({ length: 75 }, (_, index) => index).filter(
			(index) => index !== 2,
		);
		const source = emit(
			fn(
				[
					retainedLoad,
					key,
					indexedLoad,
					resultLoad,
					call,
					{ opcode: "RETURN", value: 6 },
				],
				75,
			),
			[
				point(0, roots, roots),
				point(2, [0, 1, 5], [0, 1, 3, 5]),
				point(3, [0, 1, 3, 5], [0, 1, 3, 4, 5]),
				point(4, [0, 1, 3, 4, 5], [6]),
			],
		);
		const inputSlot = privateSlot(source, retainedLoad.dst);
		const outputSlot = privateSlot(source, indexedLoad.dst);
		expect(inputSlot).toBeGreaterThanOrEqual(64);
		expect(outputSlot).toBeGreaterThanOrEqual(64);
		const start = source.indexOf(
			`r${key.dst} =`,
			source.indexOf("mal_vm_op_load_property_ic_static_miss("),
		);
		const miss = source.indexOf("mal_vm_indexed_fast_load_index(", start);
		const fallback = source.lastIndexOf("} else {", miss);
		expect(source.slice(start, fallback)).not.toContain("__gc_slots[");
		expect(source.slice(fallback, miss)).toContain(`__gc_slots[${inputSlot}] = r1;`);
		expect(source.slice(fallback, miss)).toContain(
			`__gc_slots[${outputSlot}] = MAL_VALUE_UNDEFINED;`,
		);
	});
});
