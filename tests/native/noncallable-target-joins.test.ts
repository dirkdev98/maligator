import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/noncallable-target-joins.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-noncallable-target-joins-"));

describe("finite function targets with non-callable alternatives", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "noncallable-target-joins",
			outDir,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			webPlatformEnabled: false,
		}));
	}, 600_000);

	it("preserves TypeError, TDZ, argument effects, and the callable branch", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps the selected callee and arguments live across guarded calls under GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
		expect(runToStdout(interpreted, { env: STRESS_ENV })).toBe(expected);
	});
});
