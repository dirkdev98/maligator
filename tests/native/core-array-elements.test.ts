import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-array-elements-"));
const expected = ["core-array-elements PASS"];

describe("Core array element cells", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/core-array-elements.js",
				name: `core-array-elements-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
			}),
		);
	}, 600_000);

	it("preserves index aliases, holes, length, escape, and weak observation", () => {
		for (const binary of binaries) assertExactLines(runToStdout(binary), expected);
	});

	it("preserves them under GC stress", () => {
		for (const binary of binaries) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), expected);
		}
	});
});
