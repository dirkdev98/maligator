import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import {
	lowerVerifiedTargetsToRuntimePlans,
	vmInstructionUsesPropertyCache,
} from "../src/compiler/target/runtime-image.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";

function semanticProgram() {
	return analyzeSourceAndRunSemanticAnalysis(
		`function cacheBranches(flag, input) {
		const object = { left: input, right: input + 1, callable: value => value + 2 };
		globalThis.object = object;
		let value;
		if (flag) {
			value = object.left;
			if (input) value += object.right;
		} else value = object.right;
		return object.callable(value);
	}
	globalThis.keep = cacheBranches;`,
		"native-property-cache-layout.js",
	);
}

function sites(fn: BytecodeFunction) {
	return fn.instructions.filter(vmInstructionUsesPropertyCache);
}

describe("shared property caches across independent target layouts", () => {
	it("keeps semantic cache identities through reordered branches and both serialized products", () => {
		const image = compileSemanticProgramToProgramImage(semanticProgram());
		const functionIndex = image.native.functions.findIndex(
			(fn) => sites(fn.body).length === 5,
		);
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const portable = image.runtime.functions[functionIndex]!;
		const native = image.native.functions[functionIndex]!.body;
		expect(sites(native).map((site) => site.icIndex)).not.toEqual(
			sites(portable).map((site) => site.icIndex),
		);
		for (const site of sites(native)) {
			const canonical = sites(portable).find((other) => other.icIndex === site.icIndex)!;
			expect(canonical.opcode).toBe(site.opcode);
			if ("stringIndex" in site && "stringIndex" in canonical)
				expect(canonical.stringIndex).toBe(site.stringIndex);
		}
		expect(native.propertyIcCount).toBe(portable.propertyIcCount);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(sites(restored.native.functions[functionIndex]!.body)).toEqual(sites(native));
		expect(sites(restored.runtime.functions[functionIndex]!)).toEqual(sites(portable));
		expect(
			sites(
				deserializeRuntimeImage(serializeRuntimeImage(image.runtime)).functions[
					functionIndex
				]!,
			),
		).toEqual(sites(portable));
	});

	it("rejects swapped cache meanings, duplicate identities and out-of-range identities", () => {
		const image = compileSemanticProgramToProgramImage(semanticProgram());
		const functionIndex = image.native.functions.findIndex(
			(fn) => sites(fn.body).length === 5,
		);
		const fn = image.native.functions[functionIndex]!;
		const reads = sites(fn.body).filter(
			(site) => "stringIndex" in site && site.opcode.startsWith("LOAD_"),
		);
		const left = reads[0]!;
		const right = reads.find(
			(site) =>
				"stringIndex" in site &&
				"stringIndex" in left &&
				site.stringIndex !== left.stringIndex,
		)!;
		for (const kind of ["swap", "duplicate", "range"] as const) {
			const malformed = {
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(functionIndex, {
						...fn,
						body: {
							...fn.body,
							instructions: fn.body.instructions.map((instruction) =>
								instruction === left
									? {
											...instruction,
											icIndex: kind === "range" ? fn.body.propertyIcCount : right.icIndex,
										}
									: kind === "swap" && instruction === right
										? { ...instruction, icIndex: left.icIndex }
										: instruction,
							),
						},
					}),
				},
			};
			expect(() => serializeCompilerArtifact(malformed)).toThrow(
				kind === "swap"
					? /incompatible property cache identities/
					: /invalid property IC index/,
			);
		}
	});

	it("retains shared capacity when one target has reserved cache slots", () => {
		const image = compileSemanticProgramToProgramImage(semanticProgram());
		const functionIndex = image.native.functions.findIndex(
			(fn) => sites(fn.body).length === 5,
		);
		const fn = image.native.functions[functionIndex]!;
		const site = sites(fn.body)[0]!;
		const reserved = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.with(functionIndex, {
					...fn,
					body: {
						...fn.body,
						propertyIcCount: fn.body.propertyIcCount + 1,
						instructions: fn.body.instructions.map((instruction) =>
							instruction === site
								? { ...instruction, icIndex: fn.body.propertyIcCount }
								: instruction,
						),
					},
				}),
			},
		};
		expect(() => serializeCompilerArtifact(reserved)).toThrow(
			/incompatible propertyIcCount/,
		);
		const shared = {
			...reserved,
			runtime: {
				...reserved.runtime,
				functions: reserved.runtime.functions.with(functionIndex, {
					...reserved.runtime.functions[functionIndex]!,
					propertyIcCount: fn.body.propertyIcCount + 1,
				}),
			},
		};
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(shared));
		expect(restored.native.functions[functionIndex]!.body.propertyIcCount).toBe(
			fn.body.propertyIcCount + 1,
		);
	});

	it("assigns cache identities independently of GC operation anchors", () => {
		const core = optimizeSemanticProgramToCore(semanticProgram(), {}, (_phase, run) =>
			run(),
		);
		const targets = [
			lowerCoreCompilationToNativeProgram(core),
			lowerCoreCompilationToExecutionProgram(core),
		].map((target) => ({
			...target,
			functions: target.functions.map((fn) => {
				const cached = new Set(fn.propertyCacheOrigins.map((site) => site.instruction));
				return {
					...fn,
					gc: {
						...fn.gc,
						safepoints: fn.gc.safepoints.filter(
							(point) => !cached.has(point.instruction),
						),
					},
				};
			}),
		}));
		const plans = lowerVerifiedTargetsToRuntimePlans(targets);
		expect(plans.every((plan) => plan.functions[1]!.bytecode.propertyIcCount === 5)).toBe(
			true,
		);
	});
});
