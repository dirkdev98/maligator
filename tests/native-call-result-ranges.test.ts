import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
	instructionResultIntegerRange,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeEntryLookup } from "../src/compiler/target/lower-native-calls.ts";
import { nativeVariantContract } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspectRange(expression: string, caller?: string, locked = true) {
	return inspectStaticValueFunction(
		`const leaf=function leaf(value,hook){try{hook();return ${expression};}catch(error){hook(error);throw error;}};
		${caller ?? "function compute(value,hook,gate){const result=leaf(value,hook);gate();return result%10;}"}
		globalThis.leaf=leaf;globalThis.compute=compute;`,
		"compute",
		{ locked },
	);
}

function boundedCall(out: ReturnType<typeof inspectRange>) {
	const ip = out.native.body.instructions.findIndex(
		(op, ip) =>
			["CALL", "CALL_SPREAD", "CALL_REST_ARGUMENTS", "CALL_SPREAD_ITERABLE"].includes(
				op.opcode,
			) && out.native.facts?.[ip]?.resultIntegerRanges?.[0] !== undefined,
	);
	const op = out.native.body.instructions[ip]!;
	if (ip < 0 || !("dst" in op)) throw new Error("Missing bounded normal call");
	return { ip, op, facts: out.native.facts![ip]! };
}

describe("normal call result integer ranges", () => {
	it.each([
		["value|0", COMPILER_INT32_RANGE],
		["value&255", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
		["value>>>0", COMPILER_UINT32_RANGE],
		["(value>>>0)*2+1", { ...COMPILER_UINT32_RANGE, minimum: 1, maximum: 8589934591 }],
		["value?(value&255):17", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 }],
		["(value&255)+1", { ...COMPILER_INT32_RANGE, minimum: 1, maximum: 256 }],
	] as const)(
		"transports the normal return interval of %s independently of effects",
		(expression, range) => {
			for (const locked of [false, true]) {
				const out = inspectRange(expression, undefined, locked);
				const { ip, op, facts } = boundedCall(out);
				expect(instructionResultIntegerRange(facts, op.dst)).toEqual(range);
				for (const effect of [
					INSTRUCTION_MAY_THROW,
					INSTRUCTION_MAY_GC,
					INSTRUCTION_CALLS_USER_CODE,
				])
					expect(facts.effectMask! & effect).not.toBe(0);
				expect(out.native.gc.safepoints.some((point) => point.instructionIp === ip)).toBe(
					true,
				);
				expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);

	it.each([
		"value?-0:(value&255)",
		"value?NaN:(value&255)",
		"value?Infinity:(value&255)",
		"value?0.5:(value&255)",
		"value?(value&255):undefined",
		"-value",
	])("keeps %s outside the integer result contract", (expression) => {
		const out = inspectRange(expression);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" && op.arguments.length === 2,
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(out.native.facts![ip]!.resultIntegerRanges).toBeUndefined();
		expect(out.c.source).toMatch(/mal_number_remainder\(|MAL_BIN_MOD/);
	});

	it.each([
		["value&65535", { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 65535 }],
		["value>>>0", COMPILER_UINT32_RANGE],
		["+value", undefined],
	] as const)("joins every possible callee's interval with %s", (alternate, expected) => {
		const out = inspectStaticValueFunction(
			`const first=function first(value,hook){try{hook();return value&255;}catch(error){throw error;}};
			const second=function second(value,hook){try{hook();return ${alternate};}catch(error){throw error;}};
			function compute(value,hook,gate,flag){const callee=flag?first:second;const result=callee(value,hook);gate();return result%10;}
			globalThis.first=first;globalThis.second=second;globalThis.compute=compute;`,
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" && op.arguments.length === 2,
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(out.native.facts![ip]!.resultIntegerRanges?.[0]).toEqual(expected);
	});

	it("joins return paths without exporting a dominated branch refinement", () => {
		const out = inspectStaticValueFunction(
			`const leaf=function leaf(value,hook){try{hook();const n=value|0;if(n>5)return n;return -17;}catch(error){throw error;}};
			function compute(value,hook,gate){const result=leaf(value,hook);gate();return result>=-17;}
			globalThis.leaf=leaf;globalThis.compute=compute;`,
			"compute",
		);
		const { facts } = boundedCall(out);
		expect(facts.resultIntegerRanges).toEqual([
			{ ...COMPILER_INT32_RANGE, minimum: -17 },
		]);
	});

	it.each([
		"function compute(args){return leaf(...args)%10;}",
		"function compute(...args){return leaf(...args)%10;}",
		"function* compute(value,hook,gate){const result=leaf(value,hook);yield result;gate();return result%10;}",
		"function* compute(value,hook,gate){yield 0;const result=leaf(value,hook);gate();return result%10;}",
	])("retains the interval through %s", (caller) => {
		const out = inspectRange("value&255", caller);
		const { op, facts } = boundedCall(out);
		expect(instructionResultIntegerRange(facts, op.dst)).toMatchObject({
			minimum: 0,
			maximum: 255,
		});
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		const fn = restored.native.functions[out.native.functionIndex]!;
		const c = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
		expect(c).not.toContain("mal_number_remainder(");
		expect(c).toContain("% (u32)");
		expect(c).not.toContain("mal_ops_number_to_i32(");
	});

	it("decodes a bounded floating ABI result after checking completion in every call branch", () => {
		const out = inspectRange("(value&255)+1");
		const { op } = boundedCall(out);
		expect(out.native.registerRepresentations[op.dst]).toBe("int32");
		const leaf = out.image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(out.image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "leaf",
		)!;
		expect(
			leaf.directEntries.some((entry) => entry.resultRepresentation === "number"),
		).toBe(true);
		const direct = emitCompiledFunction(
			out.native,
			out.native.functionIndex,
			"",
			false,
			"static",
			new Set(out.image.native.functions.map((fn) => fn.functionIndex)),
			[],
			nativeEntryLookup(out.image.native.functions),
			false,
			new Set(),
			out.image.runtime.stringConstants,
		)!.source;
		for (const c of [out.c.source, direct]) {
			expect(c).not.toContain("mal_ops_number_to_i32(");
			expect(c).toMatch(
				/(?:MAL_THREW\(\)|\.kind == MAL_COMPLETION_THROW)[^\n]*\n\s*r\d+ = \(\(i32\) /,
			);
		}
	});

	it("preserves result intervals in admitted caller entry overlays", () => {
		const out = inspectRange(
			"value&255",
			"function compute(value,hook,gate){const result=leaf(value,hook);gate();return result%10;}globalThis.seed=compute(+globalThis.input,globalThis.hook,globalThis.gate);",
		);
		const { ip, op } = boundedCall(out);
		expect(out.native.directEntries.length).toBeGreaterThan(0);
		for (const entry of out.native.directEntries)
			expect(
				instructionResultIntegerRange(
					nativeVariantContract(out.native, entry).facts?.[ip],
					op.dst,
				),
			).toMatchObject({ minimum: 0, maximum: 255 });
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
});
