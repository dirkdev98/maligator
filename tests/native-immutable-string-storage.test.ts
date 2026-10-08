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
	prefix = "function",
	transfer = "gate()",
	profile = false,
	text = "literal",
) {
	const out = inspectStaticValueFunction(
		`${prefix} literal(gate) { const text=${JSON.stringify(text)}; ${transfer}; return text; } globalThis.literal=literal;`,
		"literal",
		{ profile },
	);
	const ip = out.native.body.instructions.findIndex(
		(op) => op.opcode === "CREATE_STRING",
	);
	const op = out.native.body.instructions[ip]!;
	if (op.opcode !== "CREATE_STRING") throw new Error("Missing literal producer");
	return { ...out, ip, op };
}

describe("immutable native string storage", () => {
	it.each(["literal", "caf\u00e9", "\ud83d\ude00\ud800"])(
		"uses the VM-owned %j row without a local or physical root across a call",
		(text) => {
			const out = literal("function", "gate()", false, text);
			expect(out.native.storage!.rematerializedConstantIps).toContain(out.ip);
			expect(out.native.storage!.rootRegisters).not.toContain(out.op.dst);
			expect(
				out.native.gc.safepoints.some((point) =>
					point.rootRegisters.includes(out.op.dst),
				),
			).toBe(true);
			expect(out.c.source).toContain(
				`#define r${out.op.dst} (mal_value_from_string(&vm->runtime_image->string_constants[${out.op.stringIndex}]))`,
			);
			expect(out.c.source).not.toMatch(new RegExp(`MalValue r${out.op.dst}\\b`));
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("uses string-base relocation for an immutable literal expression", () => {
		const out = literal();
		const source = emitCompiledFunction(
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
		expect(source).toContain(
			`vm->runtime_image->string_constants[(__mal_relocation->string_base + ${out.op.stringIndex})]`,
		);
	});

	it("elides an immutable boxed string while preserving its MalValue ABI", () => {
		const out = literal();
		const native = lowerNativeFunctionStorage({
			...out.native,
			registerRepresentations: out.native.registerRepresentations.map((rep, local) =>
				local === out.op.dst ? "boxed" : rep,
			),
		});
		expect(native.storage!.rematerializedConstantIps).toContain(out.ip);
		expect(native.storage!.rootRegisters).not.toContain(out.op.dst);
		expect(() => validateNativeStorage(native)).not.toThrow();
		expect(
			emitCompiledFunction(native, native.functionIndex, "", false)!.source,
		).toContain(`#define r${out.op.dst} (mal_value_from_string(`);
	});

	it("uses each typed entry's own GC layout for string elision", () => {
		const out = inspectStaticValueFunction(
			"function literal(gate,count){const text='literal';gate();for(let i=0;i<count;i++)gate();return text;}globalThis.literal=literal;globalThis.result=literal(()=>{},3);",
			"literal",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CREATE_STRING",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CREATE_STRING") throw new Error("Missing literal producer");
		expect(out.native.directEntries.length).toBeGreaterThan(0);
		for (const entry of out.native.directEntries) {
			expect(entry.storage!.rematerializedConstantIps).toContain(ip);
			expect(entry.storage!.rootRegisters).not.toContain(op.dst);
		}
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		expect(restored.native.functions[out.native.functionIndex]!.storage).toEqual(
			out.native.storage,
		);
		expect(
			restored.native.functions[out.native.functionIndex]!.directEntries.map(
				(entry) => entry.storage,
			),
		).toEqual(out.native.directEntries.map((entry) => entry.storage));
	});

	it.each([
		["async function", "await gate"],
		["function*", "yield gate"],
	])("omits the literal from %s suspension snapshots", (prefix, transfer) => {
		const out = literal(prefix, transfer);
		const base = lowerNativeSuspension(out.native)!;
		expect(base.points.some((point) => point.registers.includes(out.op.dst))).toBe(true);
		expect(
			out.native.storage!.suspension!.points.every(
				(point) => !point.registers.includes(out.op.dst),
			),
		).toBe(true);
		expect(out.native.storage!.rootRegisters).not.toContain(out.op.dst);
		expect(out.c.source).not.toMatch(new RegExp(`r${out.op.dst} = `));
	});

	it.each([
		["function", "gate()"],
		["async function", "await gate"],
	])(
		"validates retained %s producers with their required roots and snapshots",
		(prefix, transfer) => {
			const out = literal(prefix, transfer);
			const native = out.native;
			const retained = lowerNativeFunctionStorage({
				...native,
				body: { ...native.body, profileSiteIds: native.body.instructions.map(() => -1) },
			});
			const weaker = { ...native, storage: retained.storage };
			expect(weaker.storage!.rematerializedConstantIps).toEqual([]);
			expect(weaker.storage!.rootRegisters).toContain(out.op.dst);
			expect(() => validateNativeStorage(weaker)).not.toThrow();
			const image = {
				...out.image,
				native: {
					...out.image.native,
					functions: out.image.native.functions.with(native.functionIndex, weaker),
				},
			};
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() =>
				validateNativeStorage({
					...native,
					storage: { ...native.storage!, rematerializedConstantIps: [] },
				}),
			).toThrow(/invalid or stale storage plan/);
			if (prefix === "async function") {
				expect(() =>
					validateNativeStorage({
						...weaker,
						storage: { ...weaker.storage!, suspension: native.storage!.suspension },
					}),
				).toThrow(/invalid or stale storage plan/);
			}
		},
	);

	it("retains profiled literal producers and their physical roots", () => {
		const out = literal("function", "gate()", true);
		expect(out.native.storage!.rematerializedConstantIps).toEqual([]);
		expect(out.native.storage!.rootRegisters).toContain(out.op.dst);
		expect(out.c.source).toContain(`r${out.op.dst} = mal_value_from_string(`);
	});

	it("keeps handler-bearing string producers outside rematerialization", () => {
		const out = inspectStaticValueFunction(
			"function literal(gate){try {const text='literal';gate();return text;}catch(error){return error;}}globalThis.literal=literal;",
			"literal",
		);
		expect(out.native.body.handlers.length).toBeGreaterThan(0);
		expect(out.native.storage!.rematerializedConstantIps).toEqual([]);
	});

	it("rejects mutable destinations, raw parameters and plans without SSA ownership", () => {
		const { native, ip, op } = literal();
		const variants = [
			{
				...native,
				body: {
					...native.body,
					instructions: [
						...native.body.instructions.slice(0, -1),
						op,
						native.body.instructions.at(-1)!,
					],
				},
			},
			{ ...native, body: { ...native.body, parameterCount: op.dst + 1 } },
			{ ...native, storageValues: undefined },
		];
		for (const variant of variants) {
			const selected = lowerNativeFunctionStorage(variant);
			expect(selected.storage!.rematerializedConstantIps).not.toContain(ip);
			expect(selected.storage!.rootRegisters).toContain(op.dst);
		}
	});

	it("rejects an arbitrary instruction forged as an immortal producer", () => {
		const { native } = literal();
		const ip = native.body.instructions.findIndex((op) => op.opcode === "CALL");
		expect(ip).toBeGreaterThanOrEqual(0);
		expect(() =>
			validateNativeStorage({
				...native,
				storage: { ...native.storage!, rematerializedConstantIps: [ip] },
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("retains a literal borrowed by a selected constructor initialization", () => {
		const out = inspectStaticValueFunction(
			"globalThis.literal = class literal { #left=1; #right=2; constructor(value){this.a='literal';this.b=value;} };",
			"literal",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CREATE_STRING",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CREATE_STRING") throw new Error("Missing constructor literal");
		expect(out.native.storage!.constructorInitialization!.borrowedRegisters).toContain(
			op.dst,
		);
		const selected = lowerNativeFunctionStorage(out.native);
		expect(selected.storage!.rematerializedConstantIps).not.toContain(ip);
		expect(selected.storage!.rootRegisters).toContain(op.dst);
		expect(() =>
			validateNativeStorage({
				...selected,
				storage: { ...selected.storage!, rematerializedConstantIps: [ip] },
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
