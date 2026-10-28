import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_SUSPEND,
	INSTRUCTION_MAY_THROW,
	decodeInstructionEffects,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
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

function stores(out: ReturnType<typeof inspect>, key = "value") {
	return out.native.body.instructions.flatMap((op, ip) =>
		(op.opcode === "STORE_PROPERTY_STATIC" ||
			op.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") &&
		String.fromCharCode(...out.image.runtime.stringConstants[op.stringIndex]!) === key
			? [{ op, ip }]
			: [],
	);
}

describe("returned record own-data presence", () => {
	it.each(["function", "function*", "async function", "async function*"])(
		"keeps %s writes observable without generic completion or collection",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspect(
				"return flag?{value,tag:0}:{tag:1,value};",
				`${suspend}record['value']=value;hook();return record;`,
				declaration,
			);
			expect(stores(out)).toHaveLength(1);
			for (const { op, ip } of stores(out)) {
				expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
				expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
					reads: [],
					writes: ["object-property"],
					mayThrow: false,
					mayGc: false,
					maySuspend: false,
					callsUserCode: false,
				});
				expect(nativeInstructionEffects(op, out.native.facts![ip])).toEqual({
					allocation: false,
					collection: false,
					throwing: false,
					reentry: false,
					invalidation: true,
				});
				expect(nativeInstructionEffects(op).collection).toBe(true);
			}
			expect(out.c.source).toContain("mal_vm_store_known_own_data(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("keeps merged stores before escape and withdraws stores after escape", () => {
		const out = inspect(
			"return flag?{value,tag:0}:{tag:1,value};",
			"const alias=flag?record:make(value,flag,hook);alias.value=value;hook(alias);alias.value=flag;return alias;",
		);
		const writes = stores(out);
		expect(writes).toHaveLength(2);
		expect(out.native.instructions[writes[0]!.ip]).toEqual({ kind: "known-own-data" });
		expect(out.native.instructions[writes[1]!.ip]?.kind).not.toBe("known-own-data");
	});

	it("retains generic stores for indexed producers outside shaped record summaries", () => {
		const out = inspect("return {'0':value};", "record['0']=flag;hook();return record;");
		expect(stores(out, "0")).toHaveLength(1);
		for (const { ip } of stores(out, "0"))
			expect(out.native.instructions[ip]?.kind).not.toBe("known-own-data");
	});

	it.each([
		["a missing field", "return flag?{value}:{other:value};", ""],
		["an accessor", "return {set value(next){hook(next);}};", ""],
		["a frozen record", "return Object.freeze({value});", ""],
		["a Proxy", "return new Proxy({value},{});", ""],
		["an escape", "return {value};", "hook(record);"],
		[
			"a descriptor replacement",
			"return {value};",
			"Object.defineProperty(record,'value',{writable:false});",
		],
		["a deleted key", "return {value};", "delete record.value;"],
	])("retains generic store effects after %s", (_name, producer, prefix) => {
		const out = inspect(producer, `${prefix}record.value=flag;return record;`);
		expect(stores(out)).toHaveLength(1);
		for (const { op, ip } of stores(out)) {
			expect(out.native.instructions[ip]?.kind).not.toBe("known-own-data");
			expect(out.native.facts![ip]!.effectMask! & observableEffects).not.toBe(0);
			expect(nativeInstructionEffects(op, out.native.facts![ip]).throwing).toBe(true);
		}
	});

	it.each(["function", "function*", "async function", "async function*"])(
		"keeps a %s merged read noncollecting before a later escape",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspect(
				"return {value};",
				`const alias=flag?record:make(value,flag,hook);const saved=alias.value;${suspend}hook(alias);return saved;`,
				declaration,
			);
			expect(reads(out)).toHaveLength(1);
			for (const { ip } of reads(out)) {
				expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
				expect(out.native.facts![ip]!.effectMask! & observableEffects).toBe(0);
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
	it("keeps merged own presence independent of an unknown payload kind", () => {
		const out = inspect(
			"return {value};",
			"const second=make(value,flag,hook);const alias=flag?record:second;const saved=alias.value;hook();return saved;",
		);
		expect(reads(out)).toHaveLength(1);
		for (const { ip } of reads(out)) {
			expect(out.native.instructions[ip]).toEqual({ kind: "known-own-data" });
			expect(out.native.facts![ip]!.effectMask! & observableEffects).toBe(0);
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
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
