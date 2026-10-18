import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["native-inherited-setters PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-inherited-setters-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function setterHits(stderr: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
	return Number(line?.match(/(?:^|\s)store_inherited_setter_hits=([0-9]+)/)?.[1] ?? -1);
}

describe("native inherited setter stores", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-inherited-setters.js",
			name: "native-inherited-setters",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	}, 600_000);

	it("calls a cached inherited setter from a store site", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		expect(setterHits(result.stderr)).toBeGreaterThan(0);
	});

	it("drops the cached setter when the chain or receiver changes under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
