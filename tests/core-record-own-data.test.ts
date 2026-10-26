import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_SUSPEND,
	INSTRUCTION_MAY_THROW,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const observableEffects =
	INSTRUCTION_CALLS_USER_CODE |
	INSTRUCTION_MAY_GC |
	INSTRUCTION_MAY_SUSPEND |
	INSTRUCTION_MAY_THROW;

function inspect(
	producer: string,
	reader = "hook();return record.value;",
	declaration = "function",
) {
	return inspectStaticValueFunction(
		`const make=function make(value,flag,hook){for(let step=0;step<3;step++)hook(step);${producer}};${declaration} compute(value,flag,hook){const record=make(value,flag,hook);${reader}}globalThis.make=make;globalThis.compute=compute;`,
		"compute",
		{ locked: false },
	);
}

function reads(out: ReturnType<typeof inspect>) {
	return out.native.body.instructions.flatMap((op, ip) =>
		(op.opcode === "LOAD_PROPERTY_STATIC" ||
			op.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
		String.fromCharCode(...out.image.runtime.stringConstants[op.stringIndex]!) === "value"
			? [{ op, ip }]
			: [],
	);
}

describe("returned record own-data presence", () => {
	it.each(["value", "value&255"])(
		"licenses a noncollecting own read independently of the %s value kind",
		(value) => {
			const out = inspect(`return flag?{value:${value},tag:0}:{tag:1,value:${value}};`);
			const fields = reads(out);
			expect(fields).toHaveLength(1);
			for (const { ip } of fields) {
				expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
				expect(out.native.facts![ip]!.effectMask! & observableEffects).toBe(0);
			}
			expect(out.c.source).toContain("mal_vm_load_known_own_data(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([
		["function*", "yield 0;"],
		["async function", "await 0;"],
		["async function*", "yield 0;await 0;"],
	])("preserves own presence across %s suspension", (declaration, suspend) => {
		const out = inspect(
			"return {value};",
			`${suspend}hook();return record['value'];`,
			declaration,
		);
		expect(reads(out)).toHaveLength(1);
		for (const { ip } of reads(out)) {
			expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
			expect(out.native.facts![ip]!.effectMask! & observableEffects).toBe(0);
		}
	});

	it.each([
		["a missing field", "return flag?{value}:{other:value};", "return record.value;"],
		["an accessor", "return {get value(){return value;}};", "return record.value;"],
		["an escape", "return {value};", "hook(record);return record.value;"],
		[
			"a descriptor replacement",
			"return {value};",
			"Object.defineProperty(record,'value',{get(){return 1;}});return record.value;",
		],
	])("keeps generic effects after %s", (_name, producer, reader) => {
		const out = inspect(producer, reader);
		expect(reads(out)).toHaveLength(1);
		for (const { ip } of reads(out)) {
			expect(out.native.instructions[ip]?.kind).not.toBe("known-own-data");
			expect(out.native.facts![ip]!.effectMask! & observableEffects).not.toBe(0);
		}
	});
});
