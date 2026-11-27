import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN } from "../../../../src/test-harness.ts";

const examples = path.join(import.meta.dirname, "../examples");
const outDir = mkdtempSync(path.join(tmpdir(), "maligator-lint-examples-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Each example's driver runs this many rounds. A path taken on a quarter of them
// is per-round work; the runtime's own startup takes it only a few times.
const ROUNDS = 10_000;

interface ShapeEvidence {
	stdout: string;
	/** Property loads whose site met a shape other than its cached one. */
	shapeMisses: number;
}

function counter(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=(\\d+)`))?.[1] ?? 0);
}

function run(file: string): ShapeEvidence {
	const binary = buildNativeBinary({
		fixture: path.relative(process.cwd(), file),
		name: path.basename(file, ".js"),
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

const pairs = readdirSync(examples).flatMap((rule) =>
	readdirSync(path.join(examples, rule))
		.filter((file) => file.endsWith(".bad.js"))
		.map((file) => ({ rule, example: file.replace(/\.bad\.js$/u, "") })),
);

describe("documented examples compiled by Maligator", () => {
	it.each(pairs)(
		"$rule $example: readers of the bad form miss their shape cache, the good form's do not",
		({ rule, example }) => {
			const directory = path.join(examples, rule);
			const expected = execFileSync(
				process.execPath,
				[path.join(directory, `${example}.good.js`)],
				{ encoding: "utf8" },
			);
			const bad = run(path.join(directory, `${example}.bad.js`));
			const good = run(path.join(directory, `${example}.good.js`));
			expect(bad.stdout).toBe(expected);
			expect(good.stdout).toBe(expected);
			expect(bad.shapeMisses).toBeGreaterThanOrEqual(ROUNDS / 4);
			expect(good.shapeMisses).toBeLessThan(ROUNDS / 100);
		},
	);
});
