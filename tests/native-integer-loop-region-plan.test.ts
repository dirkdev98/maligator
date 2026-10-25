import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { NativeNumericLoopRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import { numericLoopShape } from "../src/compiler/target/lower-native-fast-paths.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(body: string, profile = false) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.step = function step(start, limit) { ${body} };`,
			"/integer-loop-plan.js",
		),
		{ profile },
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

function regions(image: ProgramImage): ReadonlyArray<NativeNumericLoopRegionPlan> {
	return image.native.functions[1]!.storage!.numericLoopRegions;
}

describe("native safe-integer loop regions", () => {
	it.each([false, true])(
		"preserves contained fusion admission and profile boundaries with profiling %s",
		(profile) => {
			const original = compile(
				`let value=start;for(let i=0;i<limit;i++)value=(value+1)|0;return value;`,
				profile,
			);
			for (const image of [
				original,
				deserializeCompilerArtifact(serializeCompilerArtifact(original)),
			]) {
				const native = image.native.functions[1]!;
				const fusion = native.specializations.find((r) => r.kind === "numeric-fusion");
				expect(fusion).toBeDefined();
				const selected = native.storage!.numericLoopRegions;
				expect(selected).toHaveLength(profile ? 0 : 1);
				if (profile || fusion?.kind !== "numeric-fusion") continue;
				for (const pair of fusion.pairs) {
					expect(selected[0]!.claimedIps).toContain(pair.firstIp);
					expect(selected[0]!.claimedIps).toContain(pair.finishIp);
				}
			}
		},
	);

	it("preserves terminating and cyclic outside paths when proving the loop entry", () => {
		const body = compile(COLLATZ).native.functions[1]!.body;
		for (const terminal of [
			{ opcode: "RETURN", value: 0 },
			{ opcode: "THROW", value: 0 },
			{ opcode: "JUMP", targetIp: 2 },
		] satisfies Array<BytecodeInstruction>) {
			const fn = {
				...body,
				instructions: [
					{ opcode: "JUMP_IF", cond: 2, targetIp: 2 },
					{ opcode: "JUMP", targetIp: 3 },
					terminal,
					{ opcode: "BINARY", operator: "<", left: 0, right: 1, dst: 2 },
					{ opcode: "JUMP_IF", cond: 2, targetIp: 6 },
					{ opcode: "RETURN", value: 0 },
					{ opcode: "BINARY", operator: "%", left: 0, right: 1, dst: 0 },
					{ opcode: "JUMP", targetIp: 3 },
				] satisfies Array<BytecodeInstruction>,
			};
			const facts = analyzeNativeBodyFacts(fn);
			const shape = numericLoopShape(fn, facts, 3);
			expect(shape?.entryIp).toBe(1);
			expect(shape?.order).toEqual([3, 4, 6, 7]);
			expect(
				numericLoopShape(fn, { ...facts, externalEntries: new Set([6]) }, 3),
			).toBeUndefined();
			const bypass = {
				...fn,
				instructions: fn.instructions.with(2, { opcode: "JUMP", targetIp: 6 }),
			};
			expect(numericLoopShape(bypass, analyzeNativeBodyFacts(bypass), 3)).toBeUndefined();
			const unreachable = {
				...bypass,
				instructions: bypass.instructions.with(0, { opcode: "JUMP", targetIp: 3 }),
			};
			expect(
				numericLoopShape(unreachable, analyzeNativeBodyFacts(unreachable), 3),
			).toBeUndefined();
		}
	});

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
							storage: { ...native.storage!, numericLoopRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
