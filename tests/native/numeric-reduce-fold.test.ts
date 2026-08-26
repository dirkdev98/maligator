import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-reduce-fold-"));

function run(binary: string, tag: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, tag);
	return result.stdout;
}

describe("native numeric reduce fold", () => {
	let compiled: string;
	let interpreted: string;
	let counts: string;
	let countsInterpreted: string;
	let closed: string;
	let closedInterpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold.js",
			name: "numeric-reduce-fold",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold.js",
			name: "numeric-reduce-fold-ni",
			compiled: false,
			outDir,
		});
		counts = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold-counts.js",
			name: "numeric-reduce-fold-counts",
			compiled: true,
			outDir,
		});
		countsInterpreted = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold-counts.js",
			name: "numeric-reduce-fold-counts-ni",
			compiled: false,
			outDir,
		});
		closed = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-closed.js",
			name: "numeric-reduce-closed",
			compiled: true,
			outDir,
		});
		closedInterpreted = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-closed.js",
			name: "numeric-reduce-closed-ni",
			compiled: false,
			outDir,
		});
	});

	it("produces bit-identical results on both backends", () => {
		const compiledOut = run(compiled, "numeric-reduce-fold");
		const interpretedOut = run(interpreted, "numeric-reduce-fold");
		expect(compiledOut).toBe(interpretedOut);
	});

	it("keeps folding correct under stress collection", () => {
		const stdout = run(counts, "numeric-reduce-fold-counts", STRESS_ENV);
		expect(stdout).toBe(run(countsInterpreted, "numeric-reduce-fold-counts", STRESS_ENV));
	});

	it("preserves closed fresh-array semantics on both backends", () => {
		const compiledOut = run(closed, "numeric-reduce-closed");
		expect(compiledOut).toBe(run(closedInterpreted, "numeric-reduce-closed"));
	});
});
