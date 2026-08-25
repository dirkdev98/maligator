import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/allocation-sinking.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-allocation-sinking-"));

describe("fresh allocation sinking", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "allocation-sinking",
			config: resolveBuildConfig({}),
			outDir,
		}));
	}, 600_000);

	it("preserves retained identities through both backends and GC stress", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(
				runToStdout(binary, {
					env: { MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60_000,
				}),
			).toBe(expected);
		}
	});
});
