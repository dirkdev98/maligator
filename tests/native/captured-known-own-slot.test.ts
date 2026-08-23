import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-captured-known-own-slot-"));
const fixture = "tests/local/captured-known-own-slot.js";
const expected = ["captured-known-own-slot PASS"];

describe("captured, aggregate, call, construct, and spread guarded own-slot accesses", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "captured-known-own-slot-compiled",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "captured-known-own-slot-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("preserves load/store, call/construct/spread relay, Proxy, and shape misses", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("preserves behavior under GC stress and verification", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
