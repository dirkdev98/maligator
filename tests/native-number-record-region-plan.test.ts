import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { NativeNumberRecordRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.step = function step(record, scale) { ${body} };`,
			"/number-record-plan.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
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
	it("retains read-only record fields through a numeric reduction", () => {
		const image = compile("return record.x + record.y + record.z + record.w + record.v;");
		const [plan] = regions(image);
		expect(fieldNames(image, plan!)).toEqual(["x", "y", "z", "w", "v"]);
		expect(plan!.outputs).toHaveLength(1);
		expect(
			regions(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(regions(image));
	});

	it.each([24, 32, 40])("selects bounded prefixes from %i numeric fields", (count) => {
		const image = compile(
			`return ${Array.from({ length: count }, (_, i) => `record.f${i}`).join("+")};`,
		);
		const plans = regions(image);
		expect(plans.length).toBeGreaterThan(0);
		expect(plans[0]!.fields).toHaveLength(Math.min(count, 32));
		for (const plan of plans) {
			expect(plan.fields.length).toBeLessThanOrEqual(32);
			expect(plan.claimedIps.length).toBeLessThanOrEqual(128);
		}
		expect(
			regions(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(plans);
		expect(emitCompiledFunction(image.native.functions[1]!, 1, "", false)).not.toBeNull();
	});

	it("keeps a larger field update within one numeric region", () => {
		const image = compile(
			Array.from(
				{ length: 24 },
				(_, i) => `record.f${i} = (record.f${i} + scale) * scale - scale;`,
			).join(""),
		);
		const [plan] = regions(image);
		expect(plan!.fields).toHaveLength(24);
		expect(plan!.claimedIps.length).toBeGreaterThan(96);
	});

	it("carries Math results through both sides of a read-only branch", () => {
		const image = compile(
			"let value; if(record.x < record.y) value=Math.hypot(record.x,record.y,record.z,record.w); else value=Math.max(record.x,record.y,record.z,record.w); return value;",
			"locked",
		);
		const [plan] = regions(image);
		expect(plan!.fields.every((field) => !field.stored)).toBe(true);
		expect(image.native.functions[1]!.body.instructions[plan!.exitIp]!.opcode).toBe(
			"RETURN",
		);
		expect(
			regions(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(regions(image));
	});

	it("does not speculate numeric fields solely to copy values", () => {
		expect(regions(compile("return [record.x,record.y,record.z,record.w];"))).toEqual([]);
	});

	it.each([
		"Math.abs(record.x)",
		"Math.round(record.x)",
		"Math.f16round(record.x)",
		"Math.imul(record.x, scale)",
		"Math.pow(record.x, scale)",
		"Math.atan2(record.x, scale)",
		"Math.min(record.x, scale, 9)",
		"Math.max(record.x, scale, -9)",
		"Math.hypot(record.x, scale, record.y)",
		"Math.imul(record.x)",
		"record.x + Math.min()",
	])("retains field state through proven %s", (expression) => {
		const image = compile(
			`record.x = ${expression}; record.y = record.x + record.y; return record.y;`,
			"locked",
		);
		const [plan] = regions(image);
		expect(plan).toBeDefined();
		expect(fieldNames(image, plan!)).toEqual(["x=", "y="]);
		expect(image.native.functions[1]!.body.instructions[plan!.exitIp]!.opcode).toBe(
			"RETURN",
		);
		expect(
			regions(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(regions(image));
		expect(emitCompiledFunction(image.native.functions[1]!, 1, "", false)).not.toBeNull();
	});

	it("keeps a Math load between field updates inside one region", () => {
		const image = compile(
			"record.vy = record.vy + 0.01 * record.mass; record.x = Math.round(record.x + record.vy); return record.x - record.vy;",
			"locked",
		);
		const plans = regions(image);
		expect(plans).toHaveLength(1);
		expect(fieldNames(image, plans[0]!)).toEqual(["vy=", "mass", "x="]);
		const fn = image.native.functions[1]!;
		expect(
			plans[0]!.claimedIps.some(
				(ip) => fn.body.instructions[ip]!.opcode === "LOAD_INTRINSIC",
			),
		).toBe(true);
		expect(fn.body.instructions[plans[0]!.exitIp]!.opcode).toBe("RETURN");
		expect(emitCompiledFunction(fn, 1, "", false)).not.toBeNull();
	});

	it("guards a dynamic Math operand before changing any fields", () => {
		const [plan] = regions(
			compile(
				"record.x = Math.max(record.x, scale); record.y = record.x + record.y;",
				"locked",
			),
		);
		expect(plan!.inputs).toHaveLength(1);
	});

	it("keeps receiver coercion outside a numeric record region", () => {
		const image = compile(
			"record.x = Math.max(record.x, record); record.y = record.x + record.y;",
			"locked",
		);
		for (const plan of regions(image))
			expect(
				plan.claimedIps.every(
					(ip) =>
						image.native.functions[1]!.body.instructions[ip]!.opcode !== "CALL_KNOWN",
				),
			).toBe(true);
	});

	it("preserves mutable Math lookup and ignored argument effects", () => {
		for (const [body, primordials] of [
			["record.x = Math.abs(record.x); record.y = record.x + record.y;", "mutable"],
			[
				"record.x = Math.abs(record.x, scale()); record.y = record.x + record.y;",
				"locked",
			],
		] as const) {
			const image = compile(body, primordials);
			for (const plan of regions(image))
				expect(fieldNames(image, plan)).not.toContain("x=");
		}
	});

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

	it("admits a loop body once per iteration without claiming the back edge", () => {
		const image = compile(`
			for (let i = 0; i < 4; i++) record.a = record.a + record.b;
			return record.a;
		`);
		const backEdges = image.native.functions[1]!.body.instructions.flatMap(
			(instruction, ip) =>
				(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
				instruction.targetIp <= ip
					? [{ ip, target: instruction.targetIp }]
					: [],
		);
		expect(backEdges.length).toBeGreaterThan(0);
		const [plan] = regions(image);
		expect(fieldNames(image, plan!)).toEqual(["a=", "b"]);
		for (const { ip, target } of backEdges) {
			expect(plan!.claimedIps).not.toContain(ip);
			expect(plan!.claimedIps).not.toContain(target);
		}
	});

	it("keeps two-field reads outside a loop on the projected path", () => {
		expect(regions(compile("return record.a * 2 + record.b;"))).toEqual([]);
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

	it("keeps naming its fields when merged behind another program", () => {
		const image = compile(PARTICLE);
		const merged = mergeProgramImages([compile("return record.other;"), image]);
		const index = merged.functionBases[1]! + 1;
		const [plan] = merged.image.native.functions[index]!.storage!.numberRecordRegions;
		expect(fieldNames(merged.image, plan!)).toEqual(["vy=", "mass", "x=", "vx"]);
		expect(() =>
			validateNativeProgramStorage(
				merged.image.native,
				merged.image.runtime.stringConstants,
			),
		).not.toThrow();
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
