import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-captured-known-own-slot-"));
const fixture = "tests/local/captured-known-own-slot.js";
const expected = ["captured-known-own-slot PASS"];
const config = resolveBuildConfig({ engine: { primordials: "locked" } });

describe("captured, aggregate, call, construct, spread, and method shape accesses", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "captured-known-own-slot",
			outDir,
			config,
		}));
	}, 600_000);

	it("preserves relays, object methods, Proxy traps, and shape misses", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("preserves behavior under GC stress and verification", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
