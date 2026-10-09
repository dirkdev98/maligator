import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
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
import { privateRootRegisters, rootMaskBits } from "./helpers/native-c-source.ts";
import { testPropertyCacheCount } from "./helpers/program-image.ts";

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
const charCodeAtPlan = {
	kind: "call",
	guardedBuiltinCall: {
		operation: "String.prototype.charCodeAt",
		guard: {
			dependencies: [{ kind: "world", fact: "primordials.locked" }],
			obligations: ["fallback"],
		},
	},
} satisfies NativeInstructionPlan;

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
		registerCount?: number;
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
		registerCount: options.registerCount ?? 6,
		capturedCount: options.capturedCount ?? 0,
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
		handlers: options.handlers ?? [],
		fileIndex: -1,
		positions: [],
	};
	const native = createConservativeNativePlan([fn]).functions[0]!;
	return emitCompiledFunction(
		lowerNativeFunctionStorage({
			...native,
			instructions: instructions.map((_, ip) => options.nativeInstructions?.get(ip)),
			registerRepresentations: Array.from({ length: fn.registerCount }, (_, register) =>
				fn.registerCount === 6 && register === 5 ? "boolean" : "boxed",
			),
			gc: { safepoints },
		}),
		0,
		"",
		false,
	)!.source;
}

const wideWidth = 130;
const wideFirst = Array.from({ length: wideWidth }, (_, index) => index + 2);
const wideSecond = wideFirst.map((register) => register + wideWidth);
const wideFirstCallIp = wideWidth;
const wideSecondCallIp = 2 * wideWidth + 1;
const wideFinalCallIp = wideSecondCallIp + 1;

/** Two disjoint 130-value chains that share physical slots up to 131. */
function wideSharedRoots(): { native: NativeFunctionPlan; source: string } {
	const result = 2 * wideWidth + 2;
	const loads = (chain: Array<number>, icBase: number): Array<BytecodeInstruction> =>
		chain.map((dst, index) => ({
			...load,
			object: index === 0 ? 0 : dst - 1,
			dst,
			icIndex: icBase + index,
		}));
	const instructions: Array<BytecodeInstruction> = [
		...loads(wideFirst, 0),
		call(result, wideFirst),
		...loads(wideSecond, wideWidth),
		call(result, wideSecond),
		call(result, []),
		{ opcode: "RETURN", value: 0 },
	];
	const chainPoints = (chain: Array<number>, base: number) =>
		chain.map((_, index) =>
			point(
				base + index,
				[0, 1, ...chain.slice(0, index)],
				[0, 1, ...chain.slice(0, index + 1)],
			),
		);
	const body: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 2,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 2,
		registerCount: result + 1,
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
	const native = lowerNativeFunctionStorage({
		...createConservativeNativePlan([body]).functions[0]!,
		instructions: instructions.map(() => undefined),
		storageValues: Array.from({ length: body.registerCount }, (_, register) => register),
		registerRepresentations: Array.from({ length: body.registerCount }, () => "boxed"),
		gc: {
			safepoints: [
				...chainPoints(wideFirst, 0),
				point(wideFirstCallIp, [0, 1, ...wideFirst], [0, 1]),
				...chainPoints(wideSecond, wideFirstCallIp + 1),
				point(wideSecondCallIp, [0, 1, ...wideSecond], [0, 1]),
				point(wideFinalCallIp, [0, 1], [0, 1]),
			],
		},
	});
	return { native, source: emitCompiledFunction(native, 0, "", false)!.source };
}

function inactiveRootBits(source: string, start: number, end: number): bigint {
	const masks = [...source.slice(start, end).matchAll(/MAL_ROOT_MASK(?:_ROW)?\(.*?\);/g)];
	expect(masks.length).toBeGreaterThan(0);
	return rootMaskBits(source, masks.at(-1)![0]);
}

function isInactive(bits: bigint, slot: number): boolean {
	return ((bits >> BigInt(slot)) & 1n) === 1n;
}

function propertyMissPath(
	source: string,
	icIndex: number,
): { start: number; end: number } {
	const end = source.indexOf(`&__property_ic[${icIndex}]);`);
	expect(end).toBeGreaterThan(0);
	return { start: source.lastIndexOf("} else {", end), end };
}

function privatePublication(source: string, register = retained): string {
	expect(privateRootRegisters(source)).toContain(register);
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
	it("tracks the final private root through the full 32-register publication mask", () => {
		const registers = Array.from({ length: 32 }, (_, index) => index + 2);
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "MOVE", dst: 2, src: 0 },
			...registers.slice(1).map((dst, index): BytecodeInstruction => ({
				opcode: "LOAD_PROPERTY_STATIC",
				object: dst - 1,
				dst,
				stringIndex: 0,
				icIndex: index,
			})),
			call(34, registers),
			call(34, registers),
			{ opcode: "MOVE", dst: 33, src: 0 },
			call(34, registers),
			{ opcode: "RETURN", value: 33 },
		];
		const roots = [0, 1, ...registers];
		const source = emit(
			instructions,
			instructions.flatMap((instruction, ip) =>
				instruction.opcode === "CALL" || instruction.opcode === "LOAD_PROPERTY_STATIC"
					? [point(ip, roots, roots)]
					: [],
			),
			{ registerCount: 35 },
		);
		expect(privateRootRegisters(source).size).toBe(32);
		const publication = privatePublication(source, 33);
		const first = 32;
		expect(hasIncomingCopy(beforeCall(source, first), publication)).toBe(true);
		expect(beforeCall(source, first + 1, afterCallResult(source, first))).not.toContain(
			publication,
		);
		const replacement = source.indexOf("r33 = r0;", afterCallResult(source, first + 1));
		expect(replacement).toBeGreaterThan(0);
		expect(hasIncomingCopy(beforeCall(source, first + 3, replacement), publication)).toBe(
			true,
		);
	});

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
			`if (*vm->gc_poll) { ${publication}`,
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
			{
				handlers: [{ startIp: 1, endIp: 3, handlerIp: 4 }],
				nativeInstructions: new Map([[2, { kind: "call" }]]),
			},
		);
		const publication = privatePublication(source);
		const handler = source.indexOf("L4:;");
		expect(source).toContain("goto L4;");
		expect(handler).toBeGreaterThan(source.indexOf("call_result_2.value;"));
		expect(hasIncomingCopy(beforeCall(source, 5, handler), publication)).toBe(true);
	});

	it("keeps an ordinary call result private until its poll or the next collecting call", () => {
		const source = emit(
			[load, call(retained, []), call(), returned],
			[point(0, [0, 1], live), point(1, [0, 1], live), point(2)],
		);
		const publication = privatePublication(source);
		const slot = publication.slice(0, publication.indexOf(" ="));
		const before = beforeCall(
			source,
			1,
			source.indexOf("mal_vm_op_load_property_ic_static_miss"),
		);
		expect(before).toContain(`${slot} = MAL_VALUE_UNDEFINED;`);
		const result = afterCallResult(source, 1);
		const poll = source.indexOf("mal_gc_safepoint(vm)", result);
		expect(source.slice(result, poll)).toContain(`if (*vm->gc_poll) { ${publication}`);
		expect(hasIncomingCopy(beforeCall(source, 2, poll), publication)).toBe(true);
		expect(source).not.toContain(`#define r${retained} (${slot})`);
		expect(source).not.toContain(`__private_r${retained} = ${slot};`);
	});

	it("publishes the old incoming value when an ordinary call reuses its receiver and argument register", () => {
		const reused = { ...call(retained), thisValue: retained };
		const source = emit(
			[load, reused, returned],
			[point(0, [0, 1], live), point(1, live, live)],
		);
		const publication = privatePublication(source);
		const before = beforeCall(
			source,
			1,
			source.indexOf("mal_vm_op_load_property_ic_static_miss"),
		);
		expect(hasIncomingCopy(before, publication)).toBe(true);
		const result = afterCallResult(source, 1);
		expect(
			source.slice(result, source.indexOf("mal_gc_safepoint(vm)", result)),
		).toContain(`if (*vm->gc_poll) { ${publication}`);
	});

	it.each(["callee", "receiver", "argument"] as const)(
		"publishes charCodeAt's reused %s before binding its rooted destination",
		(role) => {
			const reused: BytecodeInstruction = {
				opcode: "CALL",
				dst: retained,
				callee: role === "callee" ? retained : 1,
				thisValue: role === "receiver" ? retained : 0,
				argumentCount: 1,
				arguments: [role === "argument" ? retained : 3],
			};
			const source = emit([load, reused, returned], [point(0, [0, 1], live), point(1)], {
				nativeInstructions: new Map([[1, charCodeAtPlan]]),
			});
			const publication = privatePublication(source);
			const slot = publication.slice(0, publication.indexOf(" ="));
			const propertyMiss = source.indexOf("mal_vm_op_load_property_ic_static_miss");
			const alias = source.indexOf(`#define r${retained} (${slot})`, propertyMiss);
			expect(alias).toBeGreaterThan(propertyMiss);
			expect(source.lastIndexOf(`\n    ${publication}`, alias)).toBeGreaterThan(
				propertyMiss,
			);
			expect(
				source.indexOf("mal_builtin_string_char_code_at_direct(vm", alias),
			).toBeGreaterThan(alias);
			expect(source).not.toContain("mal_builtin_string_char_code_at_try(");
		},
	);

	it("defers charCodeAt publication when its destination is disjoint from its inputs", () => {
		const source = emit([load, call(), returned], [point(0, [0, 1], live), point(1)], {
			nativeInstructions: new Map([[1, charCodeAtPlan]]),
		});
		expect(source).toContain("mal_builtin_string_char_code_at_try(");
	});

	it("takes an ordinary call's throw edge before assigning its private result and republishes catch roots", () => {
		const source = emit(
			[
				load,
				call(3),
				{ ...load, object: 3, dst: 4 },
				returned,
				{ opcode: "CATCH", dst: 4 },
				call(),
				returned,
			],
			[
				point(0, [0, 1], live),
				point(1, live, [...live, 3]),
				point(2, [...live, 3], [...live, 4]),
				point(5, [...live, 4], [...live, 4]),
			],
			{ handlers: [{ startIp: 1, endIp: 2, handlerIp: 4 }] },
		);
		const publication = privatePublication(source);
		privatePublication(source, 3);
		const firstCall = source.indexOf("MalCompletion call_result_1");
		const throwEdge = source.indexOf(
			"if (call_result_1.kind == MAL_COMPLETION_THROW) goto L4;",
			firstCall,
		);
		expect(throwEdge).toBeGreaterThan(firstCall);
		expect(throwEdge).toBeLessThan(afterCallResult(source, 1));
		expect(
			hasIncomingCopy(beforeCall(source, 5, source.indexOf("L4:;")), publication),
		).toBe(true);
	});

	it("uses a rooted call result's reload as publication of the returned heap value", () => {
		const source = emit(
			[load, call(retained, []), call(), returned],
			[point(0, [0, 1], live), point(1, [0, 1], live), point(2)],
			{ nativeInstructions: new Map([[1, { kind: "call" }]]) },
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
		expect(privateRootRegisters(source)).not.toContain(retained);
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

describe("wide private-root publication", () => {
	const { native, source } = wideSharedRoots();
	const storage = native.storage!;

	it.each([63, 64, 127, 128, 129])(
		"masks dead occupants of shared slot %i and clears it only for an active output",
		(slot) => {
			const occupants = storage.rootRegisters.filter(
				(_, index) => storage.rootSlots[index] === slot,
			);
			expect(occupants).toHaveLength(2);
			const [dead, output] = occupants as [number, number];
			expect(wideFirst).toContain(dead);
			expect(wideSecond).toContain(output);
			expect(storage.privateRegisters).toEqual(expect.arrayContaining(occupants));
			const cleared = `__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`;

			const inactiveMiss = propertyMissPath(source, wideWidth);
			expect(output).not.toBe(wideSecond[0]);
			expect(source.slice(inactiveMiss.start, inactiveMiss.end)).not.toContain(cleared);
			expect(isInactive(inactiveRootBits(source, 0, inactiveMiss.end), slot)).toBe(true);

			// Long chains publish on the hot path before the probe instead of in its miss.
			const outputMiss = propertyMissPath(source, output - 2);
			const previousMiss = propertyMissPath(source, output - 3);
			expect(source.slice(previousMiss.end, outputMiss.end)).toContain(cleared);
			expect(isInactive(inactiveRootBits(source, 0, outputMiss.end), slot)).toBe(false);

			expect(
				hasIncomingCopy(
					beforeCall(source, wideSecondCallIp, outputMiss.end),
					`__gc_slots[${slot}] = r${output};`,
				),
			).toBe(true);

			const secondResult = afterCallResult(source, wideSecondCallIp);
			const finalStart = source.indexOf("\n", secondResult) + 1;
			const secondPoll = source.slice(secondResult, finalStart);
			expect(secondPoll).toContain("mal_gc_safepoint(vm)");
			expect(secondPoll).toContain(cleared);
			const finalCall = beforeCall(source, wideFinalCallIp, finalStart);
			expect(finalCall).not.toContain(cleared);
			expect(
				isInactive(
					inactiveRootBits(source, finalStart, finalStart + finalCall.length),
					slot,
				),
			).toBe(true);
			const finalResult = afterCallResult(source, wideFinalCallIp);
			const finalPoll = source.slice(finalResult, source.indexOf("\n", finalResult));
			expect(finalPoll).toContain("mal_gc_safepoint(vm)");
			expect(finalPoll).not.toContain(`__gc_slots[${slot}]`);
		},
	);

	it("resets a wide inactive mask to zero when every shared slot is occupied", () => {
		const firstCall = beforeCall(source, wideFirstCallIp);
		expect(firstCall).toContain("MAL_ROOT_MASK_ROW(");
		expect(inactiveRootBits(source, 0, firstCall.length)).toBe(0n);
	});
});

describe("bounded deferred root publication", () => {
	it("publishes a long run of live probe results on the hot path instead of in every miss", () => {
		const names = Array.from({ length: 24 }, (_, index) => `v${index}`);
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.wide = function wide(source) {
					${names.map((name, index) => `const ${name} = source.p${index};`).join("\n")}
					return [${names.join(", ")}];
				};`,
				"/wide-publication.js",
			),
		);
		const source = emitCompiledFunction(image.native.functions[1]!, 1, "", false)!.source;
		const misses = [
			...source.matchAll(
				/if \(mal_vm_property_try_load_static\([^\n]+\) \{[\s\S]*?\} else \{([\s\S]*?)\n\s+\}/g,
			),
		];
		expect(misses).toHaveLength(names.length);
		for (const [, miss] of misses)
			expect(miss!.match(/__gc_slots\[\d+\] = /g)?.length ?? 0).toBeLessThanOrEqual(8);
		expect(source).toMatch(/\n {4}__gc_slots\[\d+\] = r\d+;/);
	});
});
