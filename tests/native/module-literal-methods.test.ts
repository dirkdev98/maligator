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

const fixture = "tests/local/module-literal-methods.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-module-literal-methods-"));

describe("methods of module-scope object literals", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "module-literal-methods",
			outDir,
		}));
	}, 600_000);

	it("dispatches replaced methods and objects like Node in both backends", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps that dispatch under GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});
});
