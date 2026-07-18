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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-listen-"));

describe("node:http server lifecycle", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [
			buildNativeBinary({
				fixture: "tests/local/node-http-listen.cjs",
				name: "node-http-listen-compiled",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
			}),
			buildNativeBinary({
				fixture: "tests/local/node-http-listen.cjs",
				name: "node-http-listen-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled: false,
			}),
		];
	});

	it("listens and closes in lifecycle order in compiled and interpreted modes", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("keeps active servers rooted under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
