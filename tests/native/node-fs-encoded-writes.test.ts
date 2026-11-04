import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-fs-encoded-writes.mjs";
const directory = mkdtempSync(join(tmpdir(), "mal-encoded-writes-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "encoded-writes",
		outDir: directory,
		config: resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false },
		}),
	});
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each([
	"utf8",
	"utf16le",
	"latin1",
	"ascii",
	"hex",
	"oddhex",
	"base64",
	"base64url",
	"empty",
])("writes and appends the exact decoded bytes for %s", (mode) => {
	const env = { MAL_FS_ENCODING_CASE: mode };
	const expected = execFileSync(process.execPath, [fixture], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 10_000,
	});
	for (const binary of [pair.compiled, pair.interpreted])
		expect(runToStdout(binary, { env: { ...STRESS_ENV, ...env } })).toBe(expected);
});

it("admits a large encoded input whose decoded allocation is small", () => {
	for (const binary of [pair.compiled, pair.interpreted])
		expect(
			runToStdout(binary, { env: { ...STRESS_ENV, MAL_FS_ENCODING_CASE: "large" } }),
		).toBe("encoded writes PASS\n");
});
