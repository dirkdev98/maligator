import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string) {
	return inspectStaticValueFunction(
		`function compute(input,flag,view){${body}}globalThis.compute=compute;`,
		"compute",
		{ locked: false },
	);
}
function fastBranch(source: string, guard: string) {
	const start = source.indexOf(`if (${guard}`);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("} else {", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("native operand truthiness", () => {
	it.each([
		["isNaN", '""+input'],
		["isFinite", '""+input'],
		["isInteger", "{input}"],
		["isSafeInteger", "flag?undefined:1n"],
	] as const)(
		"folds guarded Number.%s for non-Number inputs %s",
		(predicate, expression) => {
			const out = inspect(`const value=${expression};return Number.${predicate}(value);`);
			const branch = fastBranch(
				out.c.source,
				"mal_builtin_number_predicate_callee_matches",
			);
			expect(branch).not.toContain("mal_builtin_number_is_");
			expect(branch).toMatch(/(?:new_boolean\(false\)|= false;)/);
			expect(out.c.source).toContain("mal_vm_call_cached");
			expect(out.c.source).toContain("mal_gc_poll_requested");
		},
	);

	it.each([
		["{input}", "true"],
		["(input>>>0)+1", "true"],
		["input>>>0", "!= 0"],
		['""+input', "mal_string_length"],
		["1n", "mal_bigint_value"],
		["flag?+input:undefined", "mal_value_is_undefined"],
		["flag?{}:null", "mal_value_is_null"],
		["flag?null:undefined", "false"],
		["flag?+input:!!input", "mal_ops_is_number"],
		['flag?""+input:1n', "mal_value_is_string"],
	] as const)("uses facts in guarded Boolean(%s)", (expression, expected) => {
		const out = inspect(`const value=${expression};return Boolean(value);`);
		const branch = fastBranch(out.c.source, "mal_builtin_boolean_callee_matches");
		expect(branch).toContain(expected);
		expect(branch).not.toContain("mal_value_is_truthy(");
		expect(out.c.source).toContain("mal_vm_call_cached");
		expect(out.c.source).toContain("mal_gc_poll_requested");
	});

	it("retains the complete conversion for an unknown input", () => {
		const out = inspect("return Boolean(input);");
		expect(fastBranch(out.c.source, "mal_builtin_boolean_callee_matches")).toContain(
			"mal_value_is_truthy(",
		);
	});

	it("keeps Number predicate checks for Number inputs that may be NaN", () => {
		const out = inspect("return Number.isFinite(+input);");
		expect(
			fastBranch(out.c.source, "mal_builtin_number_predicate_callee_matches"),
		).toContain("isfinite(");
	});

	it.each(["{input}", "(input>>>0)+1"])(
		"uses proven endian truthiness for %s",
		(expression) => {
			const out = inspect(`const little=${expression};return view.getUint16(0,little);`);
			expect(out.c.source).toMatch(/mal_data_view_read\([^;\n]+, true\)/);
			expect(out.c.source).not.toContain("mal_value_is_truthy(");
			expect(out.c.source).toContain("mal_vm_call_cached");
		},
	);

	it("preserves narrowed conversions and fallback through artifact transport", () => {
		const out = inspect("const value=flag?+input:undefined;return Boolean(value);");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		const native = restored.native.functions[out.native.functionIndex]!;
		const source = emitCompiledFunction(
			native,
			native.functionIndex,
			"",
			false,
			"static",
			new Set(),
			[],
			new Map(),
			false,
			new Set(),
			restored.runtime.stringConstants,
		)!.source;
		expect(fastBranch(source, "mal_builtin_boolean_callee_matches")).toContain(
			"mal_value_is_undefined",
		);
		expect(source).toContain("mal_vm_call_cached");
	});
});
