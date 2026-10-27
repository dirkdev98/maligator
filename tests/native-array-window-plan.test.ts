import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type {
	NativeArrayPresencePlan,
	NativeArrayPairDestructurePlan,
} from "../src/compiler/target/lower-native-fast-paths.ts";
import { analyzeNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { positionTableEntries } from "../src/compiler/target/runtime-image.ts";

function compile(kind: "presence" | "pair") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			kind === "presence"
				? `globalThis.pick = function pick(values, expected, callback) { for(let i=0;i<values.length;i++) { callback(i, values, expected); if(i in values) { const same=values[i]===expected[i]; if(!same) return false; } } return true; };`
				: `globalThis.pair = function pair(values) { const [left, right]=values; return [left,right]; };`,
			"/array-window-plan.js",
		),
	);
}

describe("persisted array ownership windows", () => {
	it.each(["presence", "pair"] as const)(
		"retains %s admission only when its receiver may be an Object",
		(kind) => {
			const image = compile(kind),
				native = image.native.functions[1]!;
			const plan =
				kind === "presence"
					? native.storage!.arrayPresence[0]!
					: native.storage!.arrayPairDestructure[0]!;
			const anchor =
				native.body.instructions[
					"membershipIp" in plan ? plan.membershipIp : plan.initializeIp
				]!;
			const receiver =
				anchor.opcode === "BINARY"
					? anchor.right
					: anchor.opcode === "GET_ITERATOR"
						? anchor.source
						: undefined;
			if (receiver === undefined) throw new Error("Missing window receiver");
			for (const [mask, admitted] of [
				[COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING, false],
				[COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT, false],
				[COMPILER_VALUE_KIND_OBJECT, true],
				[COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_STRING, true],
				[COMPILER_VALUE_KIND_TOP, true],
			] as const) {
				const facts = native.facts!.map((facts) =>
					facts?.inputKindMasks === undefined
						? facts
						: {
								...facts,
								inputKindMasks: facts.inputKindMasks.map((kind, index) =>
									facts.registers![facts.inputOffset! + index] === receiver ? mask : kind,
								),
							},
				);
				const lowered = lowerNativeFunctionStorage({ ...native, facts });
				expect(
					kind === "presence"
						? lowered.storage!.arrayPresence.length
						: lowered.storage!.arrayPairDestructure.length,
					String(mask),
				).toBe(admitted ? 1 : 0);
				if (!admitted)
					expect(() => validateNativeStorage({ ...native, facts })).toThrow(
						/invalid or stale storage plan/,
					);
			}
			const unknown = analyzeNativeFastPaths({ ...native, facts: undefined }).plans;
			expect(
				kind === "presence" ? unknown.arrayPresence : unknown.arrayPairDestructure,
			).toHaveLength(1);
		},
	);

	it.each(["presence", "pair"] as const)(
		"round-trips and validates %s claims before rendering",
		(kind) => {
			const image = compile(kind),
				native = image.native.functions[1]!;
			const plans =
				kind === "presence"
					? native.storage!.arrayPresence
					: native.storage!.arrayPairDestructure;
			expect(plans).toHaveLength(1);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image))
				.native.functions[1]!;
			expect(restored.storage).toEqual(native.storage);
			for (const ip of plans[0]!.claimedIps)
				expect(native.storage!.expressionIps).not.toContain(ip);
			for (const register of plans[0]!.borrowedRegisters)
				expect(native.storage!.privateRegisters).not.toContain(register);
			expect(emitCompiledFunction(restored, 1, "", false)!.source).toContain(
				kind === "presence"
					? "mal_vm_array_try_get_present_proven_index("
					: "mal_builtin_array_pair_destructure_try(",
			);
			for (const forged of [
				{ ...plans[0]!, regionIndex: -1 },
				{ ...plans[0]!, claimedIps: [] },
				{ ...plans[0]!, borrowedRegisters: [] },
			])
				expect(() =>
					validateNativeStorage({
						...native,
						storage: {
							...native.storage!,
							...(kind === "presence"
								? {
										arrayPresence: [forged as NativeArrayPresencePlan],
									}
								: {
										arrayPairDestructure: [forged as NativeArrayPairDestructurePlan],
									}),
						},
					}),
				).toThrow(/invalid or stale storage plan/);
		},
	);

	it.each(["presence", "pair"] as const)(
		"rejects external interior entries and polling edges in %s windows",
		(kind) => {
			const native = compile(kind).native.functions[1]!;
			const plan =
				kind === "presence"
					? native.storage!.arrayPresence[0]!
					: native.storage!.arrayPairDestructure[0]!;
			const interior = plan.claimedIps[1]!;
			const external = {
				...native,
				body: {
					...native.body,
					instructions: [
						...native.body.instructions,
						{ opcode: "JUMP" as const, targetIp: interior },
					],
				},
			};
			const handler = {
				...native,
				body: {
					...native.body,
					handlers: [
						{
							startIp: 0,
							endIp: native.body.instructions.length,
							handlerIp: interior,
							catchRegister: 0,
						},
					],
				},
			};
			const polling = {
				...native,
				gc: {
					safepoints: [
						...native.gc.safepoints,
						{
							kind: "loop-backedge" as const,
							instructionIp: plan.claimedIps.find((ip) =>
								["JUMP", "JUMP_IF"].includes(native.body.instructions[ip]!.opcode),
							)!,
							rootRegisters: [],
							incomingRootRegisters: [],
							outgoingRootRegisters: [],
						},
					],
				},
			};
			for (const changed of [external, handler, polling]) {
				const selected = analyzeNativeFastPaths(changed).plans;
				expect(
					kind === "presence" ? selected.arrayPresence : selected.arrayPairDestructure,
				).toEqual([]);
			}
		},
	);

	it.each(["presence", "pair"] as const)(
		"retains profile events at every %s instruction",
		(kind) => {
			const image = compile(kind);
			const original = image.native.functions[1]!;
			const native = lowerNativeFunctionStorage({
				...original,
				body: {
					...original.body,
					profileSiteIds: original.body.instructions.map((_, ip) => 100 + ip),
				},
			});
			const plan =
				kind === "presence"
					? native.storage!.arrayPresence[0]!
					: native.storage!.arrayPairDestructure[0]!;
			expect(plan).toBeDefined();
			const source = emitCompiledFunction(
				native,
				1,
				"",
				positionTableEntries(image.runtime.functions[1]!),
			)!.source;
			for (const ip of plan.claimedIps)
				expect(source).toContain(`MAL_PROFILE_SITE(vm, ${100 + ip})`);
		},
	);
});
