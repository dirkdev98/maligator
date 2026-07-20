import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-host-"));

// setTimeout/clearTimeout + promises driven by the host event loop; the exact
// interleaving is the assertion. STRESS proves pending timer callbacks stay rooted.
const EXPECTED = [
	"start",
	"end",
	"microtask-1",
	"t:0",
	"t:equal-1",
	"t:equal-2",
	"t:cancel-ready",
	"t:args x y",
	"t:50 schedules another",
	"t:50 microtask",
	"t:100",
	"t:nested",
];

describe("host event loop (setTimeout ordering)", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/host_settimeout.js",
			name: "hosttest",
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("emits the expected sequence compiled", () => {
		assertExactLines(runToStdout(bin), EXPECTED);
	});

	it("emits the expected sequence under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertExactLines(runToStdout(bin, { env: STRESS_ENV }), EXPECTED);
	});
});
