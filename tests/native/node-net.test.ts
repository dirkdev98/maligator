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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-net-"));

describe("node:net Socket", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-net-socket.cjs",
				name: compiled ? "node-net-compiled" : "node-net-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	});

	it("round-trips data and reports terminal lifecycles in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toContain("NODE NET PASS");
		}
	});

	it("keeps sockets and callbacks rooted under GC stress in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain("NODE NET PASS");
		}
	});
});
