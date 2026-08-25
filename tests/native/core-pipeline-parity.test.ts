import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const fixture = "tests/local/core-pipeline-parity.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-pipeline-parity-"));

function configFor(primordials: "mutable" | "locked") {
	return resolveBuildConfig({
		engine: {
			primordials,
			eval: true,
			realms: true,
			regexp: true,
			temporal: true,
			intl: { enabled: true },
		},
		surface: { webPlatform: true },
	});
}

const scenario =
	'{"order":"enter>resumed>catch>catch-resumed>finally>finally-resumed>after",' +
	'"ledger":"core-parity:130:1,4,9,16,100","witness":1,"checksum":185214';
const mutableLine = `${scenario},"primordial":"mutable:installed-and-restored"}`;
const lockedLine = `${scenario},"primordial":"locked:TypeError"}`;

function stdoutLine(
	binary: string,
	options: Parameters<typeof runToStdout>[1] = {},
): string {
	return runToStdout(binary, options).trim();
}

describe("optimized Core through compiled and interpreted lowering", () => {
	let mutable: BackendPairResult;
	let locked: BackendPairResult;

	beforeAll(() => {
		// One optimized program image per world feeds both backends, so a mismatch below
		// is an emission difference and cannot be a second frontend/optimizer run.
		mutable = buildBackendPairFromOneProgramImage({
			fixture,
			name: "core-pipeline-parity-mutable",
			mainFile: HOST_MAIN,
			outDir,
			config: configFor("mutable"),
		});
		locked = buildBackendPairFromOneProgramImage({
			fixture,
			name: "core-pipeline-parity-locked",
			mainFile: HOST_MAIN,
			outDir,
			config: configFor("locked"),
		});
	}, 600_000);

	it("agrees in the mutable world", () => {
		expect(stdoutLine(mutable.compiled)).toBe(mutableLine);
		expect(stdoutLine(mutable.interpreted)).toBe(mutableLine);
	}, 120_000);

	it("agrees in the locked world", () => {
		expect(stdoutLine(locked.compiled)).toBe(lockedLine);
		expect(stdoutLine(locked.interpreted)).toBe(lockedLine);
	}, 120_000);

	it("agrees under GC stress", () => {
		const stressed = { env: STRESS_ENV, timeoutMs: 60_000 };
		expect(stdoutLine(mutable.compiled, stressed)).toBe(mutableLine);
		expect(stdoutLine(mutable.interpreted, stressed)).toBe(mutableLine);
		expect(stdoutLine(locked.compiled, stressed)).toBe(lockedLine);
		expect(stdoutLine(locked.interpreted, stressed)).toBe(lockedLine);
	}, 120_000);
});
