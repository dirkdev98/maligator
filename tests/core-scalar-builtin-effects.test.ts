import { describe, expect, it } from "vitest";
import { NO_EFFECT_SUMMARY } from "../src/compiler/shared/effect-summary.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const operations = [
	"Number.isFinite",
	"Number.isInteger",
	"Number.isNaN",
	"Number.isSafeInteger",
	"Object.is",
	"ArrayBuffer.isView",
	"JSON.isRawJSON",
];

describe("exact scalar builtin effects", () => {
	it.each(operations)("removes the %s GC point for unknown boxed inputs", (operation) => {
		const out = inspectStaticValueFunction(
			`function compute(input,other){return ${operation}(input,other);}globalThis.compute=compute;`,
			"compute",
		);
		const ip = out.native.body.instructions.findIndex((op) =>
			operation === "Number.isNaN"
				? op.opcode === "BINARY" && op.operator === "!==" && op.left === op.right
				: op.opcode === "CALL_KNOWN" && op.operation === operation,
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual(
			NO_EFFECT_SUMMARY,
		);
		expect(out.native.gc.safepoints).toEqual([]);
		expect(
			nativeInstructionEffects(out.native.body.instructions[ip]!, out.native.facts![ip]),
		).toEqual({
			allocation: false,
			collection: false,
			reentry: false,
			throwing: false,
			invalidation: false,
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(operations)("discards unused %s but keeps argument evaluation", (operation) => {
		const out = inspectStaticValueFunction(
			`function compute(first,last){${operation}(first(),last());return 7;}globalThis.compute=compute;`,
			"compute",
		);
		expect(out.core.some((op) => op.attributes.operation === operation)).toBe(false);
		expect(
			out.native.body.instructions.filter((op) => op.opcode === "CALL"),
		).toHaveLength(2);
	});

	it("preserves each clock read while removing its collecting-call obligations", () => {
		const out = inspectStaticValueFunction(
			"function compute(){Date.now();Date.now();return 7;}globalThis.compute=compute;",
			"compute",
		);
		const clocks = out.native.body.instructions.flatMap((op, ip) =>
			op.opcode === "CALL_KNOWN" && op.operation === "Date.now" ? [ip] : [],
		);
		expect(clocks).toHaveLength(2);
		for (const ip of clocks)
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
				...NO_EFFECT_SUMMARY,
				reads: ["host"],
			});
		expect(out.native.gc.safepoints).toEqual([]);
	});

	it.each([
		"new Number.isFinite(input)",
		"Number.isFinite(...input)",
		"Number.isFinite.apply(null,input)",
		"Number.prototype.valueOf.call(input)",
		"new ArrayBuffer.isView(input)",
		"ArrayBuffer.isView(...input)",
		"JSON.isRawJSON.apply(null,input)",
	])("keeps invocation effects for %s", (expression) => {
		const out = inspectStaticValueFunction(
			`function compute(input){return ${expression};}globalThis.compute=compute;`,
			"compute",
		);
		expect(out.native.gc.safepoints.length).toBeGreaterThan(0);
		const calls = out.native.body.instructions.filter((op) => op.opcode === "CALL_KNOWN");
		for (const call of calls) expect(nativeInstructionEffects(call).throwing).toBe(true);
	});

	it.each(["ArrayBuffer.isView", "JSON.isRawJSON"])(
		"emits the %s brand test without a call bridge",
		(operation) => {
			const out = inspectStaticValueFunction(
				`function compute(input){return ${operation}(input);}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c.source).not.toContain("mal_vm_call_known_native");
			expect(out.c.source).toContain(
				operation === "ArrayBuffer.isView"
					? "mal_value_is_typed_array_object"
					: "->is_raw_json",
			);
		},
	);

	it.each(["Number.isFinite", "Array.isArray", "ArrayBuffer.isView", "JSON.isRawJSON"])(
		"retains mutable %s lookup and call effects",
		(operation) => {
			const out = inspectStaticValueFunction(
				`function compute(input){${operation}(input);return 7;}globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			expect(out.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
			expect(out.native.gc.safepoints.length).toBeGreaterThan(0);
		},
	);

	it("preserves local fields across IsArray without removing its exception path", () => {
		const out = inspectStaticValueFunction(
			"function compute(input){const record={field:42};Array.isArray(input);return record.field;}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Array.isArray",
		);
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
			...NO_EFFECT_SUMMARY,
			reads: ["object-property"],
			mayThrow: true,
			mayGc: true,
		});
		expect(
			out.native.body.instructions.some((op) => op.opcode.startsWith("LOAD_PROPERTY")),
		).toBe(false);
		expect(out.native.gc.safepoints.length).toBeGreaterThan(0);
		expect(out.c.source).toContain("mal_vm_call_known_native");
		expect(out.c.source).toContain("MAL_THREW()");
	});
});
