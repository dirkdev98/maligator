import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/mapped-callback-guards.mjs";

describe("guarded mapped element calls", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-mapped-callback-guards-"));
	let binaries: Array<string>;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "mapped-callback-guards",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms: true, eval: true },
				surface: { node: true, webPlatform: true },
			}),
		});
		binaries = [pair.compiled, pair.interpreted];
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	const scenarios = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, MAPPED_GUARD_CASE: "list" },
	})
		.trim()
		.split("\n");
	it.each(scenarios)("preserves %s in a fresh VM", (scenario) => {
		const env = { MAPPED_GUARD_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of binaries) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
		}
	});
});
