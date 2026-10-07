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

function compile() {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			"globalThis.read = function read(receiver) { const left=receiver.left; const right=receiver.right; return [left,right]; };",
			"/read-pair-plan.js",
		),
	);
}

describe("persisted native boxed property read pairs", () => {
	it("round-trips both cache sites and consumes the supplied pair without selecting it again", () => {
		const image = compile();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const fn = restored.native.functions[1]!;
		const plan = fn.storage!.propertyReadPairs[0]!;
		expect(plan.loads).toHaveLength(2);
		expect(plan.fallback).toBe("original-instructions");
		expect(fn.storage!.propertyReadPairs).toEqual(
			image.native.functions[1]!.storage!.propertyReadPairs,
		);
		expect(fn.body).toEqual(image.native.functions[1]!.body);
		expect(fn.gc).toEqual(image.native.functions[1]!.gc);
		const supplied = lowerNativeFastPaths(
			fn.body,
			fn.registerRepresentations,
			new Set(plan.claimedIps),
			() => true,
			{
				kind: "render",
				plans: {
					...fn.storage!,
					propertyProjections: [],
					propertyNumericUpdates: [],
					propertyReadRegions: [],
					propertyReadPairs: [plan],
				},
			},
		);
		expect([...supplied.propertyReadPairActions.keys()]).toEqual(
			plan.loads.map((load) => load.ip),
		);
		const emitted = emitCompiledFunction(fn, 1, "", false)!;
		expect(emitted.source.match(/mal_vm_property_try_load_static_pair\(/g)).toHaveLength(
			1,
		);
		expect(emitted.source).toContain("mal_vm_op_load_property_ic_static_miss(");
	});

	it("rejects forged receiver, cache, claims and fallback contracts", () => {
		const image = compile(),
			native = image.native.functions[1]!;
		const plan = native.storage!.propertyReadPairs[0]!;
		for (const forged of [
			{ ...plan, object: plan.object + 1 },
			{ ...plan, loads: plan.loads.with(0, { ...plan.loads[0]!, icIndex: 999 }) },
			{ ...plan, loads: [...plan.loads].reverse() },
			{ ...plan, claimedIps: [plan.id] },
			{ ...plan, borrowedRegisters: [] },
			{ ...plan, fallback: "retry" as "original-instructions" },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, propertyReadPairs: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("preserves execution events at both original loads", () => {
		const original = compile().native.functions[1]!;
		const fn = lowerNativeFunctionStorage({
			...original,
			body: {
				...original.body,
				profileSiteIds: original.body.instructions.map((_, ip) => 10 + ip),
			},
		});
		const emitted = emitCompiledFunction(fn, 1, "", true)!;
		for (const { ip } of fn.storage!.propertyReadPairs[0]!.loads)
			expect(emitted.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${fn.body.profileSiteIds![ip]}, MAL_PROFILE_SITE_EXECUTION, 1)`,
			);
	});

	it("selects canonical and typed entries independently", () => {
		const original = compile().native.functions[1]!;
		const first = original.body.instructions[original.storage!.propertyReadPairs[0]!.id]!;
		if (first.opcode !== "LOAD_PROPERTY_STATIC") throw new Error("Missing pair load");
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
		expect(fn.storage!.propertyReadPairs).toHaveLength(1);
		expect(fn.directEntries[0]!.storage!.propertyReadPairs).toEqual([]);
		expect(() =>
			validateNativeStorage({
				...fn,
				directEntries: [{ ...fn.directEntries[0]!, storage: fn.storage }],
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
