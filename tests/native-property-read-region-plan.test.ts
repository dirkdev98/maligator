import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(count = 3) {
	const names = Array.from({ length: count }, (_, i) => `value${i}`);
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.read = function read(receiver) { ${names.map((name) => `const ${name}=receiver.${name};`).join(" ")} return [${names.join(",")}]; };`,
			"/read-region-plan.js",
		),
	);
}

describe("persisted native property read regions", () => {
	it.each([3, 8])(
		"round-trips a %i-load continuation without replaying admission selection",
		(count) => {
			const image = compile(count);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const fn = restored.native.functions[1]!;
			const plan = fn.storage!.propertyReadRegions[0]!;
			expect(plan.loads).toHaveLength(count);
			expect(plan.continuation).toBe("remaining-instructions");
			expect(fn.storage!.propertyReadRegions).toEqual(
				image.native.functions[1]!.storage!.propertyReadRegions,
			);
			expect(fn.body).toEqual(image.native.functions[1]!.body);
			expect(fn.gc).toEqual(image.native.functions[1]!.gc);
			const supplied = lowerNativeFastPaths(
				fn.body,
				fn.registerRepresentations,
				new Set(plan.claimedIps),
				() => true,
				{ kind: "render", plans: [], updates: [], readRegions: [plan] },
			);
			expect([...supplied.propertyReadRegionActions.keys()]).toEqual(
				plan.loads.map((load) => load.ip),
			);
			const emitted = emitCompiledFunction(fn, 1, "", false)!;
			expect(emitted.source.match(/mal_vm_property_read_region_begin\(/g)).toHaveLength(
				1,
			);
			expect(
				emitted.source.match(/mal_vm_property_read_region_try_load\(/g),
			).toHaveLength(count);
			expect(emitted.source).toContain("mal_vm_op_load_property_ic_static_miss(");
		},
	);

	it("rejects forged cache, ownership and continuation metadata at serialization", () => {
		const image = compile();
		const native = image.native.functions[1]!;
		const plan = native.storage!.propertyReadRegions[0]!;
		for (const forged of [
			{ ...plan, object: plan.object + 1 },
			{ ...plan, endIp: plan.endIp + 1 },
			{ ...plan, loads: plan.loads.with(0, { ...plan.loads[0]!, icIndex: 999 }) },
			{ ...plan, claimedIps: [...plan.claimedIps, plan.id] },
			{ ...plan, borrowedRegisters: [] },
			{ ...plan, continuation: "retry" as "remaining-instructions" },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, propertyReadRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("preserves per-load execution events in profiled bodies", () => {
		const original = compile().native.functions[1]!;
		const fn = lowerNativeFunctionStorage({
			...original,
			body: {
				...original.body,
				profileSiteIds: original.body.instructions.map((_, ip) => 10 + ip),
			},
		});
		const emitted = emitCompiledFunction(fn, 1, "", true)!;
		for (const { ip } of fn.storage!.propertyReadRegions[0]!.loads)
			expect(emitted.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${fn.body.profileSiteIds![ip]}, MAL_PROFILE_SITE_EXECUTION, 1)`,
			);
	});

	it("recomputes canonical and typed entry windows independently", () => {
		const original = compile().native.functions[1]!;
		const firstIp = original.storage!.propertyReadRegions[0]!.loads[0]!.ip;
		const first = original.body.instructions[firstIp]!;
		if (!("dst" in first)) throw new Error("Missing read output");
		const entry = {
			id: 0,
			parameterRepresentations: ["boxed" as const],
			resultRepresentation: "boxed" as const,
			registerRepresentations: original.registerRepresentations.with(
				first.dst,
				"number" as const,
			),
			gc: {
				safepoints: original.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter((r) => r !== first.dst),
					incomingRootRegisters: point.incomingRootRegisters.filter(
						(r) => r !== first.dst,
					),
					outgoingRootRegisters: point.outgoingRootRegisters.filter(
						(r) => r !== first.dst,
					),
				})),
			},
		};
		const fn = lowerNativeFunctionStorage({ ...original, directEntries: [entry] });
		expect(fn.storage!.propertyReadRegions).toHaveLength(1);
		expect(fn.directEntries[0]!.storage!.propertyReadRegions).toEqual([]);
		expect(() =>
			validateNativeStorage({
				...fn,
				directEntries: [{ ...fn.directEntries[0]!, storage: fn.storage }],
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
