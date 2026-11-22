import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

it("calls a class method made enumerable through a computed descriptor key", () => {
	const fixture = "tests/local/computed-method-descriptor.mjs";
	const env = { ...process.env, METHOD_KEY: "identify" };
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8", env });
	const outDir = mkdtempSync(join(tmpdir(), "mal-computed-method-descriptor-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "computed-method-descriptor",
			config: resolveBuildConfig({}),
			outDir,
		});
		expect(runToStdout(pair.compiled, { env })).toBe(expected);
		expect(runToStdout(pair.interpreted, { env })).toBe(expected);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
