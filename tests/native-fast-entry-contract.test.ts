import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
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
	"mal_ops_is_number",
	"mal_ops_number_as_f64",
	"mal_ops_number_to_i32",
	"mal_ops_number_value",
	"mal_ops_strict_equal_boxed",
	"mal_value_from_i32",
	"mal_value_new_boolean",
	"mal_value_is_truthy",
	"mal_value_is_nil",
	"mal_value_is_empty",
	"mal_vm_typeof_compare",
	"mal_vm_load_captured",
	"mal_vm_as_array",
	"mal_vm_array_try_get_index",
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

function fastEntry(fn: BytecodeFunction): ReadonlyArray<string> | undefined {
	return renderNativeFastEntry({
		fn,
		directEntry: undefined,
		specialized: false,
		signature:
			"MalValue read(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {",
		fullSymbol: "read_full",
		fullArguments: [
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
	it("call only helpers that cannot collect or run JavaScript", () => {
		const lines = fastEntry(body(loadCompareReturn));
		expect(lines).toBeDefined();
		const helpers = new Set(
			[...lines!.join("\n").matchAll(/\b(mal_[a-z0-9_]+)\(/g)].map((match) => match[1]!),
		);
		expect([...helpers].filter((helper) => !NONCOLLECTING_HELPERS.has(helper))).toEqual(
			[],
		);
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
