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
import type { BackendPairResult } from "../../src/test-harness.ts";

const fixture = "tests/local/mutable-primordial-sites.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-mutable-primordial-sites-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function oracle(mode: string): string {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, MUTABLE_SITE_CASE: mode },
	});
}

const listed: unknown = JSON.parse(oracle("list"));
if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === "string"))
	throw new Error("Expected a list of fixture cases");
const cases: Array<string> = listed;

describe.each([false, true])("mutable globals with realms=%s", (realms) => {
	let pair: BackendPairResult;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			outDir,
			name: `mutable-primordial-sites-${realms}`,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms },
				surface: { node: true },
			}),
		});
	});

	it.each(cases)("observes %s", (mode) => {
		const expected = oracle(mode);
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env: { MUTABLE_SITE_CASE: mode } })).toBe(expected);
			expect(
				runToStdout(binary, { env: { MUTABLE_SITE_CASE: mode, ...STRESS_ENV } }),
			).toBe(expected);
		}
	});
});
