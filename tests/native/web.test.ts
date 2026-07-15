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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-"));

// Host-entry fixtures that self-report a "RESULT N/N" line (no "FAIL:" lines) —
// the WinterTC Min-Common-API surface + structured clone / Headers / Response /
// Request. Each runs plain and under collect-at-every-safepoint.
const FIXTURES = [
	{ name: "web globals", fixture: "tests/local/web_globals.js" },
	{ name: "structuredClone", fixture: "tests/local/structured_clone.js" },
	{ name: "Headers iteration", fixture: "tests/local/headers_iter.js" },
	{ name: "Response read methods", fixture: "tests/local/response_read.js" },
	{ name: "Request constructor", fixture: "tests/local/request_ctor.js" },
	{ name: "Event / EventTarget", fixture: "tests/local/events.js" },
];

describe.each(FIXTURES)("$name", ({ name, fixture }) => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture,
			name: `webtest-${name.replace(/\W+/g, "-")}`,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(bin));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
