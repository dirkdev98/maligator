import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function conversion(operation: string, expression: string, profile = false) {
	return inspectStaticValueFunction(
		`function target(input, flag) { return ${operation}(${expression}); }
		globalThis.target = target;`,
		"target",
		{ profile },
	);
}

describe("semantic kind union conversions", () => {
	it.each([false, true])(
		"carries primitive conversions through the artifact with profiling %s",
		(profile) => {
			for (const [operation, expression, operator, mask, allocation] of [
				["Number", "flag ? +input : undefined", "+", 9, false],
				["Number", "flag ? String(input) : undefined", "+", 17, false],
				["String", "flag ? +input : undefined", "tostring", 9, true],
				["String", "flag ? BigInt(input) : undefined", "tostring", 33, true],
			] as const) {
				const out = conversion(operation, expression, profile);
				expect(
					out.core.some(
						(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
					),
				).toBe(false);
				const ip = out.native.body.instructions.findIndex(
					(op, ip) =>
						op.opcode === "UNARY" &&
						op.operator === operator &&
						out.native.facts?.[ip]?.inputKindMasks?.[0] === mask,
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				const effects = nativeInstructionEffects(
					out.native.body.instructions[ip]!,
					out.native.facts?.[ip],
				);
				expect(effects).toMatchObject({
					allocation,
					collection: allocation,
					reentry: false,
					throwing: false,
				});
				expect(out.native.gc.safepoints.some((point) => point.instructionIp === ip)).toBe(
					allocation,
				);
				const restored = deserializeCompilerArtifact(
					serializeCompilerArtifact(out.image),
				);
				const fn = restored.native.functions[out.native.functionIndex]!;
				expect(fn.facts).toEqual(out.native.facts);
				expect(emitCompiledFunction(fn, fn.functionIndex, "", false)!.source).toBe(
					out.c.source,
				);
			}
		},
	);

	it("normalizes nullable Boolean text even when later passes distribute the conversion", () => {
		const out = conversion("String", "flag ? !!input : null");
		expect(out.core.some((op) => op.attributes.operation === "String")).toBe(false);
		expect(out.c.source).not.toContain("mal_vm_unary_op_fast(");
	});

	it("keeps a Symbol error without inventing object reentry", () => {
		const out = conversion("Number", "flag ? Symbol.for(input) : undefined");
		expect(out.core.some((op) => op.attributes.operation === "Number")).toBe(false);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "+",
		);
		expect(
			nativeInstructionEffects(out.native.body.instructions[ip]!, out.native.facts?.[ip]),
		).toMatchObject({ reentry: false, throwing: true, collection: true });
	});

	it.each([
		["Number", "flag ? BigInt(input) : undefined"],
		["Number", "flag ? Object(input) : undefined"],
		["String", "flag ? Symbol.for(input) : undefined"],
		["String", "input"],
		["Number", "input"],
	])("retains the distinct %s conversion of %s", (operation, expression) => {
		const out = conversion(operation, expression);
		expect(
			out.core.some(
				(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
			),
		).toBe(true);
	});

	it("keeps object ToPrimitive effects after normalizing String", () => {
		const out = conversion("String", "flag ? { toString: input } : undefined");
		expect(out.core.some((op) => op.attributes.operation === "String")).toBe(false);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "tostring",
		);
		expect(
			nativeInstructionEffects(out.native.body.instructions[ip]!, out.native.facts?.[ip]),
		).toMatchObject({ reentry: true, throwing: true, collection: true });
	});

	it.each(["Number", "String"])(
		"preserves extra argument effects and %s construction and spread",
		(operation) => {
			const out = inspectStaticValueFunction(
				`function target(input, flag) { return ${operation}(flag ? +input : undefined, globalThis.effect()); }
			globalThis.target = target;`,
				"target",
			);
			expect(out.core.some((op) => op.attributes.operation === operation)).toBe(false);
			expect(out.structure.genericCalls).toBe(1);
			for (const expression of [
				`new ${operation}(flag ? +input : undefined)`,
				`${operation}(...input)`,
			]) {
				const fallback = inspectStaticValueFunction(
					`function target(input, flag) { return ${expression}; } globalThis.target = target;`,
					"target",
				);
				expect(
					fallback.core.some(
						(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
					),
				).toBe(true);
			}
		},
	);

	it.each(["Number", "String"])("retains replaceable %s calls", (operation) => {
		const out = inspectStaticValueFunction(
			`function target(input, flag) { return ${operation}(flag ? +input : undefined); } globalThis.target = target;`,
			"target",
			{ locked: false },
		);
		expect(out.structure.genericCalls).toBe(1);
	});
});
