import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-dgram-segments.mjs";
const directory = mkdtempSync(path.join(os.tmpdir(), "mal-dgram-segments-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "node-dgram-segments",
		outDir: directory,
		config: resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false },
		}),
	});
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each([
	["sends buffer lists beyond the former segment ceiling", "many", 65],
	["coalesces buffer lists beyond OS vector limits", "many", 2048],
	["retains temporary views returned by buffer-list getters", "getters", 0],
	["observes an earlier buffer detached by a later getter", "detach", 0],
	["keeps normalized view lengths fixed when a later getter grows the buffer", "grow", 0],
	["resolves earlier views after a later getter shrinks their buffer", "resize", 0],
	["reports an unbound socket closed by a buffer-list getter", "close", 0],
	["runs buffer-list getters once when named bind queues the send", "queued", 0],
] as const)("%s", (_name, mode, count) => {
	const env = { MAL_DGRAM_CASE: mode, MAL_DGRAM_SEGMENTS: String(count) };
	const expected = "datagram segments PASS\n";
	if (count !== 2048)
		expect(
			execFileSync(process.execPath, [fixture], {
				env: { ...process.env, ...env },
				encoding: "utf8",
				timeout: 10_000,
			}),
		).toBe(expected);
	for (const binary of [pair.compiled, pair.interpreted])
		expect(
			runToStdout(binary, { env: { ...STRESS_ENV, ...env }, timeoutMs: 15_000 }),
		).toBe(expected);
});
