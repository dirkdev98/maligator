import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-error-stack-locked-"));
const config = resolveBuildConfig({
	engine: { primordials: "locked" },
	surface: { node: true },
});

describe("Node Error stack hooks with locked primordials", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/fixtures/express-5/error-stack-locked-smoke.cjs",
			name: "error-stack-locked-compiled",
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/fixtures/express-5/error-stack-locked-smoke.cjs",
			name: "error-stack-locked-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
	}, 1_200_000);

	it("loads pinned depd and http-errors compiled and interpreted", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("keeps the stack customization path rooted under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
