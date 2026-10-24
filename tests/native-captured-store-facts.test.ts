import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inputFactsFixture } from "./helpers/native-input-facts.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

let base: BytecodeFunction | undefined;

function emitStore(owner: "owned" | "fixed" | "dynamic", mask: number | undefined) {
	const ownerFunctionIndex = owner === "fixed" ? 2 : owner === "dynamic" ? -2 : 0;
	const instructions: Array<BytecodeInstruction> = [
		owner === "dynamic"
			? { opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 }
			: { opcode: "CREATE_FUNCTION", dst: 1, functionIndex: 0 },
		{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex, index: 0 },
		{ opcode: "RETURN", value: 0 },
	];
	const fn: BytecodeFunction = {
		...(base ??= inputFactsFixture().image.runtime.functions[0]!),
		registerCount: 2,
		capturedCount: 1,
		parameterCount: 1,
		instructions,
	};
	const native = createConservativeNativePlan([fn]).functions[0]!;
	const facts =
		mask === undefined
			? undefined
			: {
					registers: [0],
					inputOffset: 0,
					inputKindMasks: [mask],
					resultKindMasks: [],
				};
	return emitCompiledFunction(
		lowerNativeFunctionStorage({
			...native,
			facts: [undefined, facts, undefined],
		}),
		0,
		"",
		false,
	)!.source;
}

const nonHeapMasks = [
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
].reduce<Array<number>>(
	(masks, kind) => [...masks, kind, ...masks.map((mask) => mask | kind)],
	[],
);
const heapMasks = [
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_OBJECT,
];
const cases = [
	...nonHeapMasks.map((mask) => ({ mask, needsCard: false })),
	...heapMasks.flatMap((mask) =>
		[mask, mask | COMPILER_VALUE_KIND_NUMBER].map((mask) => ({ mask, needsCard: true })),
	),
	{ mask: COMPILER_VALUE_KIND_TOP, needsCard: true },
	{ mask: undefined, needsCard: true },
];

describe.each(["owned", "fixed", "dynamic"] as const)(
	"%s captured-store barrier contract",
	(owner) => {
		it.each(cases)(
			"uses mask $mask without changing the deletion barrier",
			({ mask, needsCard }) => {
				const source = emitStore(owner, mask);
				if (owner === "dynamic") {
					expect(source).toContain(
						`${needsCard ? "mal_vm_store_captured" : "mal_vm_store_captured_non_heap"}(env, -2, 0, r0);`,
					);
				} else {
					const scope = owner === "owned" ? "env" : "__capture_owner_2";
					const deletion = `mal_gc_write_barrier(${scope}->slots[0]);`;
					const store = `${scope}->slots[0] = r0;`;
					expect(source).toContain(deletion);
					expect(source.indexOf(deletion)).toBeLessThan(source.indexOf(store));
					expect(source.includes(`mal_gc_card(&${scope}->header, r0);`)).toBe(needsCard);
				}
			},
		);
	},
);

it.each([false, true])(
	"restores selected-entry non-heap store facts and retains memory effects (profiling %s)",
	(profile) => {
		const out = inspectStaticValueFunction(
			"function factory(value){let saved=value;globalThis.read=()=>saved;function update(value,flag){const next=flag?value:null;saved=next;return saved;}globalThis.update=update;return update(+globalThis.next,!!globalThis.flag);}globalThis.result=factory({keep:1});",
			"update",
			{ profile },
		);
		const image = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		const native = image.native.functions[out.native.functionIndex]!;
		const ip = native.body.instructions.findIndex((op) => op.opcode === "STORE_CAPTURED");
		const op = native.body.instructions[ip]!;
		if (op.opcode !== "STORE_CAPTURED") throw new Error("Missing captured store");
		const emitted = emitCompiledFunction(native, native.functionIndex, "", false)!;
		expect(native.registerRepresentations[op.src]).toBe("boxed");
		expect(emitted.source).toContain("mal_gc_card(");
		expect(native.directEntries.length).toBeGreaterThan(0);
		for (const entry of native.directEntries) {
			expect(entry.registerRepresentations[op.src]).toBe("boxed");
			const fact = entry.instructionFacts?.find((fact) => fact.instructionIp === ip);
			expect(fact?.masks).toEqual([
				COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_NULL,
			]);
			expect(decodeInstructionEffects(fact!.effectMask).writes).toContain(
				"captured-slot",
			);
			const source = emitted.directEntries.find(
				(emitted) => emitted.id === entry.id,
			)!.source;
			expect(source).toContain("mal_gc_write_barrier(");
			expect(source).not.toContain("mal_gc_card(");
		}
	},
);
