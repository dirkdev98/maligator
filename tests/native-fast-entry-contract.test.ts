import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import type { InstructionFacts } from "../src/compiler/shared/instruction-facts.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import type { NativeControlFlowPlan } from "../src/compiler/target/native-control-flow.ts";
import { selectNativeStringComparisons } from "../src/compiler/target/native-string-comparisons.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { NativeDirectEntryPlan } from "../src/compiler/target/program-image.ts";
import { renderNativeFastEntry } from "../src/compiler/target/render-native-fast-entry.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

// Helpers that read without collecting, calling JavaScript, or throwing.
const NONCOLLECTING_HELPERS = new Set([
	"mal_vm_leaf_unobserved",
	"mal_vm_leaf_stack_available",
	"mal_value_is_undefined",
	"mal_vm_property_try_load_static",
	"mal_vm_property_try_load_length_static",
	"mal_ops_is_number",
	"mal_ops_number_as_f64",
	"mal_ops_number_to_i32",
	"mal_ops_number_value_to_i32",
	"mal_ops_number_value",
	"mal_ops_strict_equal_boxed",
	"mal_ops_strict_equal_string_constant",
	"mal_string_equals_constant_length",
	"mal_value_to_string",
	"mal_value_from_i32",
	"mal_value_new_boolean",
	"mal_value_to_boolean",
	"mal_value_is_truthy",
	"mal_value_is_nil",
	"mal_value_is_empty",
	"mal_vm_typeof_compare",
	"mal_vm_load_captured",
	"mal_vm_as_array",
	"mal_vm_array_try_get_index",
	"mal_vm_array_try_get_proven_index",
]);

const template = compileSemanticProgramToProgramImage(
	analyzeSourceAndRunSemanticAnalysis(
		`"use strict"; globalThis.read = function read(node) { return node.id; };`,
		"/fast-entry.js",
	),
).runtime.functions.find((fn) => fn.parameterCount === 1)!;

function body(
	instructions: ReadonlyArray<BytecodeInstruction>,
	overrides: Partial<BytecodeFunction> = {},
): BytecodeFunction {
	return {
		...template,
		parameterCount: 2,
		registerCount: 6,
		capturedCount: 0,
		handlers: [],
		instructions: [...instructions],
		positions: instructions.map(() => 0),
		...overrides,
	};
}

const OWN_TRY = "mal_compiled_0_try";
const LENGTH_STRING_INDEX = 7;

it("uses Number and nonnegative integer proofs in frameless indexed reads", () => {
	const fn = body([
		{ opcode: "LOAD_PROPERTY", object: 0, key: 1, dst: 2, icIndex: 0 },
		{ opcode: "RETURN", value: 2 },
	]);
	for (const range of [
		undefined,
		COMPILER_INT32_RANGE,
		{ ...COMPILER_INT32_RANGE, minimum: 0 },
	]) {
		const lines = fastEntry(fn, () => undefined, true, undefined, [
			{
				registers: [2, 0, 1],
				inputOffset: 1,
				inputKindMasks: [COMPILER_VALUE_KIND_OBJECT, COMPILER_VALUE_KIND_NUMBER],
				resultKindMasks: [COMPILER_VALUE_KIND_TOP],
				inputIntegerRanges: [undefined, range],
			},
		])!;
		expect(lines).toBeDefined();
		expect(unexpectedHelpers(lines)).toEqual([]);
		const c = lines.join("\n");
		expect(c).not.toContain("mal_ops_is_number(f1)");
		expect(c.includes("mal_vm_array_try_get_proven_index(")).toBe(range !== undefined);
		expect(c.includes("< 0")).toBe(range !== undefined && range.minimum < 0);
	}
});

it.each([
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_SYMBOL,
])("admits a noncollecting coercibility guard for boxed kinds %i", (kind) => {
	const fn = body([
		{ opcode: "REQUIRE_COERCIBLE", src: 0 },
		{ opcode: "CREATE_NUMBER", dst: 2, value: 7 },
		{ opcode: "RETURN", value: 2 },
	]);
	const lines = fastEntry(fn, () => undefined, true, undefined, [
		{ registers: [0], inputOffset: 0, inputKindMasks: [kind], resultKindMasks: [] },
	]);
	if (kind === COMPILER_VALUE_KIND_NULLISH) {
		expect(lines).toBeUndefined();
		return;
	}
	expect(lines).toBeDefined();
	expect(unexpectedHelpers(lines!)).toEqual([]);
	expect(lines!.join("\n").includes("mal_value_is_nil(f0)")).toBe(
		kind === COMPILER_VALUE_KIND_TOP,
	);
});

/** Runtime helpers a fast body calls beyond the non-collecting ones and its own fast path. */
function unexpectedHelpers(lines: ReadonlyArray<string>): ReadonlyArray<string> {
	const helpers = new Set(
		[...lines.join("\n").matchAll(/\b(mal_[a-z0-9_]+)\(/g)].map((match) => match[1]!),
	);
	return [...helpers]
		.filter((helper) => helper !== OWN_TRY && !NONCOLLECTING_HELPERS.has(helper))
		.sort();
}

function fastEntry(
	fn: BytecodeFunction,
	calleeTry: (ip: number) => string | undefined = () => undefined,
	exported = true,
	controlFlow?: NativeControlFlowPlan,
	facts: ReadonlyArray<InstructionFacts | undefined> = [],
	directEntry?: NativeDirectEntryPlan,
): ReadonlyArray<string> | undefined {
	return renderNativeFastEntry({
		controlFlow,
		elidedPureIps: [],
		stringComparisons: selectNativeStringComparisons(
			createConservativeNativePlan([fn], []).functions[0]!,
			analyzeNativeBodyFacts(fn),
			{ controlFlow, elided: new Set(), stringLength: () => 4 },
		),
		fn,
		facts,
		directEntry,
		specialized: false,
		trySymbol: exported ? OWN_TRY : undefined,
		calleeTry: (ip, callee) => {
			const symbol = calleeTry(ip);
			return symbol === undefined
				? undefined
				: {
						symbol,
						environment: `mal_value_to_function_object(${callee})->creation_env`,
					};
		},
		signature: directEntry
			? "f64 read(MalVm *vm, MalValue this_value, bool p0, MalEnv *env, MalValue callee) {"
			: "MalValue read(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {",
		fullSymbol: "read_full",
		fullArguments: directEntry
			? ["vm", "this_value", "p0", "env", "callee"]
			: [
					"vm",
					"this_value",
					"args",
					"arg_count",
					"new_target",
					"env",
					"callee",
					"entry_state",
				],
		prologue: [],
		functionIndex: "0",
		globalIndex: (index) => String(index),
		stringValue: (index) => `string_${index}`,
		lengthProperty: (index) => index === LENGTH_STRING_INDEX,
		capturePrologue: [],
		capturedLoad: (owner, index) => `mal_vm_load_captured(env, ${owner}, ${index})`,
		f64Literal: String,
	});
}

const loadCompareReturn: ReadonlyArray<BytecodeInstruction> = [
	{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 0, stringIndex: 0, icIndex: 0 },
	{ opcode: "BINARY", dst: 3, left: 2, right: 1, operator: "===" },
	{ opcode: "JUMP_IF", cond: 3, targetIp: 6 },
	{ opcode: "LOAD_PROPERTY", dst: 4, object: 2, key: 1, icIndex: 1 },
	{ opcode: "BINARY", dst: 4, left: 4, right: 1, operator: "<" },
	{ opcode: "RETURN", value: 4 },
	{ opcode: "RETURN", value: 3 },
];

describe("native fast entries", () => {
	it("restarts before an unsupported branch and prunes its reads, writes and cycles", () => {
		const fn = body(
			[
				{ opcode: "JUMP_IF", cond: 0, targetIp: 5 },
				{
					opcode: "CALL",
					dst: 3,
					callee: 1,
					thisValue: -1,
					argumentCount: 0,
					arguments: [],
				},
				{
					opcode: "LOAD_PROPERTY_STATIC",
					dst: 200,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
				},
				{ opcode: "LOAD_CAPTURED", dst: 201, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "JUMP", targetIp: 2 },
				{ opcode: "RETURN", value: 1 },
			],
			{ registerCount: 202 },
		);
		const lines = fastEntry(fn)!;
		expect(lines).toBeDefined();
		expect(unexpectedHelpers(lines)).toEqual([]);
		const c = lines.join("\n");
		expect(c).toContain("if (mal_value_is_truthy(f0)) goto F5;");
		expect(c).not.toContain("f200");
		expect(c).not.toContain("f201");
		expect(c).not.toContain("__fast_ic");
		expect(c).toContain(
			"return read_full(vm, this_value, args, arg_count, new_target, env, callee, entry_state);",
		);
	});

	it("does not borrow register definitions that follow a restart", () => {
		const c = fastEntry(
			body([
				{ opcode: "JUMP_IF", cond: 0, targetIp: 4 },
				{
					opcode: "CALL",
					dst: 3,
					callee: 1,
					thisValue: -1,
					argumentCount: 0,
					arguments: [],
				},
				{ opcode: "CREATE_NUMBER", dst: 2, value: 99 },
				{ opcode: "JUMP", targetIp: 4 },
				{ opcode: "BINARY", dst: 3, left: 2, right: 1, operator: "+" },
				{ opcode: "RETURN", value: 3 },
			]),
		)!.join("\n");
		expect(c).toContain("f2 = MAL_VALUE_UNDEFINED;");
		expect(c).toContain("mal_ops_number_as_f64(f2)");
		expect(c).not.toContain("99");
	});

	it("keeps a sibling return when facts rule out a numeric indexed read", () => {
		const fn = body([
			{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
			{ opcode: "LOAD_PROPERTY", dst: 2, object: 1, key: 0, icIndex: 0 },
			{ opcode: "RETURN", value: 2 },
			{ opcode: "RETURN", value: 1 },
		]);
		const c = fastEntry(fn, undefined, true, undefined, [
			undefined,
			{
				registers: [2, 1, 0],
				inputOffset: 1,
				inputKindMasks: [COMPILER_VALUE_KIND_OBJECT, COMPILER_VALUE_KIND_SYMBOL],
				resultKindMasks: [COMPILER_VALUE_KIND_TOP],
			},
		])!.join("\n");
		expect(c).not.toContain("mal_vm_array_try_get");
		expect(c).not.toContain("f2");
		expect(c).toContain("F3:;");
	});

	it.each(["-", "+", "~", "tonumeric", "increment", "decrement"] as const)(
		"admits a Boolean direct entry for primitive unary %s",
		(operator) => {
			const fn = body(
				[
					{ opcode: "UNARY", dst: 1, src: 0, operator },
					{ opcode: "RETURN", value: 1 },
				],
				{ parameterCount: 1 },
			);
			const entry: NativeDirectEntryPlan = {
				id: 0,
				parameterRepresentations: ["boolean"],
				resultRepresentation: "number",
				registerRepresentations: ["boolean", "number"],
				gc: { safepoints: [] },
				instructionFacts: [
					{
						instructionIp: 0,
						masks: [COMPILER_VALUE_KIND_BOOLEAN],
						results: [COMPILER_VALUE_KIND_NUMBER],
						effectMask: 0,
					},
				],
			};
			const lines = fastEntry(
				fn,
				undefined,
				false,
				undefined,
				[
					{
						inputKindMasks: [COMPILER_VALUE_KIND_BOOLEAN],
						resultKindMasks: [COMPILER_VALUE_KIND_NUMBER],
					},
				],
				entry,
			)!;
			expect(lines).toBeDefined();
			expect(unexpectedHelpers(lines)).toEqual([]);
			const c = lines.join("\n");
			expect(c).toContain("f0 = mal_value_new_boolean(p0);");
			expect(c).not.toContain("mal_ops_is_number(f0)");
			expect(c).toContain("return read_full(vm, this_value, p0, env, callee);");
		},
	);

	it("omits unreachable stores and cycles without renumbering surviving labels", () => {
		const fn = body([
			{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
			{ opcode: "JUMP_IF", cond: 2, targetIp: 4 },
			{
				opcode: "STORE_PROPERTY_STATIC",
				object: 0,
				value: 1,
				stringIndex: 0,
				icIndex: 0,
			},
			{ opcode: "JUMP", targetIp: 1 },
			{ opcode: "RETURN", value: 1 },
		]);
		expect(fastEntry(fn)).toBeDefined();
		const lines = fastEntry(fn, undefined, true, {
			branches: [{ instructionIp: 1, targetIp: 4 }],
			unreachableIps: [2, 3],
		})!;
		expect(lines).toBeDefined();
		expect(lines.join("\n")).toContain("goto F4;");
		expect(lines.join("\n")).toContain("F4:;");
		expect(lines.join("\n")).not.toContain("mal_value_is_truthy");
		expect(lines.join("\n")).not.toContain("f0");
		expect(unexpectedHelpers(lines)).toEqual([]);
	});

	it("budgets only reachable instructions and still rejects a reachable cycle", () => {
		const dead: Array<BytecodeInstruction> = Array.from({ length: 80 }, (_, i) => ({
			opcode: "CREATE_NUMBER",
			dst: i + 100,
			value: i,
		}));
		const fn = body(
			[
				{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
				{ opcode: "JUMP_IF", cond: 2, targetIp: 82 },
				...dead,
				{ opcode: "RETURN", value: 1 },
			],
			{ registerCount: 512 },
		);
		expect(fastEntry(fn)).toBeUndefined();
		const reachable = fastEntry(fn, undefined, true, {
			branches: [{ instructionIp: 1, targetIp: 82 }],
			unreachableIps: Array.from({ length: 80 }, (_, i) => i + 2),
		});
		expect(reachable).toBeDefined();
		expect(reachable!.join("\n")).not.toContain("f100");
		expect(reachable!.join("\n")).not.toContain("f511");
		expect(
			fastEntry(
				body([
					{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
					{ opcode: "JUMP_IF", cond: 1, targetIp: 0 },
					{ opcode: "JUMP", targetIp: 3 },
					{ opcode: "RETURN", value: 1 },
				]),
				undefined,
				true,
				{
					branches: [{ instructionIp: 1, targetIp: 0 }],
					unreachableIps: [2],
				},
			),
		).toBeUndefined();
	});

	it("does not substitute a dead literal writer for a live parameter", () => {
		const fn = body([
			{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
			{ opcode: "JUMP_IF", cond: 2, targetIp: 4 },
			{ opcode: "CREATE_NUMBER", dst: 0, value: 99 },
			{
				opcode: "STORE_PROPERTY_STATIC",
				object: 1,
				value: 0,
				stringIndex: 0,
				icIndex: 0,
			},
			{ opcode: "BINARY", dst: 3, left: 0, right: 1, operator: "+" },
			{ opcode: "RETURN", value: 3 },
		]);
		const text = fastEntry(fn, undefined, true, {
			branches: [{ instructionIp: 1, targetIp: 4 }],
			unreachableIps: [2, 3],
		})!.join("\n");
		expect(text).toContain("mal_ops_number_as_f64(f0)");
		expect(text).not.toContain("99");
	});

	it("retains a literal fact when only unreachable writers disagree", () => {
		const fn = body([
			{ opcode: "CREATE_NUMBER", dst: 2, value: 8 },
			{ opcode: "CREATE_BOOLEAN", dst: 3, value: true },
			{ opcode: "JUMP_IF", cond: 3, targetIp: 5 },
			{ opcode: "CREATE_STRING", dst: 2, stringIndex: 0 },
			{ opcode: "JUMP", targetIp: 5 },
			{ opcode: "BINARY", dst: 4, left: 0, right: 2, operator: "&" },
			{ opcode: "RETURN", value: 4 },
		]);
		const text = fastEntry(fn, undefined, true, {
			branches: [{ instructionIp: 2, targetIp: 5 }],
			unreachableIps: [3, 4],
		})!.join("\n");
		expect(text).toContain("((i32) 8)");
		expect(text).not.toContain("mal_ops_is_number(f2)");
	});

	it("requires literal and integer definitions on every path to their reads", () => {
		const number = fastEntry(
			body([
				{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
				{ opcode: "CREATE_NUMBER", dst: 2, value: 99 },
				{ opcode: "BINARY", dst: 3, left: 2, right: 1, operator: "+" },
				{ opcode: "RETURN", value: 3 },
			]),
		)!.join("\n");
		expect(number).toContain("mal_ops_number_as_f64(f2)");
		expect(number).toContain("f2 = MAL_VALUE_UNDEFINED;");
		const string = fastEntry(
			body([
				{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
				{ opcode: "CREATE_STRING", dst: 2, stringIndex: 3 },
				{ opcode: "BINARY", dst: 3, left: 2, right: 1, operator: "===" },
				{ opcode: "RETURN", value: 3 },
			]),
		)!.join("\n");
		expect(string).toContain("mal_ops_strict_equal_boxed(f2, f1)");
		expect(string).not.toContain("mal_ops_strict_equal_string_constant");
		const integer = fastEntry(
			body([
				{ opcode: "JUMP_IF", cond: 2, targetIp: 3 },
				{ opcode: "BINARY", dst: 2, left: 0, right: 1, operator: "&" },
				{ opcode: "RETURN", value: 2 },
				{ opcode: "RETURN", value: 1 },
			]),
		)!.join("\n");
		expect(integer).toContain("mal_value_is_truthy(f2)");
		expect(integer).not.toContain("mal_ops_number_value_to_i32(f2)");
		expect(integer).toContain("f2 = MAL_VALUE_UNDEFINED;");
	});

	it("omits a boxed default when every successful helper path writes before reading", () => {
		const source = fastEntry(
			body([
				{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
				{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 1, stringIndex: 0, icIndex: 0 },
				{ opcode: "JUMP", targetIp: 4 },
				{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 1, stringIndex: 1, icIndex: 1 },
				{ opcode: "RETURN", value: 2 },
			]),
		)!.join("\n");
		expect(source).toContain("&f2");
		expect(source).not.toContain("f2 = MAL_VALUE_UNDEFINED;");
		expect(source).toContain("goto __full;");
	});

	it("uses a fixed branch proof to omit a default without borrowing the unreachable read", () => {
		const fn = body([
			{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
			{ opcode: "RETURN", value: 2 },
			{ opcode: "RETURN", value: 2 },
			{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 1, stringIndex: 0, icIndex: 0 },
			{ opcode: "RETURN", value: 2 },
		]);
		expect(fastEntry(fn)!.join("\n")).toContain("f2 = MAL_VALUE_UNDEFINED;");
		const selected = fastEntry(fn, undefined, true, {
			branches: [{ instructionIp: 0, targetIp: 3 }],
			unreachableIps: [1, 2],
		})!.join("\n");
		expect(selected).toContain("&f2");
		expect(selected).not.toContain("f2 = MAL_VALUE_UNDEFINED;");
	});

	it("opens a constructible entry with the floating-point pragma before its new.target guard", () => {
		const lines = fastEntry(
			body(loadCompareReturn, { hasPrototype: true }),
			undefined,
			false,
		);
		expect(lines?.[1]).toBe("#pragma STDC FP_CONTRACT OFF");
		expect(lines?.[2]).toContain("mal_value_is_undefined(new_target)");
	});
	it("call only helpers that cannot collect or run JavaScript", () => {
		const lines = fastEntry(body(loadCompareReturn));
		expect(lines).toBeDefined();
		expect(unexpectedHelpers(lines!)).toEqual([]);
	});

	it("read `length` through the probe that answers Arrays and strings inline", () => {
		const text = fastEntry(
			body([
				{
					opcode: "LOAD_PROPERTY_STATIC",
					dst: 1,
					object: 0,
					stringIndex: LENGTH_STRING_INDEX,
					icIndex: 0,
				},
				{ opcode: "RETURN", value: 1 },
			]),
		)!.join("\n");
		expect(text).toContain("mal_vm_property_try_load_length_static(vm, f0,");
	});

	it("branch on a bitwise result by testing the integer", () => {
		const text = fastEntry(
			body([
				{ opcode: "BINARY", dst: 2, left: 0, right: 1, operator: "&" },
				{ opcode: "JUMP_IF", cond: 2, targetIp: 3 },
				{ opcode: "RETURN", value: 0 },
				{ opcode: "RETURN", value: 1 },
			]),
		)!.join("\n");
		expect(text).toContain("if (mal_ops_number_value_to_i32(f2) != 0)");
		expect(text).not.toContain("mal_value_is_truthy(f2)");
	});

	it("read a Number constant's literal instead of converting it per call", () => {
		const masked: ReadonlyArray<BytecodeInstruction> = [
			{
				opcode: "CREATE_NUMBER",
				dst: 1,
				value: 1572864,
			} as unknown as BytecodeInstruction,
			{ opcode: "BINARY", dst: 2, left: 0, right: 1, operator: "&" },
			{ opcode: "RETURN", value: 2 },
		];
		const text = fastEntry(body(masked))!.join("\n");
		expect(text).toContain("((i32) 1572864)");
		expect(text).not.toContain("mal_ops_is_number(f1)");
	});

	it("reach another fast body only through its exported fast path", () => {
		const call: ReadonlyArray<BytecodeInstruction> = [
			{
				opcode: "CALL",
				dst: 2,
				callee: 1,
				thisValue: -1,
				argumentCount: 1,
				arguments: [0],
			} as unknown as BytecodeInstruction,
			{ opcode: "RETURN", value: 2 },
		];
		expect(fastEntry(body(call))).toBeUndefined();
		const lines = fastEntry(body(call), () => "mal_compiled_7_try");
		expect(unexpectedHelpers(lines!)).toEqual([
			"mal_compiled_7_try",
			"mal_value_to_function_object",
		]);
	});

	it("accept a backward jump to a merge block that does not loop", () => {
		expect(
			fastEntry(
				body([
					{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
					{ opcode: "MOVE", dst: 2, src: 1 },
					{ opcode: "RETURN", value: 2 },
					{ opcode: "MOVE", dst: 2, src: 0 },
					{ opcode: "JUMP", targetIp: 2 },
				]),
			),
		).toBeDefined();
	});

	it.each<[string, ReadonlyArray<BytecodeInstruction>, Partial<BytecodeFunction>]>([
		[
			"a call",
			[
				{ opcode: "CALL", dst: 2, callee: 0, thisValue: 1, arguments: [] },
				{ opcode: "RETURN", value: 2 },
			] as unknown as ReadonlyArray<BytecodeInstruction>,
			{},
		],
		[
			"a store",
			[
				{
					opcode: "STORE_PROPERTY_STATIC",
					object: 0,
					value: 1,
					stringIndex: 0,
					icIndex: 0,
				},
				{ opcode: "RETURN", value: 1 },
			] as unknown as ReadonlyArray<BytecodeInstruction>,
			{},
		],
		[
			"a loop",
			[
				{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
				{ opcode: "JUMP", targetIp: 0 },
				{ opcode: "RETURN", value: 1 },
			],
			{},
		],
		[
			"a sloppy receiver",
			[
				{ opcode: "LOAD_THIS", dst: 2 },
				{ opcode: "RETURN", value: 2 },
			],
			{ strict: false },
		],
		["an own environment", loadCompareReturn, { capturedCount: 1 }],
	])("decline a body with %s", (_, instructions, overrides) => {
		expect(fastEntry(body(instructions, overrides))).toBeUndefined();
	});
});
