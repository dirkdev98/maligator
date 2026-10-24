import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-split-response-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("node:http responses ended after an acknowledged write", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-http-split-response.cjs",
				name: compiled
					? "node-http-split-response-compiled"
					: "node-http-split-response-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	});

	it("finishes every keep-alive response in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toContain("HTTP SPLIT RESPONSE PASS");
		}
	});

	it("finishes every keep-alive response under GC stress in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
				"HTTP SPLIT RESPONSE PASS",
			);
		}
	});
});
