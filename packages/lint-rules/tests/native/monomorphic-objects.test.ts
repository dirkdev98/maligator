import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN } from "../../../../src/test-harness.ts";

const examples = path.join(import.meta.dirname, "../examples/monomorphic-objects");
const outDir = mkdtempSync(path.join(tmpdir(), "maligator-monomorphic-objects-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Each example's driver runs this many rounds, so a path taken every round stands
// out from the few times the runtime's own startup takes it.
const ROUNDS = 10_000;

interface ShapeEvidence {
	stdout: string;
	/** Stores that gave an object a new shape after it was created. */
	reshapes: number;
	/** Property loads whose site met a shape other than its cached one. */
	shapeMisses: number;
}

function counter(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=(\\d+)`))?.[1] ?? 0);
}

function run(example: string): ShapeEvidence {
	const binary = buildNativeBinary({
		fixture: path.relative(process.cwd(), path.join(examples, example)),
		name: example.replace(/\.js$/u, ""),
		mainFile: HOST_MAIN,
		outDir,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	const line = result.stderr
		.split("\n")
		.find((entry) => entry.startsWith("[perf-ic-stats]"));
	expect(line, result.stderr).toBeDefined();
	return {
		stdout: result.stdout,
		reshapes:
			counter(line!, "store_transition_hits") + counter(line!, "store_transition_fills"),
		shapeMisses: [
			"load_slot_key_hits",
			"load_poly_hits",
			"load_mega_hits",
			"load_mega_misses",
		]
			.map((name) => counter(line!, name))
			.reduce((total, count) => total + count, 0),
	};
}

describe("monomorphic-objects examples", () => {
	const pairs = readdirSync(examples)
		.filter((file) => file.endsWith(".bad.js"))
		.map((file) => file.replace(/\.bad\.js$/u, ""));

	it.each(pairs)("%s: the bad form reshapes objects that the good form keeps", (pair) => {
		const expected = execFileSync(
			process.execPath,
			[path.join(examples, `${pair}.good.js`)],
			{
				encoding: "utf8",
			},
		);
		const bad = run(`${pair}.bad.js`);
		const good = run(`${pair}.good.js`);
		expect(bad.stdout).toBe(expected);
		expect(good.stdout).toBe(expected);
		expect(bad.reshapes).toBeGreaterThanOrEqual(ROUNDS / 2);
		expect(bad.shapeMisses).toBeGreaterThanOrEqual(ROUNDS / 2);
		expect(good.reshapes).toBeLessThan(ROUNDS / 100);
		expect(good.shapeMisses).toBeLessThan(ROUNDS / 100);
	});
});
