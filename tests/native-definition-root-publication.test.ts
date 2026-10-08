import { describe, expect, it } from "vitest";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const source = `function define(first,key,value){return {[key]:first,fixed:value};}
	globalThis.define=define;globalThis.result=define({},'dynamic',{});`;

function definitionContract() {
	const out = inspectStaticValueFunction(source, "define", { profile: true });
	const plan = out.native.storage!.literalPropertyDefinitions[0]!;
	expect(plan).toBeDefined();
	const instruction = out.native.body.instructions[plan.instructionIp]!;
	if (instruction.opcode !== "DEFINE_PROPERTY") throw new Error("Missing definition");
	expect(out.native.storage!.privateRegisters).toContain(instruction.key);
	const root = out.native.storage!.rootRegisters.indexOf(instruction.key);
	const publication = `__gc_slots[${out.native.storage!.rootSlots[root]}] = r${instruction.key};`;
	return { out, plan, instruction, publication };
}

describe("native cached-definition root publication", () => {
	it("keeps a private heap load unpublished on a definition hit and republishes it before the next call", () => {
		const { out } = definitionContract();
		const body = {
			...out.native.body,
			parameterCount: 3,
			argumentSnapshotCount: 0,
			argumentSnapshotPlan: [],
			registerCount: 6,
			propertyIcCount: 2,
			profileSiteIds: [-1, -1, -1, -1, -1],
			instructions: [
				{ opcode: "LOAD_PROPERTY_STATIC", dst: 3, object: 0, stringIndex: 0, icIndex: 0 },
				{ opcode: "CREATE_STRING", dst: 4, stringIndex: 1 },
				{
					opcode: "DEFINE_PROPERTY",
					object: 1,
					key: 4,
					value: 3,
					enumerable: true,
					writable: true,
					configurable: true,
				},
				{
					opcode: "CALL",
					dst: 5,
					callee: 2,
					thisValue: 1,
					argumentCount: 1,
					arguments: [3],
				},
				{ opcode: "RETURN", value: 3 },
			],
		} satisfies typeof out.native.body;
		const native = lowerNativeFunctionStorage(
			createConservativeNativePlan([body]).functions[0]!,
			new Map(),
			[
				Array.from("value", (char) => char.charCodeAt(0)),
				Array.from("fixed", (char) => char.charCodeAt(0)),
			],
		);
		expect(native.storage!.privateRegisters).toContain(3);
		const root = native.storage!.rootRegisters.indexOf(3);
		const publication = `__gc_slots[${native.storage!.rootSlots[root]}] = r3;`;
		const emitted = emitCompiledFunction(native, 0, "", false)!.source;
		const load = emitted.indexOf("mal_vm_property_try_load_static(");
		const key = emitted.indexOf("r4 = mal_value_from_string(", load);
		const probe = emitted.indexOf("mal_vm_try_define_property_static_cached(", load);
		const fallback = emitted.indexOf("mal_vm_op_define_property_static_cached(", probe);
		const call = emitted.indexOf("mal_vm_call_cached(", fallback);
		expect(load).toBeGreaterThanOrEqual(0);
		expect(key).toBeGreaterThan(load);
		expect(probe).toBeGreaterThan(key);
		expect(fallback).toBeGreaterThan(probe);
		expect(call).toBeGreaterThan(fallback);
		expect(emitted.slice(key, probe)).not.toContain(publication);
		expect(emitted.slice(probe, fallback)).toContain(publication);
		expect(emitted.slice(fallback, call)).toContain(publication);
	});
	it("publishes a retained profiled literal-key producer only after the cached shape transition misses", () => {
		const { out, instruction, publication } = definitionContract();
		const emitted = out.c.source;
		const key = emitted.indexOf(`r${instruction.key} = mal_value_from_string(`);
		const probe = emitted.indexOf("mal_vm_try_define_property_static_cached(", key);
		const fallback = emitted.indexOf("mal_vm_op_define_property_static_cached(", probe);
		expect(key).toBeGreaterThan(0);
		expect(probe).toBeGreaterThan(key);
		expect(fallback).toBeGreaterThan(probe);
		expect(emitted.slice(key, probe)).not.toContain(publication);
		expect(emitted.slice(probe, fallback)).toContain(publication);
		expect(emitted.slice(fallback)).toContain("MAL_THREW()");
	});

	it.each(["enumerable", "writable", "configurable"] as const)(
		"keeps a non-default %s definition eagerly published",
		(attribute) => {
			const { out, plan, publication } = definitionContract();
			const native = lowerNativeFunctionStorage(
				{
					...out.native,
					body: {
						...out.native.body,
						instructions: out.native.body.instructions.map((op, ip) =>
							ip === plan.instructionIp ? { ...op, [attribute]: false } : op,
						),
					},
				},
				new Map(),
				out.image.runtime.stringConstants,
			);
			const emitted = emitCompiledFunction(
				native,
				native.functionIndex,
				"",
				false,
			)!.source;
			const probe = emitted.indexOf("mal_vm_try_define_property_static_cached(");
			expect(probe).toBeGreaterThan(0);
			expect(emitted.slice(0, probe)).toContain(publication);
		},
	);

	it("keeps the computed boxed-key definition on its eager coercing fallback", () => {
		const { out } = definitionContract();
		const definition = out.native.body.instructions.find(
			(op) => op.opcode === "DEFINE_PROPERTY",
		)!;
		if (definition.opcode !== "DEFINE_PROPERTY") throw new Error("Missing definition");
		expect(out.native.registerRepresentations[definition.key]).toBe("boxed");
		const helper = out.c.source.indexOf("mal_vm_op_define_property(vm,");
		expect(helper).toBeGreaterThan(0);
		expect(out.c.source.slice(0, helper)).toContain("MAL_ROOT_MASK(");
	});
});
