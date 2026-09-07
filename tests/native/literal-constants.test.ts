import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/literal-constants.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-literal-constants-"));
describe("private literal constants", () => {
	let compiled: string, interpreted: string;
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "literal-constants",
			config: resolveBuildConfig({}),
			outDir,
		}));
	}, 600_000);
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	it("preserves values, mutation, identity, coercion and reentrant calls on both backends", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	});
});
