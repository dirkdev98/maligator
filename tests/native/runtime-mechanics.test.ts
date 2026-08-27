import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-runtime-mechanics-"));

describe("shared runtime mechanics", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/runtime-mechanics.mjs",
			name: "runtime-mechanics",
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		binaries = [pair.compiled, pair.interpreted];
	}, 600_000);

	it("preserves key, accessor, and Node export behavior", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("keeps accessor functions alive under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
