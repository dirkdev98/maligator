import { describe, expect, it } from "vitest";
import {
	instructionResultIntegerRange,
	INSTRUCTION_CALLS_USER_CODE,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeVariantContract } from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunctions } from "./helpers/static-values.ts";

const operations = ["Math.floor", "Math.ceil", "Math.trunc", "Math.round"] as const;
function inspect(operation: string, expression = "value&255", locked = true) {
	return inspectStaticValueFunctions(
		`const leaf=function leaf(value,hook){try{hook();return ${operation}(${expression});}catch(error){throw error;}};function compute(value,hook){const n=leaf(value,hook);hook();return n%10;}globalThis.leaf=leaf;globalThis.compute=compute;`,
		["leaf", "compute"],
		{ locked },
	);
}

describe("normal rounding result ranges", () => {
	it.each(operations)(
		"retains bounded Number results through %s and exact calls",
		(operation) => {
			const out = inspect(operation);
			const leaf = out.get("leaf")!,
				caller = out.get("compute")!;
			const call = caller.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL",
			);
			const op = caller.native.body.instructions[call]!;
			if (!("dst" in op)) throw new Error("Missing rounding producer call");
			expect(instructionResultIntegerRange(caller.native.facts![call], op.dst)).toEqual({
				...COMPILER_INT32_RANGE,
				minimum: 0,
				maximum: 255,
			});
			expect(caller.native.registerRepresentations[op.dst]).toBe("int32");
			expect(caller.c.source).not.toContain("mal_number_remainder(");
			expect(
				caller.native.facts![call]!.effectMask! & INSTRUCTION_CALLS_USER_CODE,
			).not.toBe(0);
			const math = leaf.native.body.instructions.findIndex(
				(op) =>
					op.opcode === "MATH_UNARY_NUMBER" ||
					(op.opcode === "CALL_KNOWN" && op.operation === operation),
			);
			const mathOp = leaf.native.body.instructions[math]!;
			if (!mathOp || !("dst" in mathOp))
				throw new Error("Missing exact rounding operation");
			expect(instructionResultIntegerRange(leaf.native.facts![math], mathOp.dst)).toEqual(
				{ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 },
			);
			expect(leaf.native.directEntries.length).toBeGreaterThan(0);
			for (const entry of leaf.native.directEntries) {
				expect(entry.resultRepresentation).toBe("int32");
				expect(
					instructionResultIntegerRange(
						nativeVariantContract(leaf.native, entry).facts?.[math],
						mathOp.dst,
					),
				).toEqual({ ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 });
			}
			expect(
				deserializeCompilerArtifact(serializeCompilerArtifact(caller.image)),
			).toEqual(caller.image);
		},
	);
	it.each(operations)("keeps signed remainder semantics after %s", (operation) => {
		const caller = inspect(operation, "value|0").get("compute")!;
		const ip = caller.native.body.instructions.findIndex((op) => op.opcode === "CALL");
		const op = caller.native.body.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Missing signed rounding call");
		expect(instructionResultIntegerRange(caller.native.facts![ip], op.dst)).toEqual(
			COMPILER_INT32_RANGE,
		);
		expect(caller.c.source).toContain("mal_number_remainder(");
	});

	it.each(operations)("keeps the full unsigned domain after %s", (operation) => {
		const caller = inspect(operation, "value>>>0").get("compute")!;
		const ip = caller.native.body.instructions.findIndex((op) => op.opcode === "CALL");
		const op = caller.native.body.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Missing unsigned rounding call");
		expect(instructionResultIntegerRange(caller.native.facts![ip], op.dst)).toEqual(
			COMPILER_UINT32_RANGE,
		);
		expect(caller.native.registerRepresentations[op.dst]).toBe("number");
		expect(caller.c.source).not.toContain("mal_number_remainder(");
	});
	it.each(operations)(
		"does not lend a guarded %s kernel's range to its miss",
		(operation) => {
			const caller = inspect(operation, "value&255", false).get("compute")!;
			const ip = caller.native.body.instructions.findIndex((op) => op.opcode === "CALL");
			const op = caller.native.body.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Missing guarded rounding call");
			expect(
				instructionResultIntegerRange(caller.native.facts![ip], op.dst),
			).toBeUndefined();
			expect(caller.native.registerRepresentations[op.dst]).toBe("boxed");
		},
	);
	it("converges ranges across mutually recursive rounding calls", () => {
		const out = inspectStaticValueFunctions(
			`const first=function first(d,v,hook){try{hook();if(d<=0)return v&255;return Math.round(second(d-1,v,hook));}catch(e){throw e;}};const second=function second(d,v,hook){try{hook();if(d<=0)return v&127;return Math.floor(first(d-1,v,hook));}catch(e){throw e;}};function compute(d,v,hook){const n=first(d,v,hook);hook();return n%10;}globalThis.first=first;globalThis.second=second;globalThis.compute=compute;`,
			["compute"],
		).get("compute")!;
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL" && op.arguments.length === 3,
		);
		const op = out.native.body.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Missing recursive rounding call");
		expect(instructionResultIntegerRange(out.native.facts![ip], op.dst)).toEqual({
			...COMPILER_INT32_RANGE,
			minimum: 0,
			maximum: 255,
		});
		expect(out.c.source).not.toContain("mal_number_remainder(");
	});

	it.each(["-0", "0/0", "1/0", "+value"])(
		"does not infer integer bounds from an unbounded rounding input (%s)",
		(expression) => {
			const caller = inspect("Math.round", expression).get("compute")!;
			for (const [ip, op] of caller.native.body.instructions.entries())
				if (op.opcode === "CALL")
					expect(caller.native.facts?.[ip]?.resultIntegerRanges?.[0]).toBeUndefined();
		},
	);
});
