import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("preserves scalar Math coercion, errors and signed zeros through number guards", () => {
	const fixture = "tests/local/guarded-math-number.mjs";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-guarded-math-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "guarded-math-number",
			outDir,
			config: resolveBuildConfig({}),
		});
		expect(runToStdout(interpreted)).toBe(expected);
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);
