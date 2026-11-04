import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-child-process-lifecycle.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-child-lifecycle-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "node-child-process-lifecycle",
		outDir,
		config: resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false },
		}),
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each([
	["waits for the actual exit after both output streams end", "early-eof"],
	["keeps the child alive while a data listener destroys both output streams", "destroy"],
])("%s", (_name, mode) => {
	const env = { MAL_CHILD_STDIO_CASE: mode };
	const expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	for (const binary of [pair.compiled, pair.interpreted])
		expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1", ...env } })).toBe(expected);
});
