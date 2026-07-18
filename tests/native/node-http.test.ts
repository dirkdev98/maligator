import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-"));
const reverseEnv = { MAL_NODE_INSTALL_REVERSE: "1" };

describe("node:http initialization floor", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [
			buildNativeBinary({
				fixture: "tests/local/node-http.mjs",
				name: "node-http-esm-compiled",
				mainFile: "tests/native/node_http_main.c",
				outDir,
				nodeEnabled: true,
			}),
			buildNativeBinary({
				fixture: "tests/local/node-http.mjs",
				name: "node-http-esm-interpreted",
				mainFile: "tests/native/node_http_main.c",
				outDir,
				nodeEnabled: true,
				compiled: false,
			}),
			buildNativeBinary({
				fixture: "tests/local/node-http.cjs",
				name: "node-http-cjs-compiled",
				mainFile: "tests/native/node_http_main.c",
				outDir,
				nodeEnabled: true,
			}),
			buildNativeBinary({
				fixture: "tests/local/node-http.cjs",
				name: "node-http-cjs-interpreted",
				mainFile: "tests/native/node_http_main.c",
				outDir,
				nodeEnabled: true,
				compiled: false,
			}),
		];
	});

	it("passes compiled and interpreted ESM/CommonJS", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("preserves identities with reverse fragmented installation", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: reverseEnv }));
		}
	});

	it("passes normal and reverse installation under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
			assertResultPass(runToStdout(binary, { env: { ...STRESS_ENV, ...reverseEnv } }));
		}
	});
});
