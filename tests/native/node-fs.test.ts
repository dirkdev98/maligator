import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-fs-"));

describe("node:fs POSIX surface", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-fs.mts",
			name: "node-fs-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-fs.mts",
			name: "node-fs-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("supports files, stats, descriptors, directory entries, path validation, and errno errors", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("keeps filesystem results alive under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
