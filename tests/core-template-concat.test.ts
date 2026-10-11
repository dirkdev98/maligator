import { describe, expect, it } from "vitest";
import { coreOpcode } from "../src/compiler/core/core-ir-opcodes.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("template string construction", () => {
	it.each([false, true])("owns intrinsic construction with locked=%s", (locked) => {
		const out = inspectStaticValueFunction(
			"function template(a,b) { return `head${a}middle${b}tail`; } globalThis.template=template;",
			"template",
			{ locked },
		);
		expect(out.core.filter((op) => op.opcode === "concatStrings")).toHaveLength(1);
		expect(
			out.core
				.filter((op) => op.opcode === "stringConcatLength")
				.map((op) => op.attributes.followingQuasiLength),
		).toEqual([6]);
		expect(out.core.some((op) => op.opcode === "binary")).toBe(false);
		expect(
			out.fn.instructions.filter((op) => op.opcode === "CONCAT_STRINGS"),
		).toHaveLength(1);
		expect(
			out.fn.instructions.filter((op) => op.opcode === "STRING_CONCAT_LENGTH"),
		).toHaveLength(1);
	});

	it("retains converted strings across later coercions and the final allocation", () => {
		const out = inspectStaticValueFunction(
			"function template(a,b,c) { return `${a}${b}${c}`; } globalThis.template=template;",
			"template",
			{ locked: false },
		);
		const instructions = out.native.body.instructions;
		const concatIp = instructions.findIndex((op) => op.opcode === "CONCAT_STRINGS");
		const concat = instructions[concatIp]!;
		if (concat.opcode !== "CONCAT_STRINGS") throw new Error("Missing concat");
		const roots = out.native.gc.safepoints.find(
			(point) => point.instructionIp === concatIp,
		)!.rootRegisters;
		for (const input of concat.arguments) expect(roots).toContain(input);
		const coercions = instructions.flatMap((op, ip) =>
			op.opcode === "UNARY" && op.operator === "tostring" ? [{ op, ip }] : [],
		);
		expect(coercions).toHaveLength(3);
		for (const later of coercions.slice(1))
			expect(
				out.native.gc.safepoints.find((point) => point.instructionIp === later.ip)!
					.rootRegisters,
			).toContain(coercions[0]!.op.dst);
	});

	it("keeps length errors and final allocation when the template result is discarded", () => {
		const out = inspectStaticValueFunction(
			"function template(a,b) { `${a}${b}`; } globalThis.template=template;",
			"template",
		);
		expect(out.core.filter((op) => op.opcode === "stringConcatLength")).toHaveLength(1);
		expect(out.core.filter((op) => op.opcode === "concatStrings")).toHaveLength(1);
		for (const opcode of ["stringConcatLength", "concatStrings"] as const) {
			expect(coreOpcode(opcode).effects).toMatchObject({
				mayThrow: true,
				mayGc: true,
				callsUserCode: false,
			});
			expect(coreOpcode(opcode).discardable).toBe(false);
		}
	});

	it.each(["`static`", "`${value}`"])("avoids construction for %s", (expression) => {
		const out = inspectStaticValueFunction(
			`function template(value) { return ${expression}; } globalThis.template=template;`,
			"template",
		);
		expect(
			out.core.some((op) => ["concatStrings", "stringConcatLength"].includes(op.opcode)),
		).toBe(false);
	});

	it.each([64, 65])("uses the bounded transport for %s parts", (count) => {
		const out = inspectStaticValueFunction(
			`function template(value) { return \`${"${value}".repeat(count)}\`; } globalThis.template=template;`,
			"template",
		);
		const concats = out.core.filter((op) => op.opcode === "concatStrings");
		expect(concats).toHaveLength(count === 64 ? 1 : 0);
		if (count === 64) expect(concats[0]!.inputs).toHaveLength(64);
		else {
			expect(out.core.some((op) => op.opcode === "stringConcatLength")).toBe(false);
			expect(out.core.some((op) => op.opcode === "binary")).toBe(true);
		}
	});
});
