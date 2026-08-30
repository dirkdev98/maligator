import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-cell-value-kinds.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-exact-cell-value-kinds-"));

describe("exact Int32 and String cell value kinds", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "exact-cell-value-kinds",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		}));
	}, 600_000);

	it("preserves mutable Int32, widening, negative zero, String, and direct calls", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps typed String roots live at every GC mode", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
		expect(runToStdout(interpreted, { env: STRESS_ENV })).toBe(expected);
	});
});
