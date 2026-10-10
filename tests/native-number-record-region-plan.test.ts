import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { NativeNumberRecordRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.step = function step(record, scale) { ${body} };`,
			"/number-record-plan.js",
		),
	);
}

const PARTICLE = `
	record.vy += 0.01 * record.mass;
	record.x += record.vx;
	if (record.x > 100) record.x = record.x % 7;
	return record.x - record.vy;
`;

function regions(image: ProgramImage): ReadonlyArray<NativeNumberRecordRegionPlan> {
	return image.native.functions[1]!.storage!.numberRecordRegions;
}

function fieldNames(image: ProgramImage, plan: NativeNumberRecordRegionPlan) {
	return plan.fields.map(
		(field) =>
			`${String.fromCharCode(...image.runtime.stringConstants[field.stringIndex]!)}${field.stored ? "=" : ""}`,
	);
}

describe("native number record regions", () => {
	it("admits a branching update through to the return and materializes its result", () => {
		const image = compile(PARTICLE);
		const [plan] = regions(image);
		expect(fieldNames(image, plan!)).toEqual(["vy=", "mass", "x=", "vx"]);
		const fn = image.native.functions[1]!;
		expect(fn.body.instructions[plan!.exitIp]!.opcode).toBe("RETURN");
		expect(plan!.outputs).toHaveLength(1);
		expect(emitCompiledFunction(fn, 1, "", false)!.source).toContain(
			`goto L${plan!.exitIp};`,
		);
	});

	it("ends before an operation that can run JavaScript", () => {
		const image = compile(`
			record.a = record.a + 1;
			record.b = record.b * 2;
			record.c = record.a + record.b;
			scale();
			record.d = record.c - 1;
		`);
		const [plan] = regions(image);
		expect(fieldNames(image, plan!)).toEqual(["a=", "b=", "c="]);
		expect(image.native.functions[1]!.body.instructions[plan!.exitIp]!.opcode).not.toBe(
			"STORE_PROPERTY_STATIC",
		);
	});

	it("leaves a loop that revisits the record to the generic path", () => {
		const image = compile(`
			for (let i = 0; i < 4; i++) record.a = record.a + record.b;
			return record.a;
		`);
		expect(regions(image)).toEqual([]);
	});

	it("admits a numeric scale as a guarded input", () => {
		const image = compile(`
			record.a = record.a * scale;
			record.b = record.b * scale;
		`);
		const [plan] = regions(image);
		expect(plan!.inputs).toHaveLength(1);
		expect(plan!.outputs).toEqual([]);
	});

	it("round-trips without replaying admission selection", () => {
		const image = compile(PARTICLE);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(regions(restored)).toEqual(regions(image));
	});

	it("rejects forged guards, outputs, and exits at serialization", () => {
		const image = compile(PARTICLE);
		const native = image.native.functions[1]!;
		const plan = regions(image)[0]!;
		for (const forged of [
			{ ...plan, exitIp: plan.exitIp - 1 },
			{ ...plan, fields: plan.fields.with(0, { ...plan.fields[0]!, stored: false }) },
			{ ...plan, fields: plan.fields.with(1, { ...plan.fields[1]!, icIndex: 999 }) },
			{ ...plan, outputs: [] },
			{ ...plan, inputs: [...plan.inputs, plan.object] },
			{ ...plan, claimedIps: plan.claimedIps.slice(1) },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, numberRecordRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
