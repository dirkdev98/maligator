import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type {
	NativeArrayPresencePlan,
	NativeArrayPairDestructurePlan,
} from "../src/compiler/target/lower-native-fast-paths.ts";
import { selectNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

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
				const selected = selectNativeFastPaths(changed);
				expect(
					kind === "presence" ? selected.arrayPresence : selected.arrayPairDestructure,
				).toEqual([]);
			}
		},
	);

	it.each(["presence", "pair"] as const)(
		"retains profile events at every %s instruction",
		(kind) => {
			const original = compile(kind).native.functions[1]!;
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
			const source = emitCompiledFunction(native, 1, "", true)!.source;
			for (const ip of plan.claimedIps)
				expect(source).toContain(
					`MAL_PROFILE_SITE_EVENT(vm, ${100 + ip}, MAL_PROFILE_SITE_EXECUTION, 1)`,
				);
		},
	);
});
