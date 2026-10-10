import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { NativeIntegerLoopRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.step = function step(start, limit) { ${body} };`,
			"/integer-loop-plan.js",
		),
	);
}

const COLLATZ = `
	let steps = 0;
	let value = start;
	while (value > 1) {
		value = (value & 1) === 0 ? value / 2 : value * 3 + 1;
		steps++;
	}
	return steps;
`;

function regions(image: ProgramImage): ReadonlyArray<NativeIntegerLoopRegionPlan> {
	return image.native.functions[1]!.storage!.integerLoopRegions;
}

describe("native safe-integer loop regions", () => {
	it("restores the loop-carried values and continues at the loop exit", () => {
		const image = compile(COLLATZ);
		const [plan] = regions(image);
		const fn = image.native.functions[1]!;
		expect(fn.body.instructions[plan!.entryIp]).toEqual({
			opcode: "JUMP",
			targetIp: plan!.id,
		});
		expect(plan!.carried.length).toBe(2);
		expect(plan!.exits).toHaveLength(1);
		expect(plan!.exits[0]!.outputs).toHaveLength(1);
	});

	it("leaves a loop that calls out to the double path", () => {
		const image = compile(`
			let value = start;
			while (value > 1) value = limit(value & 7);
			return value;
		`);
		expect(regions(image)).toEqual([]);
	});

	it("leaves additions and comparisons to the double path", () => {
		const image = compile(`
			let total = 0;
			for (let index = 0; index < limit; index++) total = total + index;
			return total;
		`);
		expect(regions(image)).toEqual([]);
	});

	it("admits only the innermost loop of a nest", () => {
		const image = compile(`
			let hits = 0;
			for (let value = 2; value < limit; value++)
				for (let divisor = 2; divisor * divisor <= value; divisor++)
					if (value % divisor === 0) hits++;
			return hits;
		`);
		const fn = image.native.functions[1]!;
		const [plan] = regions(image);
		expect(regions(image)).toHaveLength(1);
		expect(
			plan!.claimedIps.some(
				(ip) =>
					fn.body.instructions[ip]!.opcode === "BINARY" &&
					(fn.body.instructions[ip] as { operator: string }).operator === "%",
			),
		).toBe(true);
	});

	it("round-trips without replaying loop selection", () => {
		const image = compile(COLLATZ);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(regions(restored)).toEqual(regions(image));
	});

	it("rejects forged entries, restores, and exits at serialization", () => {
		const image = compile(COLLATZ);
		const native = image.native.functions[1]!;
		const plan = regions(image)[0]!;
		for (const forged of [
			{ ...plan, entryIp: plan.entryIp - 1 },
			{ ...plan, carried: plan.carried.slice(1) },
			{ ...plan, inputs: plan.inputs.slice(1) },
			{ ...plan, exits: [{ ...plan.exits[0]!, targetIp: plan.exits[0]!.targetIp + 1 }] },
			{ ...plan, exits: [{ ...plan.exits[0]!, outputs: [] }] },
			{ ...plan, claimedIps: plan.claimedIps.slice(1) },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, integerLoopRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
