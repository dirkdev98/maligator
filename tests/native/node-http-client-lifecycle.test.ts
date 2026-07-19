import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-client-lifecycle-"));

describe("node:http ClientRequest lifecycle", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-http-client-lifecycle.cjs",
				name: compiled
					? "node-http-client-lifecycle-compiled"
					: "node-http-client-lifecycle-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	});

	it("cancels requests and emits each terminal lifecycle once in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toContain("HTTP CLIENT LIFECYCLE PASS");
		}
	});

	it("keeps cancellation state rooted under GC stress in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
				"HTTP CLIENT LIFECYCLE PASS",
			);
		}
	});
});
