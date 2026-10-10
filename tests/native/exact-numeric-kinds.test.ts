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

it("keeps Number accumulators exact when operands coerce, concatenate or throw", () => {
	const fixture = "tests/local/exact-numeric-kinds.mjs";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-numeric-kinds-"));
	try {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-numeric-kinds",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		expect(runToStdout(interpreted)).toBe(expected);
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);
