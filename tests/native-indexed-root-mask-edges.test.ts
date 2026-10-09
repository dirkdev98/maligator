import { describe, expect, it } from "vitest";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
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
import { privateRootRegisters } from "./helpers/native-c-source.ts";
import { testPropertyCacheCount } from "./helpers/program-image.ts";

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
const indexedStore = {
	opcode: "STORE_PROPERTY",
	object: 0,
	key: 2,
	value: 1,
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
		propertyIcCount: testPropertyCacheCount(instructions),
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
	operatorPlan?: NativeFunctionPlan["instructions"][number],
): string {
	const native = createConservativeNativePlan([body]).functions[0]!;
	return emitCompiledFunction(
		lowerNativeFunctionStorage({
			...native,
			registerRepresentations: native.registerRepresentations.map(
				(representation, index) =>
					index === indexedLoad.key ? keyRepresentation : representation,
			),
			instructions: body.instructions.map((instruction) =>
				instruction.opcode === "LOAD_PROPERTY" || instruction.opcode === "STORE_PROPERTY"
					? plan
					: instruction.opcode === "BINARY" || instruction.opcode === "UNARY"
						? operatorPlan
						: undefined,
			),
			gc: { safepoints },
		}),
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
	expect(privateRootRegisters(source)).toContain(register);
	const store = source.match(new RegExp(`__gc_slots\\[(\\d+)\\] = r${register};`));
	expect(store).not.toBeNull();
	return Number(store![1]);
}

describe("native numeric indexed-property root publication", () => {
	it.each(["int32", "number"] as const)(
		"publishes private store inputs only when the %s dense probe misses",
		(representation) => {
			const source = emit(
				fn([retainedLoad, key, indexedStore, call, { opcode: "RETURN", value: 6 }]),
				[
					point(0, [0, 5], [0, 1, 5]),
					point(2, [0, 1, 5], [0, 1, 5]),
					point(3, [0, 1, 3, 4, 5], [6]),
				],
				representation,
			);
			const slot = privateSlot(source, indexedStore.value);
			const publication = `__gc_slots[${slot}] = r${indexedStore.value};`;
			const probe = source.indexOf("mal_vm_array_try_store(");
			const miss = source.indexOf("mal_vm_indexed_fast_store_index(", probe);
			expect(probe).toBeGreaterThan(-1);
			expect(miss).toBeGreaterThan(probe);
			expect(source.slice(probe, miss)).toContain(publication);
			expect(source.slice(probe, miss)).toContain("MAL_ROOT_MASK(");
			const priorMiss = source.indexOf("mal_vm_op_load_property_ic_static_miss(");
			const priorEnd = source.indexOf("\n    }", priorMiss);
			expect(source.slice(priorEnd, probe)).not.toContain(publication);
			const end = source.indexOf("\n    }", miss);
			const nextCall = source.indexOf("mal_vm_call_cached(", end);
			expect(nextCall).toBeGreaterThan(end);
			expect(source.slice(end, nextCall)).toContain(publication);
		},
	);

	it("keeps boxed store keys eagerly published before their coercing helper", () => {
		const source = emit(
			fn([retainedLoad, key, indexedStore, call, { opcode: "RETURN", value: 6 }]),
			[
				point(0, [0, 5], [0, 1, 5]),
				point(2, [0, 1, 2, 5], [0, 1, 5]),
				point(3, [0, 1, 3, 4, 5], [6]),
			],
			"boxed",
		);
		const slot = privateSlot(source, indexedStore.value);
		const helper = source.indexOf("mal_vm_indexed_fast_store(");
		expect(helper).toBeGreaterThan(0);
		expect(source.slice(0, helper)).toContain(`__gc_slots[${slot}] = r1;`);
		expect(source).not.toContain("mal_vm_array_try_store(");
	});

	it.each(["int32", "number"] as const)(
		"keeps unchanged receivers and final results private on successful %s index probes",
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
			privateSlot(source, indexedLoad.dst);
			privateSlot(source, indexedLoad.object);
			expect(source.match(/__gc_slots\[\d+\] = r0;/g)).toHaveLength(1);
			const firstProbe = source.indexOf("mal_vm_array_try_get_index(");
			const mask = source.indexOf("MAL_ROOT_MASK(");
			expect(firstProbe).toBeGreaterThan(-1);
			expect(mask).toBeGreaterThan(firstProbe);
			const secondProbe = source.indexOf("mal_vm_array_try_get_index(", firstProbe + 1);
			for (const probe of [firstProbe, secondProbe]) {
				const miss = source.indexOf("mal_vm_indexed_fast_load_index(", probe);
				const fallback = source.lastIndexOf("} else {", miss);
				expect(source.slice(probe, fallback)).toContain("r3 =");
				expect(source.slice(probe, fallback)).not.toContain("__gc_slots[");
				expect(source.slice(probe, fallback)).not.toContain("MAL_ROOT_MASK(");
			}
			expect(source.match(/mal_vm_indexed_fast_load_index\(/g)).toHaveLength(2);
		},
	);

	it.each([
		["boxed", undefined],
		["number", { kind: "exact-contained-array-element" }],
	] as const)(
		"does not seed results of unaudited %s index plans",
		(representation, plan) => {
			const source = emit(
				fn([key, indexedLoad, call, { opcode: "RETURN", value: 6 }]),
				[point(1, [0, 5], [0, 3, 5]), point(2, [0, 3, 5], [6])],
				representation,
				plan,
			);
			expect(privateRootRegisters(source).size).toBe(0);
		},
	);

	it("admits the indexed receiver while keeping a compound output continuously rooted", () => {
		const source = emit(
			fn([
				{ opcode: "LOAD_STATIC_ARGUMENT", dst: 4, direct: -1, fallback: 3, index: 2 },
				key,
				indexedLoad,
				call,
				{ opcode: "RETURN", value: 6 },
			]),
			[
				point(0, [0, 5], [0, 3, 4, 5]),
				point(2, [0, 5], [0, 3, 5]),
				point(3, [0, 3, 5], [6]),
			],
		);
		expect(source).toContain("#define r3 (__gc_slots[");
		privateSlot(source, indexedLoad.object);
		expect([...privateRootRegisters(source)]).toEqual([0]);
	});

	it("keeps an indexed receiver rooted when another definition uses a compound out-parameter", () => {
		const source = emit(
			fn([
				{ opcode: "LOAD_STATIC_ARGUMENT", dst: 4, direct: -1, fallback: 0, index: 2 },
				key,
				indexedLoad,
				call,
				{ opcode: "RETURN", value: 6 },
			]),
			[
				point(0, [0, 5], [0, 4, 5]),
				point(2, [0, 5], [0, 3, 5]),
				point(3, [0, 3, 5], [6]),
			],
		);
		expect(privateRootRegisters(source)).not.toContain(0);
		expect(source).toContain("#define r0 (__gc_slots[");
		privateSlot(source, indexedLoad.dst);
	});

	it("keeps closure construction final and later exact numeric results private", () => {
		const source = emit(
			fn([
				{ opcode: "CREATE_FUNCTION", dst: 3, functionIndex: 1 },
				call,
				key,
				indexedLoad,
				{ opcode: "BINARY", dst: 3, left: 3, right: 2, operator: "+" },
				{ opcode: "RETURN", value: 3 },
			]),
			[point(0, [0, 5], [0, 3, 5]), point(1, [0, 3, 5], [0, 5]), point(3, [0], [0, 3])],
			"number",
			undefined,
			{ kind: "exact-operator-input-kinds", inputKindMasks: [8, 8] },
		);
		const slot = privateSlot(source, 3);
		const create = source.indexOf("r3 = mal_vm_op_create_function(");
		const publication = source.indexOf(`__gc_slots[${slot}] = r3;`, create);
		const invoke = source.indexOf("mal_vm_call_cached(", create);
		expect(create).toBeGreaterThan(-1);
		expect(publication).toBeGreaterThan(create);
		expect(invoke).toBeGreaterThan(publication);
		const probe = source.indexOf("mal_vm_array_try_get_index(");
		const fallback = source.indexOf("} else {", probe);
		expect(source.slice(probe, fallback)).not.toContain("__gc_slots[");
	});

	it("publishes the preceding numeric-only result on a later indexed miss", () => {
		const source = emit(
			fn([key, indexedLoad, { ...indexedLoad, dst: 4, icIndex: 2 }, call]),
			[
				point(1, [0, 5], [0, 3, 5]),
				point(2, [0, 3, 5], [0, 3, 4, 5]),
				point(3, [0, 3, 4, 5], [6]),
			],
		);
		const slot = privateSlot(source, indexedLoad.dst);
		const firstMiss = source.indexOf("mal_vm_indexed_fast_load_index(");
		const probe = source.indexOf("mal_vm_array_try_get_index(", firstMiss);
		const miss = source.indexOf("mal_vm_indexed_fast_load_index(", probe);
		const fallback = source.lastIndexOf("} else {", miss);
		expect(source.slice(probe, fallback)).not.toContain("__gc_slots[");
		expect(source.slice(fallback, miss)).toContain(`__gc_slots[${slot}] = r3;`);
	});

	it("publishes a numeric-only heap result before a collecting loop poll", () => {
		const source = emit(fn([key, indexedLoad, { opcode: "JUMP", targetIp: 0 }]), [
			point(1, [0], [0, 3]),
			point(2, [0, 3], [0, 3], "loop-backedge"),
		]);
		const slot = privateSlot(source, indexedLoad.dst);
		const miss = source.indexOf("mal_vm_indexed_fast_load_index(");
		const pollGuard = source.indexOf("if (mal_gc_poll)", miss);
		const collection = source.indexOf("mal_gc_safepoint(vm)", pollGuard);
		expect(pollGuard).toBeGreaterThan(miss);
		expect(source.slice(pollGuard, collection)).toContain(`__gc_slots[${slot}] = r3;`);
	});

	it("keeps an indexed result defined inside a collecting loop eligible", () => {
		const source = emit(fn([key, indexedLoad, call, { opcode: "JUMP", targetIp: 1 }]), [
			point(1, [0, 5], [0, 3, 5]),
			point(2, [0, 3, 5], [0, 5, 6]),
			point(3, [0, 5], [0, 5], "loop-backedge"),
		]);
		privateSlot(source, indexedLoad.dst);
	});

	it("adds no publication for an indexed instruction without a refined GC point", () => {
		const source = emit(fn([key, indexedLoad, { opcode: "RETURN", value: 3 }]), []);
		expect(privateRootRegisters(source).size).toBe(0);
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
				"MAL_THREW()",
			);
		},
	);

	it("keeps publication before the boxed-key array probe and its reentrant helper", () => {
		const source = ordinary("boxed");
		const slot = privateSlot(source, retainedLoad.dst);
		const start = source.indexOf(
			`r${key.dst} =`,
			source.indexOf("mal_vm_op_load_property_ic_static_miss("),
		);
		const probe = source.indexOf("mal_vm_array_try_get_index(", start);
		const helper = source.indexOf("mal_vm_indexed_fast_load(", start);
		expect(probe).toBeGreaterThan(start);
		expect(helper).toBeGreaterThan(probe);
		expect(source.slice(start, probe)).toContain(`__gc_slots[${slot}] = r1;`);
		expect(source.slice(start, probe)).toContain("MAL_ROOT_MASK(");
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
