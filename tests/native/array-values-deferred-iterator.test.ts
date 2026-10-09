import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-values-deferred-iterator-"));

function counter(line: string, name: string): number {
	const match = new RegExp(`\\b${name}=(\\d+)`).exec(line);
	if (match === null) throw new Error(`missing ${name} in ${line}`);
	return Number(match[1]);
}

describe("array for-of without an allocated iterator", () => {
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-values-deferred-iterator.js",
			name: "array-values-deferred-iterator",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("defers array iterators until a close can observe one", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertResultPass(result.stdout);
		const line =
			result.stderr
				.split("\n")
				.find((candidate) => candidate.startsWith("[perf-map-stats]")) ?? "";
		expect(counter(line, "deferred_array_iterators")).toBeGreaterThanOrEqual(2000);
		expect(counter(line, "deferred_array_materializations")).toBe(1);
	});

	it("preserves semantics under compiled GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("preserves interpreted semantics", () => {
		assertResultPass(runToStdout(interpreted));
	});
});
