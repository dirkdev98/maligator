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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-client-"));

describe("node:http outbound client", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-http-client-loopback.cjs",
				name: compiled ? "node-http-client-compiled" : "node-http-client-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	});

	it("round-trips buffered requests and responses in compiled and interpreted modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toContain("HTTP CLIENT LOOPBACK PASS");
		}
	});

	it("keeps client state rooted under GC stress in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
				"HTTP CLIENT LOOPBACK PASS",
			);
		}
	});
});
