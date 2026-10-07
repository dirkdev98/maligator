import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-resumable-transport.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-resumable-transport-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("selected native transports across coroutine suspension", () => {
	let compiled: string, interpreted: string, expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-resumable-transport",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			mainFile: HOST_MAIN,
		});
		({ compiled, interpreted } = pair);
		const callers = pair.programImage.native.functions.filter(
			(native) =>
				native.mode === "resumable" && native.storage!.callbackTransports.length > 0,
		);
		expect(callers).toHaveLength(2);
		for (const caller of callers)
			expect(caller.storage!.callTransports.length).toBeGreaterThan(0);
	}, 600_000);
	it("preserves typed calls, callback misses, snapshots, collecting accessors and resumed throws", () => {
		for (const binary of [compiled, interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binary, {
						env: { MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
	});
});
