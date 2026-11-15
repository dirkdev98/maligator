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

const fixture = "tests/local/eval-import-bindings/main.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-imports-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("live imports in direct eval", () => {
	let binaries: { compiled: string; interpreted: string };
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "eval-imports",
			outDir,
			config: resolveBuildConfig({ engine: { eval: true }, surface: { node: true } }),
		});
	});
	it("observes exporter changes and retains import binding semantics", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [binaries.compiled, binaries.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});
