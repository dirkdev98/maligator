import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/generator-fusion.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-generator-fusion-native-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function iterates(image: ProgramImage["runtime"], name: string): boolean {
	const fn = image.functions.find(
		(candidate) =>
			String.fromCharCode(...(image.stringConstants[candidate.nameStringIndex] ?? [])) ===
			name,
	);
	expect(fn, name).toBeDefined();
	return fn!.instructions.some((instruction) => instruction.opcode === "GET_ITERATOR");
}

describe.each([
	{ primordials: "locked" as const, title: "private generator traversal" },
	{
		primordials: "mutable" as const,
		title: "private generator traversal behind a protocol guard",
	},
])("$title", ({ primordials }) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: Record<string, unknown>;
	beforeAll(() => {
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `generator-fusion-${primordials}`,
			outDir,
			config: resolveBuildConfig({ engine: { primordials } }),
		});
	});
	it.each([
		{
			scenario: "traversal",
			behavior: "preserves repeated traversal, continue and break",
		},
		{ scenario: "sentValues", behavior: "resumes ordinary iteration with undefined" },
		{
			scenario: "exceptions",
			behavior: "propagates generator exceptions to the enclosing handler",
		},
		{
			scenario: "consumerExceptions",
			behavior: "preserves consumer exceptions during iteration",
		},
		{
			scenario: "consumerAllocation",
			behavior: "retains suspended state across allocating consumer calls",
		},
		{ scenario: "specialNumbers", behavior: "preserves signed zero, NaN and infinities" },
		{
			scenario: "earlyCompletion",
			behavior: "preserves initialization skipped by early completion",
		},
		{
			scenario: "prototypeObservation",
			behavior: "observes prototype mutation through another invocation",
		},
		{ scenario: "closing", behavior: "runs generator cleanup on early exit" },
		{ scenario: "coercion", behavior: "preserves argument coercion order" },
	])("$behavior", ({ scenario }) => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(
				(JSON.parse(runToStdout(binary)) as Record<string, unknown>)[scenario],
			).toEqual(expected[scenario]);
	});
	it("preserves traversal and fallback state through collection", () => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(JSON.parse(runToStdout(binary, { env: STRESS_ENV }))).toEqual(expected);
	});
});

describe("private iteration in CommonJS modules", () => {
	const entry = "tests/local/generator-fusion-cjs/main.cjs";
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [entry], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture: entry,
			name: "generator-fusion-cjs",
			outDir,
			config: resolveBuildConfig({}),
		});
	});
	it("fuses generators and lowers rest loops that only their own module calls", () => {
		for (const name of ["sumSequences", "sumPrivateSteps", "privateTotal"])
			expect(iterates(pair.programImage.runtime, name), name).toBe(false);
	});
	it("keeps the protocol for an exported generator that another module drives and patches", () => {
		expect(iterates(pair.programImage.runtime, "sumCounts")).toBe(true);
	});
	it("matches Node", () => {
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});

/**
 * A program with hundreds of unrelated functions, consumers with several generator
 * loops, a generator in a `const` binding that a call reads in its dead zone, a
 * generator one of the unrelated functions publishes, and one published after the
 * loops ran.
 */
function scaleFixture(fillers: number): string {
	const escapeAt = fillers >> 1;
	return `"use strict";
function* sequence(seed) {
	for (let index = 0; index < 12; index++) yield (seed + index * 7) & 255;
}
function* leaked(seed) {
	for (let index = 0; index < 6; index++) yield seed * 3 + index;
}
function* published(seed) {
	for (let index = 0; index < 6; index++) yield seed - index;
}
function threeLoops(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const value of sequence(round)) checksum += value;
		for (const value of sequence(round + 1)) {
			if (value & 1) continue;
			checksum ^= value;
		}
		for (const value of sequence(round + 2)) {
			checksum += value * 3;
			if (value > 200) break;
		}
	}
	return checksum;
}
function fourLoops(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const value of sequence(round)) checksum += value;
		for (const value of sequence(round * 2)) checksum -= value >> 1;
		for (const value of sequence(round + 3)) {
			if (value % 3 === 0) continue;
			checksum += value;
		}
		for (const value of sequence(round + 4)) {
			checksum ^= value << 2;
			if (value < 8) break;
		}
	}
	return checksum;
}
function deadZoneLoops(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of lateSequence(round)) checksum += value;
	return checksum;
}
let deadZone = "none";
try {
	deadZoneLoops(1);
} catch (error) {
	deadZone = error.constructor.name;
}
const lateSequence = function* (seed) {
	for (let index = 0; index < 12; index++) yield seed * 5 - index;
};
function leakedLoops(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of leaked(round)) checksum += value;
	return checksum;
}
function publishedLoops(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of published(round)) checksum += value;
	return checksum;
}
${Array.from(
	{ length: fillers },
	(_, index) => `function filler${index}(value) {
	let state = value ^ ${index};
	for (let step = 0; step < 3; step++) state = (state * 31 + ${index} + step) | 0;
	${index === escapeAt ? "globalThis.leak = leaked;" : ""}
	return state > ${index} ? state - ${index} : state + ${index} * 2;
}`,
).join("\n")}
const fillers = [${Array.from({ length: fillers }, (_, index) => `filler${index}`).join(", ")}];
let mixed = 0;
for (let index = 0; index < fillers.length; index++) mixed = fillers[index](mixed);
const results = {
	threeLoops: threeLoops(2_000),
	fourLoops: fourLoops(2_000),
	deadZone,
	deadZoneLoops: deadZoneLoops(2_000),
	leakedLoops: leakedLoops(400),
	leakedOutside: [...globalThis.leak(2)],
	publishedLoops: publishedLoops(400),
	mixed,
};
Promise.resolve().then(() => {
	globalThis.later = published;
	results.publishedOutside = [...globalThis.later(9)];
	console.log(JSON.stringify(results));
});
`;
}

describe.each(["mjs", "cjs"])(
	"private generator traversal at program scale in .%s",
	(extension) => {
		const entry = join(outDir, `generator-fusion-scale.${extension}`);
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		let expected: string;
		beforeAll(() => {
			writeFileSync(entry, scaleFixture(600));
			expected = execFileSync(process.execPath, [entry], { encoding: "utf8" });
			pair = buildBackendPairFromOneProgramImage({
				fixture: entry,
				name: `generator-fusion-scale-${extension}`,
				outDir,
				config: resolveBuildConfig({}),
			});
		});
		it("fuses every loop of private generators, including one in a binding read in its dead zone", () => {
			for (const name of ["threeLoops", "fourLoops", "deadZoneLoops"])
				expect(iterates(pair.programImage.runtime, name), name).toBe(false);
		});
		it("keeps the protocol for generators published anywhere in the program", () => {
			for (const name of ["leakedLoops", "publishedLoops"])
				expect(iterates(pair.programImage.runtime, name), name).toBe(true);
		});
		it("matches Node", () => {
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		});
	},
);
