import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-realms-"));

describe("generic realm runtime API", () => {
	let bin: string;

	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/array-to-object.js",
			name: "realm",
			mainFile: "runtime/realm_test_main.c",
			outDir,
			realmsEnabled: true,
		});
	});

	it("isolates realm state and crosses call boundaries", () => {
		assertPassLine(runToStdout(bin), "realm");
	});

	it("survives MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(bin, { env: STRESS_ENV }), "realm");
	});
});
