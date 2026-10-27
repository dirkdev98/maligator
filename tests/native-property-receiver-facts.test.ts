import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
	instructionInputKind,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("primitive property receiver facts", () => {
	it.each([
		["function", ""],
		["function*", "yield 0;"],
		["async function", "await 0;"],
		["async function*", "yield 0;await 0;"],
	])("retains receiver facts and accessor effects through %s", (declaration, suspend) => {
		for (const [body, opcode, guard, helper] of [
			[
				"return receiver[key];",
				"LOAD_PROPERTY",
				"mal_vm_as_array(",
				"mal_vm_indexed_fast_load",
			],
			[
				"receiver[key]=value;return value;",
				"STORE_PROPERTY",
				"mal_vm_as_array(",
				"mal_vm_indexed_fast_store",
			],
			[
				"receiver.field=value;return value;",
				"STORE_PROPERTY_STATIC",
				"mal_vm_as_object(",
				"mal_vm_op_store_property_ic(",
			],
			["return key in receiver;", "BINARY", "mal_vm_as_array(", "mal_vm_binary_op("],
		] as const) {
			const out = inspectStaticValueFunction(
				`const pick=function pick(flag,observe){observe(new.target);return flag?'text':42;};${declaration} compute(flag,key,value,observe){const receiver=pick(flag,observe);${suspend}${body}}globalThis.pick=pick;globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			for (const fn of [
				out.native,
				restored.native.functions[out.native.functionIndex]!,
			]) {
				const ip = fn.body.instructions.findIndex(
					(instruction) =>
						instruction.opcode === opcode &&
						(instruction.opcode !== "BINARY" || instruction.operator === "in"),
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				const instruction = fn.body.instructions[ip]!;
				const receiver =
					"object" in instruction
						? instruction.object
						: instruction.opcode === "BINARY" && instruction.operator === "in"
							? instruction.right
							: undefined;
				if (receiver === undefined) throw new Error("Missing property receiver");
				expect(instructionInputKind(fn.facts?.[ip], receiver)).toBe(
					COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
				);
				const effects =
					INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
				expect((fn.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
			}
			expect(out.c.source).not.toContain(guard);
			expect(out.c.source).toContain(helper);
		}
	});
});
