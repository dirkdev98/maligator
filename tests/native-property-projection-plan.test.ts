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
import type {
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(properties = "value.left + value.right") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.project = function project(value) { return ${properties}; };`,
			"/projection-plan.js",
		),
	);
}

function scalarContract(poll = false) {
	const template = compile().native.functions[1]!.body;
	const instructions: Array<BytecodeInstruction> = [
		{ opcode: "LOAD_PROPERTY_STATIC", object: 0, dst: 1, stringIndex: 0, icIndex: 0 },
		{ opcode: "JUMP", targetIp: 2 },
		{ opcode: "LOAD_PROPERTY_STATIC", object: 0, dst: 2, stringIndex: 1, icIndex: 1 },
		{ opcode: "BINARY", dst: 3, left: 1, right: 2, operator: "+" },
		{ opcode: "CREATE_NUMBER", dst: 4, value: 2 },
		{ opcode: "CREATE_NUMBER", dst: 5, value: 3 },
		{ opcode: "BINARY", dst: 6, left: 4, right: 5, operator: "*" },
		{ opcode: "BINARY", dst: 7, left: 6, right: 4, operator: "+" },
		{ opcode: "THROW_IF_TDZ", src: 7, nameStringIndex: 0 },
		{ opcode: "RETURN", value: 7 },
	];
	const reps: Array<VmRegisterRepresentation> = [
		"boxed",
		"boxed",
		"boxed",
		"boxed",
		"number",
		"number",
		"number",
		"number",
	];
	const body = {
		...template,
		parameterCount: 1,
		registerCount: reps.length,
		instructions,
		positions: instructions.map(() => -1),
		gcSafepoints: undefined,
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	return lowerNativeFunctionStorage({
		...native,
		storageValues: reps.map((_, index) => index),
		registerRepresentations: reps,
		gc: {
			safepoints: [
				...native.gc.safepoints
					.filter((point) => poll || point.instructionIp !== 1)
					.map((point) => ({
						...point,
						rootRegisters: [0, 1, 2, 3],
						incomingRootRegisters: [0, 1, 2, 3],
						outgoingRootRegisters: [0, 1, 2, 3],
					})),
			],
		},
	});
}

describe("persisted native numeric property projections", () => {
	it.each([2, 3, 4])(
		"round-trips %i-load plans and their helper/fallback ABI",
		(count) => {
			const keys = ["left", "right", "kind", "tag"].slice(0, count);
			const image = compile(keys.map((key) => `value.${key}`).join(" + "));
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			const fn = restored.native.functions[1]!;
			const plan = fn.storage!.propertyProjections[0]!;
			expect(plan.loads).toHaveLength(count);
			expect(plan.fallback).toBe("original-instructions");
			expect(fn.storage!.propertyProjections).toEqual(
				image.native.functions[1]!.storage!.propertyProjections,
			);
			expect(fn.body).toEqual(image.native.functions[1]!.body);
			expect(fn.gc).toEqual(image.native.functions[1]!.gc);
			const helper = count === 2 ? "pair" : count === 3 ? "triple" : "quad";
			const emitted = emitCompiledFunction(fn, 1, "", false)!;
			expect(emitted.source).toContain(
				`mal_vm_property_try_load_static_number_${helper}(`,
			);
			expect(emitted.source).toContain("mal_vm_op_load_property_ic_static_miss(");
		},
	);

	it("composes unclaimed scalar expressions and TDZ omissions without borrowing their outputs", () => {
		const fn = scalarContract();
		const plan = fn.storage!.propertyProjections[0]!;
		expect(plan).toBeDefined();
		expect(fn.storage!.expressionIps).toContain(6);
		expect(fn.storage!.elidedTdzIps).toContain(8);
		expect(plan.borrowedRegisters).not.toContain(6);
		for (const ip of fn.storage!.expressionIps) expect(plan.claimedIps).not.toContain(ip);
		for (const local of plan.borrowedRegisters)
			expect(fn.storage!.privateRegisters).not.toContain(local);
		const emitted = emitCompiledFunction(fn, 0, "", false)!;
		expect(emitted.source).toContain("mal_vm_property_try_load_static_number_pair(");
		expect(emitted.source).not.toContain("mal_vm_op_throw_if_tdz");
	});

	it("does not carry unmaterialized projection outputs across an adjacent polling jump", () => {
		expect(scalarContract().storage!.propertyProjections).toHaveLength(1);
		expect(scalarContract(true).storage!.propertyProjections).toEqual([]);
	});

	it("retains projection decisions and execution events in profiled native bodies", () => {
		const original = compile().native.functions[1]!;
		const fn = lowerNativeFunctionStorage({
			...original,
			body: {
				...original.body,
				profileSiteIds: original.body.instructions.map((_, ip) => 10 + ip),
			},
		});
		expect(fn.storage!.propertyProjections).toHaveLength(1);
		expect(fn.storage!.expressionIps).toEqual([]);
		const emitted = emitCompiledFunction(fn, 1, "", true)!;
		for (const ip of fn.storage!.propertyProjections[0]!.claimedIps) {
			expect(emitted.emittedInstructions.has(ip)).toBe(true);
			expect(emitted.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${fn.body.profileSiteIds![ip]}, MAL_PROFILE_SITE_EXECUTION, 1)`,
			);
		}
	});

	it("rejects forged operands, ownership, caches and fallback contracts at serialization", () => {
		const image = compile();
		const fn = image.native.functions[1]!;
		const plan = fn.storage!.propertyProjections[0]!;
		const cases = [
			{ ...plan, loads: plan.loads.with(0, { ...plan.loads[0]!, icIndex: 999 }) },
			{
				...plan,
				steps: plan.steps.with(0, {
					...plan.steps[0]!,
					left: { kind: "load" as const, index: 999 },
				}),
			},
			{ ...plan, claimedIps: [...plan.claimedIps, plan.claimedIps[0]!] },
			{ ...plan, borrowedRegisters: [] },
			{ ...plan, fallback: "retry" as "original-instructions" },
		];
		for (const forged of cases)
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...fn,
							storage: { ...fn.storage!, propertyProjections: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it("rejects stale bodies and cross-entry projection reuse", () => {
		const fn = scalarContract();
		const changed: NativeFunctionPlan = {
			...fn,
			body: {
				...fn.body,
				instructions: fn.body.instructions.with(3, {
					opcode: "BINARY",
					dst: 3,
					left: 1,
					right: 2,
					operator: "in",
				}),
			},
		};
		expect(() => validateNativeStorage(changed)).toThrow(/invalid or stale storage plan/);
		const entry = {
			id: 0,
			parameterRepresentations: ["boxed" as const],
			resultRepresentation: "number" as const,
			registerRepresentations: fn.registerRepresentations.with(1, "number"),
			gc: {
				safepoints: fn.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter((local) => local !== 1),
					incomingRootRegisters: point.incomingRootRegisters.filter(
						(local) => local !== 1,
					),
					outgoingRootRegisters: point.outgoingRootRegisters.filter(
						(local) => local !== 1,
					),
				})),
			},
		};
		const lowered = lowerNativeFunctionStorage({ ...fn, directEntries: [entry] });
		expect(lowered.storage!.propertyProjections).toHaveLength(1);
		expect(lowered.directEntries[0]!.storage!.propertyProjections).toEqual([]);
		expect(() =>
			validateNativeStorage({
				...lowered,
				directEntries: [{ ...lowered.directEntries[0]!, storage: lowered.storage }],
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
