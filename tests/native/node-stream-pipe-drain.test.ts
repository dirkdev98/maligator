import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-stream-pipe-drain.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-stream-pipe-drain-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Readable pipe backpressure", () => {
	let binaries: { compiled: string; interpreted: string };
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "stream-pipe-drain",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("matches Node while draining buffered data with a pending producer read", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [binaries.compiled, binaries.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});
