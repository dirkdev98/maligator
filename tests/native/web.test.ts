import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
	{ name: "web globals", fixture: "tests/local/web_globals.js", interpreted: true },
	{
		name: "structuredClone",
		fixture: "tests/local/structured_clone.js",
		interpreted: true,
	},
	{
		name: "Headers iteration",
		fixture: "tests/local/headers_iter.js",
		interpreted: true,
	},
	{
		name: "Response read methods",
		fixture: "tests/local/response_read.js",
		interpreted: false,
	},
	{
		name: "Request constructor",
		fixture: "tests/local/request_ctor.js",
		interpreted: false,
	},
	{ name: "Event / EventTarget", fixture: "tests/local/events.js", interpreted: false },
];

describe.each(FIXTURES)("$name", ({ name, fixture, interpreted }) => {
	let bin: string;
	let interpretedBin: string | undefined;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture,
			name: `webtest-${name.replace(/\W+/g, "-")}`,
			mainFile: HOST_MAIN,
			outDir,
		});
		if (interpreted) {
			interpretedBin = buildNativeBinary({
				fixture,
				name: `webtest-${name.replace(/\W+/g, "-")}-interpreted`,
				compiled: false,
				mainFile: HOST_MAIN,
				outDir,
			});
		}
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(bin));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});

	it.runIf(interpreted)("passes interpreted", () => {
		assertResultPass(runToStdout(interpretedBin!));
	});

	it.runIf(interpreted)("passes interpreted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(interpretedBin!, { env: STRESS_ENV }));
	});

	// The web globals fixture logs a non-ASCII sentinel; console string output must
	// be valid UTF-8 (accented BMP, euro, and a supplementary emoji), not \u escapes.
	it.runIf(name === "web globals")("emits console strings as UTF-8", () => {
		const raw = execFileSync(bin, { encoding: "buffer", timeout: 20000 });
		const sentinel = Buffer.from([
			0x53,
			0x45,
			0x4e,
			0x54,
			0x49,
			0x4e,
			0x45,
			0x4c,
			0x20, // "SENTINEL "
			0xc3,
			0xa9, // é  U+00E9
			0xe2,
			0x82,
			0xac, // €  U+20AC
			0xf0,
			0x9f,
			0x98,
			0x80, // 😀 U+1F600
			0x0a, // "\n"
		]);
		expect(raw.includes(sentinel)).toBe(true);
	});
});
