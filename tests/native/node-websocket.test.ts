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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-websocket-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/node-websocket.mjs";
// The wss session trusts the fixture CA the way Node tests do, through the environment.
const TRUST_ENV = {
	NODE_EXTRA_CA_CERTS: path.resolve("tests/fixtures/tls/localhost-cert.pem"),
};

describe("global WebSocket client", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--no-deprecation", fixture], {
			env: { ...process.env, ...TRUST_ENV },
			encoding: "utf8",
		});
		compiled = buildNativeBinary({
			fixture,
			name: "node-websocket-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "node-websocket-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(compiled, { env: TRUST_ENV, timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node interpreted", () => {
		expect(runToStdout(interpreted, { env: TRUST_ENV, timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(
			runToStdout(compiled, { env: { ...STRESS_ENV, ...TRUST_ENV }, timeoutMs: 60000 }),
		).toBe(expected);
	});
});
