import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/transient-property-query.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-transient-property-query-"));

describe("transient property queries", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let retention: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "transient-property-query",
			outDir,
		}));
		retention = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "transient-property-query-retention",
			mainFile: "tests/fixtures/transient-property-query/main.c",
			outDir,
		});
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("preserves coercion, indices, symbols, and collecting proxy/getter behavior", () => {
		const env = { MAL_HOST_GC: "1" };
		expect(runToStdout(compiled, { env })).toBe(expected);
		expect(runToStdout(interpreted, { env })).toBe(expected);
	});

	it("roots coercion-created keys through verified GC stress", () => {
		const env = { ...STRESS_ENV, MAL_HOST_GC: "1" };
		expect(runToStdout(compiled, { env })).toBe(expected);
		expect(runToStdout(interpreted, { env })).toBe(expected);
	});

	it("releases flat and growing rope misses without growing permanent atoms or backing storage", () => {
		expect(runToStdout(retention, { env: { MAL_GC_VERIFY: "1" } })).toContain(
			"transient-property-query PASS\n",
		);
	});
});
