import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(expression = "value.count++") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.update = function update(value, delta) { return ${expression}; };`,
			"/update-plan.js",
		),
	);
}

describe("native SSA property update plans", () => {
	it.each([
		["value.count++", "old"],
		["++value.count", "new"],
		["value.count--", "old"],
		["--value.count", "new"],
		["value.count += delta", "new"],
		["value.count *= 2", "new"],
		["value.other = delta - value.count", "new"],
	])("round-trips separate SSA values for %s", (expression, result) => {
		const image = compile(expression);
		const native = image.native.functions[1]!;
		const plan = native.storage!.propertyNumericUpdates[0]!;
		expect(plan).toBeDefined();
		const load = native.body.instructions[plan.loadIp]!;
		const operation = native.body.instructions[plan.operationIp]!;
		expect(load.opcode).toBe("LOAD_PROPERTY_STATIC");
		expect(operation.opcode === "UNARY" || operation.opcode === "BINARY").toBe(true);
		if (!("dst" in load) || !("dst" in operation))
			throw new Error("Missing update outputs");
		expect(load.dst).not.toBe(operation.dst);
		expect(plan.materializations.map((value) => value.value)).toEqual([result]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image)).native
			.functions[1]!;
		expect(restored.storage!.propertyNumericUpdates).toEqual(
			native.storage!.propertyNumericUpdates,
		);
		expect(restored.body).toEqual(native.body);
		expect(restored.gc).toEqual(native.gc);
		const emitted = emitCompiledFunction(restored, 1, "", false)!;
		expect(emitted.source).toContain("mal_vm_property_numeric_update_commit(");
		expect(emitted.source).toContain("mal_vm_op_load_property_ic_static_miss(");
		expect(emitted.source).not.toContain("MalValue __property_numeric_update_");
		for (const ip of plan.claimedIps)
			expect(emitted.emittedInstructions.has(ip)).toBe(true);
	});

	it("keeps effectful RHS evaluation and incoming branches outside admission", () => {
		expect(
			compile("value.count += delta()").native.functions[1]!.storage!
				.propertyNumericUpdates,
		).toEqual([]);
		const original = compile().native.functions[1]!;
		const plan = original.storage!.propertyNumericUpdates[0]!;
		const body = {
			...original.body,
			instructions: original.body.instructions.with(1, {
				opcode: "JUMP",
				targetIp: plan.operationIp,
			}),
		};
		const conservative = createConservativeNativePlan([body]).functions[0]!;
		expect(
			lowerNativeFunctionStorage(conservative).storage!.propertyNumericUpdates,
		).toEqual([]);
	});

	it("retains numeric-fusion ownership of a preceding boxed RHS", () => {
		const native = compile("value.count = (delta + 2) * value.count").native
			.functions[1]!;
		expect(
			native.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		expect(native.storage!.propertyNumericUpdates).toEqual([]);
	});

	it("selects an update beside an unrelated numeric fusion", () => {
		const native = compile("(value.count += delta, (delta + 2) * delta)").native
			.functions[1]!;
		expect(
			native.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		expect(native.storage!.propertyNumericUpdates).toHaveLength(1);
	});

	it("preserves profile events and rejects adjacent polling edges", () => {
		const original = compile().native.functions[1]!;
		const profiled = lowerNativeFunctionStorage({
			...original,
			body: {
				...original.body,
				profileSiteIds: original.body.instructions.map((_, i) => 10 + i),
			},
		});
		const plan = profiled.storage!.propertyNumericUpdates[0]!;
		expect(plan.materializations.length).toBeGreaterThan(1);
		const emitted = emitCompiledFunction(profiled, 1, "", true)!;
		for (const ip of plan.claimedIps)
			expect(emitted.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${profiled.body.profileSiteIds![ip]}, MAL_PROFILE_SITE_EXECUTION, 1)`,
			);
		const instructions = original.body.instructions.toSpliced(3, 0, {
			opcode: "JUMP",
			targetIp: 4,
		});
		const body = {
			...original.body,
			instructions,
			positions: instructions.map(() => -1),
		};
		const conservative = createConservativeNativePlan([body]).functions[0]!;
		const native = {
			...conservative,
			gc: {
				safepoints: conservative.gc.safepoints.filter(
					(point) => point.instructionIp !== 3,
				),
			},
		};
		expect(
			lowerNativeFunctionStorage(native).storage!.propertyNumericUpdates,
		).toHaveLength(1);
		const polling = {
			...native,
			gc: {
				safepoints: [
					...native.gc.safepoints,
					{
						instructionIp: 3,
						kind: "loop-backedge" as const,
						rootRegisters: [0, 1, 2, 3, 4, 5],
						incomingRootRegisters: [0, 1, 2, 3, 4, 5],
						outgoingRootRegisters: [0, 1, 2, 3, 4, 5],
					},
				].sort((a, b) => a.instructionIp - b.instructionIp),
			},
		};
		expect(lowerNativeFunctionStorage(polling).storage!.propertyNumericUpdates).toEqual(
			[],
		);
	});

	it("rejects forged ownership, operands, materialization and fallback at serialization", () => {
		const image = compile();
		const native = image.native.functions[1]!;
		const plan = native.storage!.propertyNumericUpdates[0]!;
		for (const forged of [
			{ ...plan, loadIp: plan.operationIp },
			{ ...plan, storeIp: plan.operationIp },
			{ ...plan, operation: { kind: "unary" as const, operator: "decrement" as const } },
			{ ...plan, claimedIps: [...plan.claimedIps, plan.loadIp] },
			{ ...plan, borrowedRegisters: [] },
			{ ...plan, materializations: [] },
			{ ...plan, fallback: "retry" as "original-instructions" },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, propertyNumericUpdates: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("does not reuse a boxed entry plan after changing its output representation", () => {
		const original = compile().native.functions[1]!;
		const op =
			original.body.instructions[
				original.storage!.propertyNumericUpdates[0]!.operationIp
			]!;
		if (!("dst" in op)) throw new Error("Missing result");
		const changed = {
			...original,
			gc: {
				safepoints: original.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter((r) => r !== op.dst),
					incomingRootRegisters: point.incomingRootRegisters.filter((r) => r !== op.dst),
					outgoingRootRegisters: point.outgoingRootRegisters.filter((r) => r !== op.dst),
				})),
			},
			registerRepresentations: original.registerRepresentations.with(
				op.dst,
				"int32" as const,
			),
		};
		expect(() => validateNativeStorage(changed)).toThrow(/invalid or stale storage plan/);
		expect(lowerNativeFunctionStorage(changed).storage!.propertyNumericUpdates).toEqual(
			[],
		);
	});
});
