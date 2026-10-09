import { describe, expect, it } from "vitest";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { testPropertyCacheCount } from "./helpers/program-image.ts";

function emit(
	instructions: Array<BytecodeInstruction>,
	options: Partial<BytecodeFunction> = {},
	relocatable = false,
) {
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: 3,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		propertyIcCount: testPropertyCacheCount(instructions),
		literalShapeCount: 0,
		handlers: [],
		fileIndex: -1,
		positions: [],
		...options,
		instructions,
	};
	const native = createConservativeNativePlan([fn]).functions[0]!;
	const emitted = emitCompiledFunction(
		lowerNativeFunctionStorage({
			...native,
			directEntries:
				fn.isGenerator || fn.isAsync
					? []
					: [
							{
								id: 0,
								parameterRepresentations: [],
								resultRepresentation: "boxed",
								registerRepresentations: native.registerRepresentations,
								gc: native.gc,
							},
						],
		}),
		0,
		"",
		false,
		"static",
		new Set(),
		[],
		new Map(),
		relocatable,
	);
	expect(emitted).not.toBeNull();
	return emitted!;
}

describe("native lexical owner lookup contract", () => {
	it("caches copied captures once per entry without retaining lexical owner caches", () => {
		const emitted = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 3 },
				{ opcode: "CREATE_OBJECT", dst: 1 },
				{ opcode: "LOAD_CAPTURED", dst: 2, ownerFunctionIndex: 2, index: 3 },
				{ opcode: "RETURN", value: 2 },
			],
			{
				closureCaptureOwners: [2],
				closureCaptureValues: [{ ownerFunctionIndex: 2, capturedIndex: 3 }],
			},
		);
		for (const { source } of [emitted, ...emitted.directEntries]) {
			expect(source.match(/mal_vm_load_captured_value_at\(/g)).toHaveLength(1);
			expect(source).toContain(
				"const MalValue __capture_value_0 = mal_vm_load_captured_value_at(env, 2, 3, 0);",
			);
			expect(source).toContain("r0 = __capture_value_0;");
			expect(source).toContain("r2 = __capture_value_0;");
			expect(source).not.toContain("__capture_owner_");
			expect(source).not.toContain("mal_vm_capture_owner");
			expect(source).not.toContain("mal_vm_load_captured(");
			expect(source).toContain(".inactive_slots = 0, .env = env");
			expect(source.indexOf("vm->root_frame_head = &__gc_frame;")).toBeLessThan(
				source.indexOf("mal_vm_load_captured_value_at("),
			);
		}
	});

	it.each([false, true])(
		"keeps copied capture tuples and ordinals distinct in every entry (relocatable=%s)",
		(relocatable) => {
			const emitted = emit(
				[
					{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 3 },
					{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 2, index: 5 },
					{ opcode: "LOAD_CAPTURED", dst: 2, ownerFunctionIndex: 5, index: 3 },
					{ opcode: "RETURN", value: 2 },
				],
				{
					closureCaptureOwners: [2, 5],
					closureCaptureValues: [
						{ ownerFunctionIndex: 2, capturedIndex: 3 },
						{ ownerFunctionIndex: 2, capturedIndex: 5 },
						{ ownerFunctionIndex: 5, capturedIndex: 3 },
					],
				},
				relocatable,
			);
			for (const { source } of [emitted, ...emitted.directEntries]) {
				const owner = (index: number) =>
					relocatable ? `(__mal_relocation->function_base + ${index})` : `${index}`;
				expect(source.match(/mal_vm_load_captured_value_at\(/g)).toHaveLength(3);
				expect(source).toContain(
					`__capture_value_0 = mal_vm_load_captured_value_at(env, ${owner(2)}, 3, 0);`,
				);
				expect(source).toContain(
					`__capture_value_1 = mal_vm_load_captured_value_at(env, ${owner(2)}, 5, 1);`,
				);
				expect(source).toContain(
					`__capture_value_2 = mal_vm_load_captured_value_at(env, ${owner(5)}, 3, 2);`,
				);
				expect(source).toContain("r0 = __capture_value_0;");
				expect(source).toContain("r1 = __capture_value_1;");
				expect(source).toContain("r2 = __capture_value_2;");
				expect(source).not.toContain("__capture_owner_");
			}
		},
	);

	it("resolves each external owner once in canonical and specialized entries", () => {
		const emitted = emit([
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 2, index: 1 },
			{ opcode: "STORE_CAPTURED", src: 1, ownerFunctionIndex: 2, index: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 2, ownerFunctionIndex: 3, index: 0 },
			{ opcode: "RETURN", value: 2 },
		]);
		expect(emitted.directEntries).toHaveLength(1);
		for (const { source } of [emitted, ...emitted.directEntries]) {
			expect(source).toContain("static const i32 __capture_owner_ids[] = { 2, 3 };");
			expect(source.match(/mal_vm_capture_owners\(/g)).toHaveLength(1);
			expect(source).toContain("__capture_owner_2 = __capture_owner_scopes[0]");
			expect(source).toContain("__capture_owner_3 = __capture_owner_scopes[1]");
			expect(source).not.toContain("mal_vm_capture_owner(");
			expect(source).toContain("__capture_owner_2->slots[0]");
			expect(source).toContain("__capture_owner_2->slots[1]");
			expect(source).toContain("__capture_owner_3->slots[0]");
			expect(source).not.toContain("mal_vm_load_captured(");
			expect(source).not.toContain("mal_vm_store_captured(");
			expect(source).toMatch(
				/mal_gc_write_barrier\(__capture_owner_2->slots\[0\]\);[\s\S]*__capture_owner_2->slots\[0\] = [^;]+;[\s\S]*mal_gc_card\(&__capture_owner_2->header,/,
			);
			expect(source).toContain("mal_gc_card(&__capture_owner_2->header, r1);");
		}
	});

	it("uses the certified ordinal or chain position for a selected owner", () => {
		const emitted = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 5, index: 0 },
				{ opcode: "RETURN", value: 1 },
			],
			{ closureCaptureOwners: [-2, 2, 4, 5] },
		);
		for (const { source } of [emitted, ...emitted.directEntries]) {
			expect(source).toContain("__capture_owner_5 = __capture_scopes[3];");
			expect(source).toContain("__capture_owner_5 = __capture_scope;");
			expect(source).not.toContain("mal_vm_capture_owner(env,");
			expect(source).not.toContain("mal_vm_capture_owner_at(");
			expect(source).not.toContain("mal_vm_capture_owners(");
			expect(source).not.toContain("__capture_scope = __capture_scope->parent;");
		}
	});

	it.each([0, 1])(
		"decodes a certified single owner directly after own storage allocation (captured=%s)",
		(capturedCount) => {
			const emitted = emit(
				[
					{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
					{ opcode: "RETURN", value: 0 },
				],
				{ closureCaptureOwners: [2], capturedCount },
			);
			for (const { source } of [emitted, ...emitted.directEntries]) {
				const lookup = `__capture_owner_2 = mal_env_untag_single_owner(${capturedCount > 0 ? "env->parent" : "env"});`;
				expect(source).toContain(lookup);
				expect(source).not.toContain("mal_vm_capture_owner");
				if (capturedCount > 0)
					expect(source.indexOf(lookup)).toBeGreaterThan(
						source.indexOf("env = mal_env_new_compact("),
					);
			}
		},
	);

	it("decodes a bounded capture display or complete chain once per entry", () => {
		const emitted = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 5, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			{ closureCaptureOwners: [2, 3, 5], capturedCount: 1 },
		);
		for (const { source } of [emitted, ...emitted.directEntries]) {
			expect(source).toContain("__closure_captures = env->parent;");
			expect(source).toContain(
				"__closure_captures->function_index == MAL_ENV_CAPTURE_VECTOR",
			);
			expect(source).toContain("__capture_owner_2 = __capture_scopes[0];");
			expect(source).toContain("__capture_owner_5 = __capture_scopes[2];");
			expect(source).toContain("__capture_owner_5 = __capture_scope;");
			expect(source.match(/__capture_scope = __capture_scope->parent;/g)).toHaveLength(2);
			expect(source).toContain(
				"__capture_owner_2 = mal_env_untag_single_owner(__capture_scope);",
			);
			expect(source).not.toContain("__capture_owner_3");
			expect(source).not.toContain("mal_vm_capture_owner");
		}
	});

	it.each([{ isGenerator: true }, { isAsync: true }])(
		"resolves certified coroutine owners from potentially resumed scope chains: %j",
		(options) => {
			const { source } = emit(
				[
					{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
					{ opcode: "RETURN", value: 0 },
				],
				{ closureCaptureOwners: [2], ...options },
			);
			expect(source).toContain("mal_vm_capture_owner_at(env, 2, 0)");
			expect(source).not.toContain("mal_env_untag_single_owner(");
		},
	);

	it("retains the resolver for certified wire overlays and unbounded layouts", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
			{ opcode: "RETURN", value: 0 },
		];
		const overlay = emit(instructions, { closureCaptureOwners: [2] }, true);
		expect(overlay.source).toContain(
			"mal_vm_capture_owner_at(env, (__mal_relocation->function_base + 2), 0)",
		);
		expect(overlay.source).not.toContain("mal_env_untag_single_owner(");
		const large = emit(instructions, {
			closureCaptureOwners: Array.from({ length: 17 }, (_, index) => index + 1),
		});
		expect(large.source).toContain("mal_vm_capture_owner_at(env, 2, 1)");
		expect(large.source).not.toContain("mal_env_untag_single_owner(");
	});

	it.each([false, true])(
		"accesses certified owners without nullable fallbacks (generator=%s)",
		(isGenerator) => {
			const emitted = emit(
				[
					...(isGenerator ? [{ opcode: "GENERATOR_START" as const }] : []),
					{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
					...(isGenerator
						? [{ opcode: "YIELD" as const, yieldedSrc: 0, valueDst: 1, modeDst: 2 }]
						: []),
					{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 2, index: 0 },
					{ opcode: "RETURN", value: 0 },
				],
				{ closureCaptureOwners: [2], isGenerator },
			);
			for (const { source } of [emitted, ...emitted.directEntries]) {
				expect(source).toContain("r0 = __capture_owner_2->slots[0];");
				expect(source).toContain("__capture_owner_2->slots[0] = r0;");
				expect(source).not.toContain("__capture_owner_2 != nullptr");
				expect(source).toContain("mal_gc_write_barrier(__capture_owner_2->slots[0]);");
				expect(source).toContain("mal_gc_card(&__capture_owner_2->header, r0);");
			}
		},
	);

	it.each([{ closureCaptureOwners: undefined }, { closureCaptureOwners: [3] }])(
		"retains nullable fallbacks for an owner absent from the certificate: %j",
		({ closureCaptureOwners }) => {
			const emitted = emit(
				[
					{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
					{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 2, index: 0 },
					{ opcode: "RETURN", value: 0 },
				],
				{ closureCaptureOwners },
			);
			for (const { source } of [emitted, ...emitted.directEntries]) {
				expect(source).toContain(
					"r0 = __capture_owner_2 != nullptr ? __capture_owner_2->slots[0] : MAL_VALUE_UNDEFINED;",
				);
				expect(source).toContain("if (__capture_owner_2 != nullptr) {");
			}
		},
	);

	it("resolves multiple relocated owners in one call with runtime owner IDs", () => {
		const { source } = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 5, index: 0 },
				{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "RETURN", value: 1 },
			],
			{},
			true,
		);
		expect(source).toContain(
			"const i32 __capture_owner_ids[] = { (__mal_relocation->function_base + 2), (__mal_relocation->function_base + 5) };",
		);
		expect(source).not.toContain("static const i32 __capture_owner_ids");
		expect(source.match(/mal_vm_capture_owners\(/g)).toHaveLength(1);
		expect(source).toContain("__capture_owner_2 = __capture_owner_scopes[0]");
		expect(source).toContain("__capture_owner_5 = __capture_owner_scopes[1]");
	});

	it("keeps owned storage direct and resolves external storage after allocation", () => {
		const { source } = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "RETURN", value: 1 },
			],
			{ capturedCount: 1 },
		);
		expect(source).toContain("env->slots[0]");
		expect(source).toContain("mal_gc_card(&env->header, r0);");
		expect(source).not.toContain("mal_vm_capture_owner(env, 0)");
		expect(source.indexOf("mal_vm_capture_owner(env, 2)")).toBeGreaterThan(
			source.indexOf("env = mal_env_new("),
		);
	});

	it("keeps per-iteration bindings dynamic while external owners remain stable", () => {
		const { source } = emit([
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
			{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: -2, index: 0 },
			{ opcode: "ENV_COPY", scopeId: -2, slotCount: 1 },
			{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: -2, index: 0 },
			{ opcode: "STORE_CAPTURED", src: 1, ownerFunctionIndex: 2, index: 0 },
			{ opcode: "ENV_POP" },
			{ opcode: "RETURN", value: 1 },
		]);
		expect(source.match(/mal_vm_capture_owner\(env, 2\)/g)).toHaveLength(1);
		expect(source).toContain("mal_vm_load_captured(env, -2, 0)");
		expect(source).toContain("mal_vm_store_captured(env, -2, 0,");
		expect(source).not.toContain("mal_vm_capture_owner(env, -2)");
	});

	it.each([false, true])(
		"uses certified compact allocation for an owned environment (generator=%s)",
		(isGenerator) => {
			const emitted = emit(
				[
					...(isGenerator ? [{ opcode: "GENERATOR_START" as const }] : []),
					{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
					{ opcode: "RETURN", value: 0 },
				],
				{ capturedCount: 1, closureCaptureOwners: [], isGenerator },
			);
			for (const { source } of [emitted, ...emitted.directEntries]) {
				expect(source).toContain("env = mal_env_new_compact(vm, env, 0, 1);");
				expect(source).not.toContain("env = mal_env_new(");
				expect(source).toContain(".inactive_slots = 0, .env = nullptr");
				expect(source.indexOf("__gc_frame.env = env;")).toBeGreaterThan(
					source.indexOf("env = mal_env_new_compact("),
				);
			}
		},
	);

	it("omits incoming environment roots only for a certified empty layout", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_OBJECT", dst: 0 },
			{ opcode: "RETURN", value: 0 },
		];
		for (const closureCaptureOwners of [undefined, [], [2]]) {
			const emitted = emit(instructions, { closureCaptureOwners });
			for (const { source } of [emitted, ...emitted.directEntries]) {
				expect(source).toContain(
					`.inactive_slots = 0, .env = ${closureCaptureOwners?.length === 0 ? "nullptr" : "env"}`,
				);
			}
		}
	});

	it("relocates external owner identities with the function table", () => {
		const { source } = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			{},
			true,
		);
		expect(source).toContain(
			"mal_vm_capture_owner(env, (__mal_relocation->function_base + 2))",
		);
	});

	it("relocates certified owner identities while retaining their layout ordinal", () => {
		const { source } = emit(
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			{ closureCaptureOwners: [1, 2] },
			true,
		);
		expect(source).toContain(
			"mal_vm_capture_owner_at(env, (__mal_relocation->function_base + 2), 1)",
		);
	});

	it("resolves suspended owners from the restored environment before resume dispatch", () => {
		const { source } = emit(
			[
				{ opcode: "GENERATOR_START" },
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "YIELD", yieldedSrc: 0, valueDst: 1, modeDst: 2 },
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			{ isGenerator: true },
		);
		const restore = source.indexOf("env = resume_state->frame.env;");
		const dispatch = source.indexOf("switch (resume_state->frame.instruction_pointer)");
		expect(restore).toBeGreaterThanOrEqual(0);
		expect(dispatch).toBeGreaterThan(restore);
		expect(source.slice(restore, dispatch)).toContain("mal_vm_capture_owner(env, 2)");
		expect(source.slice(dispatch)).toContain("mal_vm_capture_owner(env, 2)");
		expect(source).not.toContain("mal_vm_load_captured(");
	});

	it("resolves multiple owners once on each fresh or resumed coroutine path", () => {
		const { source } = emit(
			[
				{ opcode: "GENERATOR_START" },
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 2, index: 0 },
				{ opcode: "YIELD", yieldedSrc: 0, valueDst: 1, modeDst: 2 },
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 5, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			{ isGenerator: true },
		);
		const restore = source.indexOf("env = resume_state->frame.env;");
		const dispatch = source.indexOf("switch (resume_state->frame.instruction_pointer)");
		expect(
			source.slice(restore, dispatch).match(/mal_vm_capture_owners\(/g),
		).toHaveLength(1);
		expect(source.slice(dispatch).match(/mal_vm_capture_owners\(/g)).toHaveLength(1);
		expect(source).not.toContain("mal_vm_capture_owner(");
	});
});
