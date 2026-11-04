import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-child-process-fd-stdio.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-child-fd-stdio-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "node-child-process-fd-stdio",
		outDir,
		config: resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false },
		}),
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each([
	["passes file descriptors to synchronous children and keeps them open", "sync"],
	["passes file descriptors to asynchronous children and keeps them open", "async"],
	["shares the output position when both child streams use one descriptor", "shared"],
	["coerces numeric descriptors as Node does", "fractional"],
	["reports a closed descriptor before allocating internal pipes", "closed"],
	["crosses standard output descriptors for synchronous children", "crossed-sync"],
	["crosses standard output descriptors for asynchronous children", "crossed-async"],
])("%s", (_name, mode) => {
	const env = {
		...process.env,
		MAL_FD_CHILD_NODE: process.execPath,
		MAL_FD_STDIO_CASE: mode,
		MAL_GC_VERIFY: "1",
	};
	const expected =
		mode === "closed"
			? { status: 0, stdout: '[null,null,null,null,"EBADF"]\n', stderr: "" }
			: spawnSync(process.execPath, [fixture], { env, encoding: "utf8" });
	expect(expected.status, expected.stderr).toBe(0);
	for (const binary of [pair.compiled, pair.interpreted]) {
		const invocation = resolveHarnessExecutionInvocation(binary);
		const actual = spawnSync(invocation.executable, invocation.args, {
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(actual.status, actual.stderr).toBe(0);
		expect(actual.stdout).toBe(expected.stdout);
		expect(actual.stderr).toBe(expected.stderr);
	}
});
