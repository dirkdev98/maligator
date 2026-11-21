import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BuildNativeBinaryResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-temporal-"));

describe("engine.temporal", () => {
	let enabled: BuildNativeBinaryResult;
	let disabled: BuildNativeBinaryResult;

	beforeAll(() => {
		enabled = buildNativeBinaryResult({
			fixture: "tests/local/temporal_duration.js",
			name: "temporal-enabled",
			mainFile: HOST_MAIN,
			outDir,
			temporalEnabled: true,
		});
		disabled = buildNativeBinaryResult({
			fixture: "tests/local/temporal_disabled.js",
			name: "temporal-disabled",
			mainFile: HOST_MAIN,
			outDir,
			temporalEnabled: false,
		});
	});

	it("links both policies against one C runtime archive", () => {
		expect(enabled.artifacts.c.runtime).toBe(disabled.artifacts.c.runtime);
	});

	it("runs Duration through temporal_rs", () => {
		assertResultPass(runToStdout(enabled.binaryPath));
	});

	it("finalizes Rust handles under GC stress", () => {
		assertResultPass(runToStdout(enabled.binaryPath, { env: STRESS_ENV }));
	});

	it("omits the Temporal global when disabled", () => {
		assertResultPass(runToStdout(disabled.binaryPath));
	});
});
