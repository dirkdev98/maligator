import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/contained-array-stack.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-contained-array-stack-"));

describe("contained fresh Array stack operations", () => {
	let lockedCompiled: string;
	let lockedInterpreted: string;
	let mutableCompiled: string;

	beforeAll(() => {
		const locked = buildBackendPairFromOneProgramImage({
			fixture,
			name: "contained-array-stack-locked",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
		lockedCompiled = locked.compiled;
		lockedInterpreted = locked.interpreted;
		mutableCompiled = buildNativeBinary({
			fixture,
			name: "contained-array-stack-mutable",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
	}, 600_000);

	it("preserves locked compiled and interpreted behavior", () => {
		for (const binary of [lockedCompiled, lockedInterpreted]) {
			assertExactLines(runToStdout(binary), ["contained-array-stack PASS"]);
		}
	});

	it("keeps pushed object values live under GC stress", () => {
		assertExactLines(runToStdout(lockedCompiled, { env: STRESS_ENV }), [
			"contained-array-stack PASS",
		]);
	});

	it("retains mutable-world and escaping behavior", () => {
		assertExactLines(runToStdout(mutableCompiled), ["contained-array-stack PASS"]);
	});
});
