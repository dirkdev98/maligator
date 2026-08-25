import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/safepoint-contract.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-safepoint-contract-"));

describe("execution safepoint contract", () => {
	let expected: string;
	let compiledFromArtifact: string;
	const frontendEvents: Array<"hit" | "miss"> = [];

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		buildNativeBinary({
			fixture,
			name: "safepoint-contract-warm",
			compiled: true,
			outDir,
			onFrontendCacheEvent: ({ cache }) => frontendEvents.push(cache),
		});
		compiledFromArtifact = buildNativeBinary({
			fixture,
			name: "safepoint-contract-cached",
			compiled: true,
			outDir,
			onFrontendCacheEvent: ({ cache }) => frontendEvents.push(cache),
		});
	}, 600_000);

	it("survives calls, exceptional edges, and loop polls after artifact restore", () => {
		expect(frontendEvents.at(-1)).toBe("hit");
		expect(
			runToStdout(compiledFromArtifact, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});
});
