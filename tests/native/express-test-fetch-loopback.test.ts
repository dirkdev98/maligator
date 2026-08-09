import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-express-test-fetch-"));

describe("maligator:test fetch against local Express", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/express-test-fetch-loopback.mjs",
				name: `express-test-fetch-${compiled ? "compiled" : "interpreted"}`,
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	}, 300_000);

	it("reads a JSON response body in compiled and interpreted builds", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary).trim()).toBe("EXPRESS TEST FETCH LOOPBACK PASS");
		}
	});
});
