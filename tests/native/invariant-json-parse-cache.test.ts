import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-invariant-json-parse-cache-"));

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "invariant-json-parse-cache");
	return result.stderr;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-invariant-json-parse-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("activation-local invariant JSON.parse templates", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;
	let realms: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/invariant-json-parse-cache.js",
			name: "invariant-json-parse-cache",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/invariant-json-parse-cache.js",
			name: "invariant-json-parse-cache-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/invariant-json-parse-cache.js",
			name: "invariant-json-parse-cache-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/invariant-json-parse-cache.js",
			name: "invariant-json-parse-cache-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		realms = buildNativeBinary({
			fixture: "tests/local/invariant-json-parse-cache.js",
			name: "invariant-json-parse-cache-realms",
			compiled: true,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
	});

	it("preserves fresh identities, mutation isolation, and patched parse semantics", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps the private template rooted under stress and concurrent collection", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
		run(concurrent, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("rejects a foreign Realm JSON.parse without changing result prototypes", () => {
		run(realms, { MAL_TEST262: "1" });
	});

	it("reports exact activation-local fill and elision counts", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(stderr).toContain("[perf-invariant-json-parse-stats]");
		expect(field(stderr, "candidates")).toBe(7);
		expect(field(stderr, "fills")).toBe(1);
		expect(field(stderr, "hits")).toBe(4);
		expect(field(stderr, "misses")).toBe(3);
		expect(field(stderr, "parse_calls_elided")).toBe(4);
	});
});
