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

describe("node:fs synchronous POSIX surface", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-fs.mts",
			name: "node-fs",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true,
			nodeEnabled: true,
		});
	});

	it("supports files, stats, directory entries, path validation, and errno errors", () => {
		assertResultPass(runToStdout(bin));
	});

	it("keeps filesystem results alive under GC stress", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
