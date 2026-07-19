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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-express-smoke-"));
const success = "Express 5 fixture smoke check passed";

describe("Express 5 fixture smoke runner", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/fixtures/express-5/smoke.js",
			name: "express-smoke-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/fixtures/express-5/smoke.js",
			name: "express-smoke-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	}, 1_200_000);

	function run(binary: string, env: NodeJS.ProcessEnv = {}): void {
		expect(runToStdout(binary, { env, timeoutMs: 30_000 }).trim()).toBe(success);
	}

	it("passes unchanged in compiled mode", () => {
		run(compiled);
	});

	it("passes unchanged in interpreted mode", () => {
		run(interpreted);
	});

	it("keeps the compiled server and client rooted under GC stress", () => {
		run(compiled, STRESS_ENV);
	});

	it("keeps the interpreted server and client rooted under GC stress", () => {
		run(interpreted, STRESS_ENV);
	});
});
