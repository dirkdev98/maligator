import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { lowerNativeSuspension } from "../src/compiler/target/lower-native-suspension.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function literal(
	value: string,
	prefix = "function",
	transfer = "gate()",
	profile = false,
) {
	const out = inspectStaticValueFunction(
		`${prefix} literal(gate){const value=${value};${transfer};return value;}globalThis.literal=literal;`,
		"literal",
		{ profile },
	);
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode.startsWith("CREATE_") && "dst" in op,
	);
	const op = out.native.body.instructions[ip]!;
	if (!("dst" in op)) throw new Error("Missing literal destination");
	return { ...out, ip, op };
}

describe("immutable boxed native storage", () => {
	it.each([
		["null", "MAL_VALUE_NULL"],
		["undefined", "MAL_VALUE_UNDEFINED"],
		["true", "mal_value_new_boolean(true)"],
		["false", "mal_value_new_boolean(false)"],
		["37", "mal_value_from_i32(37)"],
		["-0", "mal_value_from_f64_convert_nan("],
		["0/0", "mal_value_from_f64_convert_nan("],
		["1/0", "mal_value_from_f64_convert_nan("],
		["-1/0", "mal_value_from_f64_convert_nan("],
		["1.5", "mal_value_from_f64_convert_nan("],
	])("rematerializes boxed %s with its MalValue encoding", (value, expression) => {
		const out = literal(value);
		const native = lowerNativeFunctionStorage({
			...out.native,
			registerRepresentations: out.native.registerRepresentations.map((rep, local) =>
				local === out.op.dst ? "boxed" : rep,
			),
		});
		expect(native.storage!.rematerializedConstantIps).toContain(out.ip);
		expect(native.storage!.rootRegisters).not.toContain(out.op.dst);
		const c = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
		expect(c).toContain(`#define r${out.op.dst} (${expression}`);
		expect(c).not.toMatch(new RegExp(`MalValue r${out.op.dst}\\b`));
		expect(() => validateNativeStorage(native)).not.toThrow();
	});

	it("keeps pooled BigInt expressions in the selected symbol namespace", () => {
		const out = literal("123456789012345678901234567890n");
		if (out.op.opcode !== "CREATE_BIGINT") throw new Error("Missing BigInt producer");
		expect(out.native.storage!.rematerializedConstantIps).toContain(out.ip);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.dst);
		const c = emitCompiledFunction(
			out.native,
			out.native.functionIndex,
			"_pool",
			false,
		)!.source;
		expect(c).toContain(
			`mal_value_from_bigint(&mal_bigints_pool[${out.op.bigintIndex}])`,
		);
		const relocated = emitCompiledFunction(
			out.native,
			out.native.functionIndex,
			"",
			false,
			"external",
			new Set(),
			[],
			new Map(),
			true,
		)!.source;
		expect(relocated).toContain(
			`runtime_image->bigint_constants[(__mal_relocation->bigint_base + ${out.op.bigintIndex})]`,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["null", "undefined", "123456789012345678901234567890n"])(
		"restores the storage required by a retained %s producer",
		(value) => {
			const out = literal(value, "async function", "await gate");
			const retained = lowerNativeFunctionStorage({
				...out.native,
				body: {
					...out.native.body,
					profileSiteIds: out.native.body.instructions.map(() => -1),
				},
			});
			const weaker = { ...out.native, storage: retained.storage };
			expect(weaker.storage!.rootRegisters).toContain(out.op.dst);
			expect(
				lowerNativeSuspension(out.native)!.points.some((point) =>
					point.registers.includes(out.op.dst),
				),
			).toBe(true);
			expect(
				out.native.storage!.suspension!.points.every(
					(point) => !point.registers.includes(out.op.dst),
				),
			).toBe(true);
			expect(() => validateNativeStorage(weaker)).not.toThrow();
			expect(() =>
				validateNativeStorage({
					...out.native,
					storage: { ...out.native.storage!, rematerializedConstantIps: [] },
				}),
			).toThrow(/invalid or stale storage plan/);
		},
	);

	it("passes a pooled BigInt namespace through resumable expression rendering", () => {
		const out = literal("17n", "function*", "yield gate");
		if (out.op.opcode !== "CREATE_BIGINT") throw new Error("Missing BigInt producer");
		const c = emitCompiledFunction(
			out.native,
			out.native.functionIndex,
			"_resume",
			false,
		)!.source;
		expect(c).toContain(
			`mal_value_from_bigint(&mal_bigints_resume[${out.op.bigintIndex}])`,
		);
		expect(c).not.toMatch(new RegExp(`r${out.op.dst} = `));
	});

	it.each(["null", "undefined", "17n"])("retains profiled %s producers", (value) => {
		const out = literal(value, "function", "gate()", true);
		expect(out.native.storage!.rematerializedConstantIps).toEqual([]);
		expect(out.native.storage!.rootRegisters).toContain(out.op.dst);
	});

	it("keeps the TDZ hole sentinel in explicit storage", () => {
		const out = literal("null");
		const native = lowerNativeFunctionStorage({
			...out.native,
			body: {
				...out.native.body,
				instructions: out.native.body.instructions.map((op, ip) =>
					ip === out.ip ? { opcode: "CREATE_EMPTY", dst: out.op.dst } : op,
				),
			},
		});
		expect(native.storage!.rematerializedConstantIps).not.toContain(out.ip);
		expect(native.storage!.rootRegisters).toContain(out.op.dst);
		expect(() =>
			validateNativeStorage({
				...native,
				storage: { ...native.storage!, rematerializedConstantIps: [out.ip] },
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("retains a null tag borrowed by constructor initialization", () => {
		const out = inspectStaticValueFunction(
			"globalThis.literal=class literal {#left=1;#right=2;constructor(value){this.a=null;this.b=value;}};",
			"literal",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CREATE_NULL",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CREATE_NULL") throw new Error("Missing constructor null");
		expect(out.native.storage!.constructorInitialization!.borrowedRegisters).toContain(
			op.dst,
		);
		expect(out.native.storage!.rematerializedConstantIps).not.toContain(ip);
		expect(() =>
			validateNativeStorage({
				...out.native,
				storage: { ...out.native.storage!, rematerializedConstantIps: [ip] },
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
