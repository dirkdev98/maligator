import { execFileSync } from "node:child_process";
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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-net-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("node:net Socket", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-net-socket.cjs",
				name: compiled ? "node-net-compiled" : "node-net-interpreted",
				mainFile: HOST_MAIN,
				outDir,
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

it("notifies on idle sockets and rearms on activity without keeping the process alive", () => {
	const fixture = "tests/local/node-net-timeout.mjs";
	const reference = execFileSync(process.execPath, [fixture], {
		encoding: "utf-8",
		timeout: 10_000,
	});
	for (const compiled of [true, false]) {
		const binary = buildNativeBinary({
			fixture,
			name: compiled ? "node-net-timeout-compiled" : "node-net-timeout-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			compiled,
		});
		for (const env of [{}, STRESS_ENV])
			expect(runToStdout(binary, { env, timeoutMs: 15_000 })).toBe(reference);
	}
}, 120_000);
